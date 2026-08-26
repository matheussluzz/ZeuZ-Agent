import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { ZeuzController } from './controller.js';
import { sanitizedChildEnvironment, installRoot } from './env.js';
import { systemRuntime, runtimeWorkspaceSnapshot, type RuntimeSeams } from './runtime.js';
import { SessionStore } from './session-store.js';
import { stateDirectory } from './state-root.js';
import { TaskResultStore, validateArtifact } from './task-result-store.js';
import { TaskScheduler } from './task-scheduler.js';
import { DEFAULT_LEASE_POLICY, dependencyReadiness, reclaimDecision, retryDelayMs, validateLeasePolicy, type OwnerProbeState } from './task-policy.js';
import { TaskStore, taskErrorCode, type CreateTaskInput } from './task-store.js';
import { isPantheonPersonaId, isRootOrchestrator, parseCapabilityRequests, routeCapabilityRequest, type CapabilityRoutingDecision, type SpecialistCapabilityRequest } from './specialists.js';
import { TaskCapabilityStore, type TaskCapabilityRecord, TaskMessageStore, type TaskMessageRecord, type TaskMessageDelivery } from './task-messages.js';
import type { DurableTaskRecord, TaskArtifact, TaskSpecialistMetadata } from './task-schema.js';
import type { PermissionMode, TurnOutcome } from './types.js';
import { classifyWorkspaceChange } from './workspace.js';
import { WorktreeManager, sanitizedGitRunner } from './worktree-manager.js';
import { WorkspaceLockStore } from './workspace-lock-store.js';

export interface TaskExecutor {
  execute(task: DurableTaskRecord, cwd: string, signal: AbortSignal): Promise<TurnOutcome>;
  supportsLiveInput?(task: DurableTaskRecord): boolean | Promise<boolean>;
  sendLiveInput?(task: DurableTaskRecord, content: string, signal: AbortSignal): Promise<void>;
}

export interface WorkerLauncher {
  launch(taskId: string): Promise<boolean>;
}

export interface TaskEngineOptions {
  root?: string;
  runtime?: RuntimeSeams;
  store?: TaskStore;
  scheduler?: TaskScheduler;
  results?: TaskResultStore;
  executor?: TaskExecutor;
  messages?: TaskMessageStore;
  capabilities?: TaskCapabilityStore;
  launcher?: WorkerLauncher;
  heartbeatMs?: number;
  leaseMs?: number;
  ownerProbe?: (hostId: string, pid: number) => OwnerProbeState;
  rootOrchestrator?: boolean;
}

export interface CapabilitySiblingInput {
  modelId?: string;
  prompt?: string;
  cwd?: string;
  mode?: PermissionMode;
}

export class TaskEngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'TaskEngineError'; this.code = code; }
}

interface PreparedWorkspace {
  record: Pick<DurableTaskRecord, 'executionWorkspace' | 'repositoryIdentity' | 'baseCommit'>;
  release?: () => Promise<void>;
  heartbeat?: () => Promise<void>;
}

class ControllerTaskExecutor implements TaskExecutor {
  async execute(task: DurableTaskRecord, cwd: string, signal: AbortSignal): Promise<TurnOutcome> {
    const controller = await ZeuzController.create(cwd, { modelId: task.modelId, mode: task.mode });
    const skillContext = task.specialist
      ? await controller.specialistSkillContext(task.specialist.personaId, task.prompt)
      : undefined;
    return await controller.ask(task.modelId, task.prompt, undefined, task.mode, signal, skillContext);
  }
}

const MAX_FOLLOW_UP_CONTEXT_BYTES = 256 * 1024;

function appendQueuedFollowUps(prompt: string, messages: readonly TaskMessageRecord[]): string {
  if (messages.length === 0) return prompt;
  const section = [
    '',
    '<queued_task_follow_ups>',
    'These are user follow-up messages received after task creation. Treat them as additional task input, subject to the ZeuZ contract and permission mode.',
    ...messages.map((message) => `<follow_up id="${message.id}">\n${message.content}\n</follow_up>`),
    '</queued_task_follow_ups>',
  ].join('\n');
  if (Buffer.byteLength(prompt + section, 'utf8') > MAX_FOLLOW_UP_CONTEXT_BYTES + Buffer.byteLength(prompt, 'utf8')) {
    throw new TaskEngineError('TASK_MESSAGE_CONTEXT_TOO_LARGE', 'Queued task follow-ups exceed the bounded execution context.');
  }
  return `${prompt}${section}`;
}

function appendSpecialistExecutionContext(task: DurableTaskRecord): string {
  if (!task.specialist) return task.prompt;
  return `${task.prompt}\n\n<specialist_execution_context>\nrequesterTaskId=${task.id}\nrootCorrelationId=${task.rootCorrelationId}\npersonaId=${task.specialist.personaId}\n</specialist_execution_context>`;
}

export class DetachedWorkerLauncher implements WorkerLauncher {
  constructor(private readonly root: string) {}

  async launch(taskId: string): Promise<boolean> {
    const cli = resolve(installRoot(), 'dist', 'src', 'cli.js');
    const child = spawn(process.execPath, [cli, 'task', 'worker', taskId], {
      cwd: installRoot(),
      detached: true,
      stdio: 'ignore',
      env: sanitizedChildEnvironment({ ZEUZ_STATE_DIR: this.root, ZEUZ_INTERNAL_WORKER: '1' }),
    });
    const event = await new Promise<'spawn' | 'error'>((resolvePromise) => {
      const onSpawn = (): void => { child.off('error', onError); resolvePromise('spawn'); };
      const onError = (): void => { child.off('spawn', onSpawn); resolvePromise('error'); };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    if (event === 'spawn') child.unref();
    return event === 'spawn';
  }
}

export class TaskEngine {
  private readonly root: string;
  private readonly runtime: RuntimeSeams;
  private readonly store: TaskStore;
  private readonly scheduler: TaskScheduler;
  private readonly results: TaskResultStore;
  private readonly executor: TaskExecutor;
  private readonly messages: TaskMessageStore;
  private readonly capabilities: TaskCapabilityStore;
  private readonly launcher: WorkerLauncher;
  private readonly heartbeatMs: number;
  private readonly leaseMs: number;
  private readonly ownerProbe: (hostId: string, pid: number) => OwnerProbeState;
  private readonly rootOrchestrator: boolean;

  constructor(options: TaskEngineOptions = {}) {
    this.root = resolve(options.root ?? stateDirectory());
    this.runtime = options.runtime ?? systemRuntime;
    const policy = validateLeasePolicy({ heartbeatMs: options.heartbeatMs ?? DEFAULT_LEASE_POLICY.heartbeatMs, leaseMs: options.leaseMs ?? DEFAULT_LEASE_POLICY.leaseMs, maxWorkers: 3 });
    this.heartbeatMs = policy.heartbeatMs;
    this.leaseMs = policy.leaseMs;
    this.ownerProbe = options.ownerProbe ?? probeOwner;
    this.store = options.store ?? new TaskStore({ root: this.root, runtime: this.runtime });
    this.scheduler = options.scheduler ?? new TaskScheduler(this.root, this.runtime);
    this.results = options.results ?? new TaskResultStore({ root: this.root, now: () => this.runtime.now() });
    this.executor = options.executor ?? new ControllerTaskExecutor();
    this.messages = options.messages ?? new TaskMessageStore({ root: this.root, runtime: this.runtime });
    this.capabilities = options.capabilities ?? new TaskCapabilityStore({ root: this.root, runtime: this.runtime });
    this.launcher = options.launcher ?? new DetachedWorkerLauncher(this.root);
    this.rootOrchestrator = isRootOrchestrator() && (options.rootOrchestrator ?? true);
  }

  async submit(input: CreateTaskInput): Promise<{ task: DurableTaskRecord; launched: boolean }> {
    if (input.specialist && !this.rootOrchestrator) throw new TaskEngineError('SPECIALIST_SPAWN_DENIED', 'Only the root ZeuZ orchestrator may spawn specialist tasks.');
    if (input.specialist && (!isPantheonPersonaId(input.specialist.personaId) || input.specialist.execution !== 'spawn')) throw new TaskEngineError('SPECIALIST_METADATA_INVALID', 'Specialist task metadata must describe a built-in Pantheon spawn.');
    const task = await this.store.create(input);
    let launched = false;
    try { launched = await this.launcher.launch(task.id); } catch { launched = false; }
    return { task, launched };
  }

  async submitSpecialist(input: CreateTaskInput & { specialist: TaskSpecialistMetadata }): Promise<{ task: DurableTaskRecord; launched: boolean }> {
    if (!this.rootOrchestrator) throw new TaskEngineError('SPECIALIST_SPAWN_DENIED', 'Only the root ZeuZ orchestrator may spawn specialist tasks.');
    if (input.specialist.execution !== 'spawn') throw new TaskEngineError('SPECIALIST_EXECUTION_INVALID', 'Specialist task submission requires durable spawn execution.');
    if (!isPantheonPersonaId(input.specialist.personaId)) throw new TaskEngineError('SPECIALIST_PERSONA_INVALID', 'Specialist tasks must use a built-in Pantheon persona.');
    return await this.submit(input);
  }

  async listMessages(idOrPrefix: string): Promise<TaskMessageRecord[]> {
    const task = await this.store.load(idOrPrefix);
    return await this.messages.list(task.id);
  }

  async listCapabilityRequests(rootCorrelationId?: string): Promise<TaskCapabilityRecord[]> {
    return await this.capabilities.list(rootCorrelationId);
  }

  routeCapability(request: SpecialistCapabilityRequest): CapabilityRoutingDecision {
    return routeCapabilityRequest(request, this.rootOrchestrator);
  }

  async approveCapabilityRequest(idOrPrefix: string, input: CapabilitySiblingInput = {}): Promise<{ record: TaskCapabilityRecord; decision: CapabilityRoutingDecision; task?: DurableTaskRecord; launched?: boolean }> {
    if (!this.rootOrchestrator) throw new TaskEngineError('ROOT_REQUIRED', 'Only the root ZeuZ orchestrator may approve capability requests.');
    const claim = await this.capabilities.claimApproval(idOrPrefix);
    if (!claim.claimed) {
      if (claim.record.status === 'spawned' && claim.record.siblingTaskId) {
        return { record: claim.record, decision: { action: 'spawn-sibling', code: 'SIBLING_SPAWN_AVAILABLE', request: claim.record.request! }, task: await this.store.load(claim.record.siblingTaskId), launched: false };
      }
      throw new TaskEngineError('CAPABILITY_APPROVAL_IN_PROGRESS', 'Another root orchestrator is already approving this capability request.');
    }
    const request = claim.record.request!;
    const decision = routeCapabilityRequest(request, true);
    if (decision.code !== 'SIBLING_SPAWN_AVAILABLE') {
      await this.capabilities.markFailed(claim.record.id, claim.record.approvalToken!, decision.code).catch(() => undefined);
      throw new TaskEngineError(decision.code, 'Capability request is not eligible for sibling spawn.');
    }
    const requester = await this.store.load(request.requesterTaskId);
    const sibling: CreateTaskInput = {
      ...(requester.parentTaskId ? { parentTaskId: requester.parentTaskId } : {}),
      ...(requester.parentSessionId ? { parentSessionId: requester.parentSessionId } : {}),
      rootCorrelationId: request.rootCorrelationId,
      modelId: input.modelId ?? requester.modelId,
      prompt: input.prompt ?? `Root-approved capability ${request.capability}: ${request.reason}`,
      cwd: input.cwd ?? requester.requestedWorkspace,
      mode: input.mode ?? requester.mode,
    };
    try {
      const submitted = await this.submit(sibling);
      const record = await this.capabilities.markSpawned(claim.record.id, claim.record.approvalToken!, submitted.task.id);
      return { record, decision, task: submitted.task, launched: submitted.launched };
    } catch (error) {
      await this.capabilities.markFailed(claim.record.id, claim.record.approvalToken!, error instanceof Error ? error.message : String(error)).catch(() => undefined);
      throw error;
    }
  }

  async queueFollowUp(idOrPrefix: string, content: string, signal?: AbortSignal): Promise<{ taskId: string; message: TaskMessageRecord; delivery: TaskMessageDelivery; reason?: string }> {
    const task = await this.store.load(idOrPrefix);
    if (['completed', 'failed', 'cancelled', 'blocked'].includes(task.status)) throw new TaskEngineError('TASK_TERMINAL_MESSAGE_DENIED', 'Terminal tasks cannot receive follow-up messages.');
    const message = await this.messages.enqueue({ taskId: task.id, rootCorrelationId: task.rootCorrelationId, content });
    if (task.status !== 'running' || !this.executor.supportsLiveInput || !this.executor.sendLiveInput) {
      return { taskId: task.id, message, delivery: 'queued', reason: 'Executor does not expose native live input; message remains queued for the next task turn.' };
    }

    let supported = false;
    try { supported = await this.executor.supportsLiveInput(task); }
    catch { supported = false; }
    if (!supported) return { taskId: task.id, message, delivery: 'queued', reason: 'Executor reported native live input unavailable; message remains queued for the next task turn.' };

    const claimToken = randomUUID();
    const claimed = await this.messages.claimForExecution(task.id, claimToken, 1);
    const claimedMessage = claimed.find((item) => item.id === message.id);
    if (!claimedMessage) return { taskId: task.id, message: await this.messages.load(message.id), delivery: 'queued', reason: 'Message was not claimable for live delivery; it remains queued.' };
    let sent = false;
    try {
      await this.executor.sendLiveInput(task, claimedMessage.content, signal ?? new AbortController().signal);
      sent = true;
      const acknowledged = await this.messages.acknowledge(task.id, claimToken, 'live');
      if (acknowledged !== 1) throw new TaskEngineError('LIVE_MESSAGE_ACK_FAILED', 'Native live input succeeded but durable acknowledgement was not recorded.');
      return { taskId: task.id, message: await this.messages.load(message.id), delivery: 'live' };
    } catch (error) {
      if (!sent) await this.messages.release(task.id, claimToken).catch(() => undefined);
      if (sent) throw error;
      return { taskId: task.id, message: await this.messages.load(message.id), delivery: 'queued', reason: 'Native live input failed; message was safely returned to the queue.' };
    }
  }

  async runOne(idOrPrefix: string): Promise<DurableTaskRecord> {
    let task = await this.store.load(idOrPrefix);
    if (task.status !== 'queued') return task;
    if (task.notBefore) {
      const delay = Date.parse(task.notBefore) - this.runtime.nowMs();
      if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(delay, 30_000)));
      task = await this.store.load(task.id);
      if (task.notBefore && Date.parse(task.notBefore) > this.runtime.nowMs()) return task;
    }
    const ownerId = randomUUID();
    if (!await this.scheduler.acquire(task.id, ownerId, this.leaseMs)) return task;
    let releaseWorkspace: (() => Promise<void>) | undefined;
    let heartbeatWorkspace: (() => Promise<void>) | undefined;
    let preIsolation: PreparedWorkspace | undefined;
    if (task.mode !== 'plan' && !isTaskGitRepository(task.requestedWorkspace)) {
      try { preIsolation = await this.prepareNonGitWorkspace(task, ownerId); releaseWorkspace = preIsolation.release; }
      catch (error) {
        await this.scheduler.release(task.id, ownerId).catch(() => undefined);
        if (error instanceof TaskEngineError && error.code === 'WORKSPACE_EDIT_LOCKED') return task;
        if (error instanceof TaskEngineError && error.code === 'WORKSPACE_EDIT_LOCK_AMBIGUOUS') return await this.store.block(task.id, task.revision, 'ownership', error.code);
        throw error;
      }
    }
    let pulseTimer: NodeJS.Timeout | undefined;
    const abort = new AbortController();
    let attemptBefore: ReturnType<typeof runtimeWorkspaceSnapshot> | undefined;
    let executionWorkspace: string | undefined;
    let pulsing = false;
    let pulseError: unknown;
    let messageClaimToken: string | undefined;
    try {
      task = await this.store.claim(task.id, task.revision, { ownerId, ownerPid: process.pid, hostId: hostname(), instanceId: randomUUID() }, this.leaseMs);
      const fence = task.lease?.fencingToken;
      const epoch = task.lease?.maintenanceEpoch;
      if (fence === undefined || epoch === undefined) throw new TaskEngineError('LEASE_NOT_ESTABLISHED', 'Task claim did not establish a lease.');
      const isolation = preIsolation ?? await this.prepareWorkspace(task, ownerId);
      releaseWorkspace = isolation.release;
      heartbeatWorkspace = isolation.heartbeat;
      task = await this.store.setExecutionIsolation(task.id, task.revision, ownerId, fence, epoch, isolation.record);
      const pulse = async (): Promise<void> => {
        if (pulsing || abort.signal.aborted) return;
        pulsing = true;
        try {
          const current = await this.store.load(task.id);
          task = current;
          if (current.cancelRequestedAt) { abort.abort(); return; }
          task = await this.store.heartbeat(current.id, current.revision, ownerId, fence, epoch, this.leaseMs);
          await this.scheduler.heartbeat(current.id, ownerId, this.leaseMs);
          if (messageClaimToken && await this.messages.renew(current.id, messageClaimToken) !== 1) throw new TaskEngineError('TASK_MESSAGE_CLAIM_LOST', 'The queued follow-up claim was lost during execution.');
          await heartbeatWorkspace?.();
        } catch (error) { pulseError = error; abort.abort(); }
        finally { pulsing = false; }
      };
      executionWorkspace = task.executionWorkspace ?? task.requestedWorkspace;
      const before = runtimeWorkspaceSnapshot(this.runtime, executionWorkspace);
      attemptBefore = before;
      task = await this.store.recordAttemptStart(task.id, task.revision, ownerId, fence, epoch, before);
      pulseTimer = setInterval(() => { void pulse(); }, this.heartbeatMs);
      pulseTimer.unref();
      const claimToken = randomUUID();
      await this.messages.recoverExpiredClaims(task.id);
      const claimedMessages = await this.messages.claimForExecution(task.id, claimToken);
      if (claimedMessages.length > 0) messageClaimToken = claimToken;
      const executionPrompt = appendSpecialistExecutionContext(task);
      const executionTask = {
        ...task,
        prompt: claimedMessages.length > 0 ? appendQueuedFollowUps(executionPrompt, claimedMessages) : executionPrompt,
      };
      const outcome = await this.executor.execute(executionTask, executionWorkspace, abort.signal);
      await this.recordCapabilityRequests(task, outcome.response);
      if (claimedMessages.length > 0) {
        const acknowledged = await this.messages.acknowledge(task.id, claimToken, 'queued');
        if (acknowledged !== claimedMessages.length) throw new TaskEngineError('TASK_MESSAGE_ACK_FAILED', 'Task completed but queued follow-up acknowledgement was incomplete.');
        messageClaimToken = undefined;
      }
      if (pulseTimer) clearInterval(pulseTimer);
      while (pulsing) await new Promise((resolvePromise) => setImmediate(resolvePromise));
      task = await this.store.load(task.id);
      if (task.cancelRequestedAt) return await this.store.cancelRunning(task.id, task.revision, ownerId, fence, epoch);
      if (abort.signal.aborted) throw pulseError ?? new TaskEngineError('WORKER_HEARTBEAT_FAILED', 'Worker heartbeat failed without a cancellation request.');
      const after = runtimeWorkspaceSnapshot(this.runtime, executionWorkspace);
      const change = classifyWorkspaceChange(before, after);
      const result = await this.results.persist(task.id, task.attempt, outcome.response);
      const review = outcome.review?.workspaceFingerprint ? {
        verdict: outcome.review.verdict,
        reviewerFamily: outcome.review.reviewerFamily,
        workspaceFingerprint: outcome.review.workspaceFingerprint,
        ...(outcome.review.packetFingerprint ? { packetFingerprint: outcome.review.packetFingerprint } : {}),
      } : undefined;
      if (task.mode === 'plan' && change.state !== 'unchanged') {
        return await this.store.blockWithOutcome(task.id, task.revision, ownerId, fence, epoch, 'workspace', change.state === 'changed' ? 'PLAN_WRITE_VIOLATION' : 'WORKSPACE_UNMEASURABLE', {
          result, artifacts: [], attemptEvidence: { before, after, state: change.state }, ...(review ? { review } : {}),
        });
      }
      if (change.state === 'unmeasurable') return await this.store.blockWithOutcome(task.id, task.revision, ownerId, fence, epoch, 'workspace', 'WORKSPACE_UNMEASURABLE', { result, artifacts: [], attemptEvidence: { before, after, state: change.state }, ...(review ? { review } : {}) });
      let artifacts: TaskArtifact[];
      try { artifacts = await this.artifacts(task, executionWorkspace, change.state); }
      catch (error) {
        return await this.store.blockWithOutcome(task.id, task.revision, ownerId, fence, epoch, 'preflight', taskErrorCode(error), { result, artifacts: [], attemptEvidence: { before, after, state: change.state }, ...(review ? { review } : {}) });
      }
      if (change.state === 'changed' && task.mode !== 'plan' && (outcome.review?.verdict !== 'PASS' || !after.fingerprint || outcome.review.workspaceFingerprint !== after.fingerprint)) {
        const code = outcome.review?.verdict === 'REVIEW_BLOCKED'
          ? 'REVIEW_BLOCKED'
          : outcome.review?.verdict === 'PASS'
            ? 'STALE_REVIEW_EVIDENCE'
            : 'REVIEW_PASS_REQUIRED';
        return await this.store.blockWithOutcome(task.id, task.revision, ownerId, fence, epoch, 'review', code, { result, artifacts, attemptEvidence: { before, after, state: change.state }, ...(review ? { review } : {}) });
      }
      return await this.store.complete(task.id, task.revision, ownerId, fence, epoch, {
        result,
        artifacts,
        attemptEvidence: { before, after, state: change.state },
        ...(review ? { review } : {}),
      });
    } catch (error) {
      if (pulseTimer) clearInterval(pulseTimer);
      while (pulsing) await new Promise((resolvePromise) => setImmediate(resolvePromise));
      task = await this.store.load(task.id).catch(() => task);
      if (messageClaimToken) {
        await this.messages.release(task.id, messageClaimToken).catch(() => undefined);
        messageClaimToken = undefined;
      }
      if (task.status === 'queued') {
        const code = taskErrorCode(error);
        if (code === 'DEPENDENCY_BLOCKED') return await this.store.block(task.id, task.revision, 'dependency', code);
        if (code === 'DEPENDENCY_WAITING' || code === 'TASK_BACKOFF_ACTIVE' || code === 'MAINTENANCE_ACTIVE') return task;
      }
      if (task.status === 'blocked' && taskErrorCode(error) === 'STALE_MAINTENANCE_EPOCH') return task;
      if (task.status === 'running' && task.lease?.ownerId === ownerId) {
        if (task.cancelRequestedAt) {
          return await this.store.cancelRunning(task.id, task.revision, ownerId, task.lease.fencingToken, task.lease.maintenanceEpoch);
        }
        const executionError = pulseError ?? error;
        const code = taskErrorCode(executionError);
        if (attemptBefore && executionWorkspace) {
          const after = runtimeWorkspaceSnapshot(this.runtime, executionWorkspace);
          const change = classifyWorkspaceChange(attemptBefore, after);
          try {
            const delay = retryDelayMs(task.attempt, task.retry.baseDelayMs, task.retry.maxDelayMs);
            return await this.store.scheduleRetry(task.id, task.revision, ownerId, task.lease.fencingToken, task.lease.maintenanceEpoch, code, change.state, attemptBefore, after, delay);
          } catch (retryError) {
            if (taskErrorCode(retryError) !== 'RETRY_NOT_ELIGIBLE') throw retryError;
          }
        }
        return await this.store.fail(task.id, task.revision, ownerId, task.lease.fencingToken, task.lease.maintenanceEpoch, code, executionError instanceof Error ? executionError.message : String(executionError));
      }
      throw error;
    } finally {
      if (pulseTimer) clearInterval(pulseTimer);
      if (messageClaimToken) await this.messages.release(task.id, messageClaimToken).catch(() => undefined);
      await releaseWorkspace?.().catch(() => undefined);
      await this.scheduler.release(task.id, ownerId).catch(() => undefined);
      await this.launchQueued().catch(() => undefined);
    }
  }

  async wait(idOrPrefix: string, intervalMs = 250): Promise<DurableTaskRecord> {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 5_000) throw new TaskEngineError('INVALID_WAIT_INTERVAL', 'Task wait interval is invalid.');
    let lastRecovery = 0;
    for (;;) {
      const task = await this.store.load(idOrPrefix);
      if (['completed', 'failed', 'cancelled', 'blocked'].includes(task.status)) return task;
      if (task.status === 'queued' && this.runtime.nowMs() - lastRecovery >= 5_000) {
        lastRecovery = this.runtime.nowMs();
        await this.recover().catch(() => undefined);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
    }
  }

  async launchQueued(): Promise<number> {
    const records = (await this.store.listDetailed()).records;
    const graph = new Map(records.map((task) => [task.id, task]));
    const available = Math.max(0, 3 - await this.scheduler.count());
    const queued: DurableTaskRecord[] = [];
    for (const task of records.filter((item) => item.status === 'queued')) {
      if (task.notBefore && Date.parse(task.notBefore) > this.runtime.nowMs()) continue;
      const readiness = dependencyReadiness(task, graph);
      if (readiness.state === 'blocked') {
        await this.store.block(task.id, task.revision, 'dependency', 'DEPENDENCY_BLOCKED').catch(() => undefined);
      } else if (readiness.state === 'ready') queued.push(task);
      if (available > 0 && queued.length >= available) break;
    }
    if (available === 0) return 0;
    let launched = 0;
    for (const task of queued) if (await this.launcher.launch(task.id).catch(() => false)) launched += 1;
    return launched;
  }

  async recover(): Promise<{ launched: number; reclaimed: number; blocked: number }> {
    await this.messages.recoverExpiredClaims();
    const schedulerRecovery = await this.scheduler.recoverExpired(this.ownerProbe);
    const tasks = (await this.store.listDetailed()).records;
    let reclaimed = 0;
    let blocked = 0;
    for (const task of tasks.filter((item) => item.status === 'running' && item.lease)) {
      const lease = task.lease!;
      const probe = this.ownerProbe(lease.hostId, lease.ownerPid);
      const decision = reclaimDecision(lease, this.runtime.nowMs(), probe);
      if (decision === 'reclaim') {
        const attempt = task.attempts.find((item) => item.attempt === task.attempt);
        let state = attempt?.state ?? 'unmeasurable';
        if (attempt?.before && task.executionWorkspace) {
          const after = runtimeWorkspaceSnapshot(this.runtime, task.executionWorkspace);
          state = classifyWorkspaceChange(attempt.before, after).state;
        }
        const recovered = await this.store.recoverOrphan(task.id, task.revision, lease.ownerId, lease.fencingToken, state, probe);
        if (recovered.status === 'queued') reclaimed += 1;
        else blocked += 1;
        await this.scheduler.release(task.id, lease.ownerId).catch(() => undefined);
      } else if (decision === 'block_ambiguous') {
        await this.store.block(task.id, task.revision, 'ownership', 'OWNER_LIVENESS_AMBIGUOUS');
        await this.scheduler.releaseTask(task.id).catch(() => undefined);
        blocked += 1;
      }
    }
    for (const taskId of schedulerRecovery.ambiguous) {
      const task = await this.store.load(taskId).catch(() => undefined);
      if (task?.status === 'queued') { await this.store.block(task.id, task.revision, 'ownership', 'OWNER_LIVENESS_AMBIGUOUS'); await this.scheduler.releaseTask(task.id); blocked += 1; }
    }
    const hasRunning = (await this.store.listDetailed()).records.some((task) => task.status === 'running');
    if (!hasRunning && await this.scheduler.count() === 0) {
      await this.store.withMaintenance('state_migration', async () => {
        await this.store.migrateRecordsInMaintenance();
        await new SessionStore({ root: this.root, runtime: this.runtime }).migrateRecordsInMaintenance();
      });
    }
    return { launched: await this.launchQueued(), reclaimed, blocked };
  }

  private async prepareWorkspace(task: DurableTaskRecord, ownerId: string): Promise<PreparedWorkspace> {
    if (task.mode === 'plan') return { record: { executionWorkspace: await realpath(task.requestedWorkspace) } };
    if (isTaskGitRepository(task.requestedWorkspace)) {
      const manager = new WorktreeManager(this.root);
      if (task.executionWorkspace || task.repositoryIdentity || task.baseCommit) {
        if (!task.executionWorkspace || !task.repositoryIdentity || !task.baseCommit) throw new TaskEngineError('WORKTREE_EVIDENCE_INCOMPLETE', 'Persisted worktree evidence is incomplete.');
        const managed = await manager.reuse(task.id, task.requestedWorkspace, task.executionWorkspace, task.repositoryIdentity, task.baseCommit);
        return { record: { executionWorkspace: managed.executionWorkspace, repositoryIdentity: managed.repositoryIdentity, baseCommit: managed.baseCommit } };
      }
      const managed = await manager.create(task.id, task.requestedWorkspace);
      return { record: { executionWorkspace: managed.executionWorkspace, repositoryIdentity: managed.repositoryIdentity, baseCommit: managed.baseCommit } };
    }
    return await this.prepareNonGitWorkspace(task, ownerId);
  }

  private async prepareNonGitWorkspace(task: DurableTaskRecord, ownerId: string): Promise<PreparedWorkspace> {
    const workspace = await realpath(task.requestedWorkspace);
    const key = createHash('sha256').update(workspace).digest('hex');
    const locks = new WorkspaceLockStore(this.root, this.runtime, this.ownerProbe);
    const acquired = await locks.acquire(key, workspace, task.id, { ownerId, ownerPid: process.pid, hostId: hostname() }, this.leaseMs);
    if (acquired.status === 'locked') throw new TaskEngineError('WORKSPACE_EDIT_LOCKED', 'Non-Git workspace already has an editing owner.');
    if (acquired.status === 'ambiguous') throw new TaskEngineError('WORKSPACE_EDIT_LOCK_AMBIGUOUS', 'Non-Git workspace ownership is ambiguous.');
    return {
      record: { executionWorkspace: workspace, repositoryIdentity: `non-git:${key}` },
      release: async () => await acquired.handle.release(),
      heartbeat: async () => await acquired.handle.heartbeat(this.leaseMs),
    };
  }

  private async artifacts(task: DurableTaskRecord, cwd: string, state: 'changed' | 'unchanged'): Promise<TaskArtifact[]> {
    if (state === 'unchanged') return [];
    if (!isTaskGitRepository(cwd)) throw new TaskEngineError('ARTIFACT_EVIDENCE_UNAVAILABLE', 'Changed non-Git workspaces require human artifact inspection.');
    const result = sanitizedGitRunner(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!result.ok) throw new TaskEngineError('ARTIFACT_EVIDENCE_UNAVAILABLE', 'Git artifact evidence is unavailable.');
    const artifacts: TaskArtifact[] = [];
    for (const { path, kind } of parseGitArtifactEntries(result.stdout)) {
      artifacts.push(await validateArtifact(cwd, { path, kind, status: kind === 'removed' ? 'missing' : 'captured' }));
    }
    return artifacts;
  }

  private async recordCapabilityRequests(task: DurableTaskRecord, response: string): Promise<void> {
    const parsed = parseCapabilityRequests(response);
    for (const item of parsed) {
      const request = item.request;
      if (!request) {
        await this.capabilities.record({ taskId: task.id, rootCorrelationId: task.rootCorrelationId, raw: item.raw, code: 'INVALID_CAPABILITY_REQUEST' });
        continue;
      }
      const identityMatches = Boolean(task.specialist)
        && request.requesterTaskId === task.id
        && request.rootCorrelationId === task.rootCorrelationId
        && request.personaId === task.specialist?.personaId;
      if (!identityMatches) {
        await this.capabilities.record({ taskId: task.id, rootCorrelationId: task.rootCorrelationId, raw: item.raw, code: 'INVALID_CAPABILITY_REQUEST' });
        continue;
      }
      const decision = routeCapabilityRequest(request, this.rootOrchestrator);
      await this.capabilities.record({ taskId: task.id, rootCorrelationId: task.rootCorrelationId, request, raw: item.raw, code: decision.code });
    }
  }
}

export function parseGitArtifactEntries(stdout: string): Array<Pick<TaskArtifact, 'path' | 'kind'>> {
  const parsed: Array<Pick<TaskArtifact, 'path' | 'kind'>> = [];
  const entries = stdout.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    parsed.push({ path, kind: status === '??' ? 'created' : status.includes('D') ? 'removed' : 'modified' });
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return parsed;
}

function isTaskGitRepository(cwd: string): boolean {
  const result = sanitizedGitRunner(cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.ok && result.stdout.trim() === 'true';
}

export function probeOwner(
  hostId: string,
  pid: number,
  seams: { localHost?: string; signal?: (pid: number) => void } = {},
): OwnerProbeState {
  if (hostId !== (seams.localHost ?? hostname())) return 'unknown';
  try { (seams.signal ?? ((target) => { process.kill(target, 0); }))(pid); return 'alive'; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'potentially_alive';
    return 'unknown';
  }
}
