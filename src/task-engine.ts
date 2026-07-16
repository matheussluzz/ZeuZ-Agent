import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { ZeuzController } from './controller.js';
import { sanitizedChildEnvironment, installRoot } from './env.js';
import { systemRuntime, runtimeWorkspaceSnapshot, type RuntimeSeams } from './runtime.js';
import { SessionStore } from './session-store.js';
import { stateDirectory } from './state-root.js';
import { ensurePrivateStateDirectory, ensureStateContainerDirectory } from './state-policy.js';
import { TaskResultStore, validateArtifact } from './task-result-store.js';
import { TaskScheduler } from './task-scheduler.js';
import { DEFAULT_LEASE_POLICY, dependencyReadiness, reclaimDecision, retryDelayMs, validateLeasePolicy, type OwnerProbeState } from './task-policy.js';
import { TaskStore, taskErrorCode, type CreateTaskInput } from './task-store.js';
import type { DurableTaskRecord, TaskArtifact } from './task-schema.js';
import type { TurnOutcome } from './types.js';
import { classifyWorkspaceChange } from './workspace.js';
import { WorktreeManager, sanitizedGitRunner } from './worktree-manager.js';

export interface TaskExecutor {
  execute(task: DurableTaskRecord, cwd: string, signal: AbortSignal): Promise<TurnOutcome>;
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
  launcher?: WorkerLauncher;
  heartbeatMs?: number;
  leaseMs?: number;
  ownerProbe?: (hostId: string, pid: number) => OwnerProbeState;
}

export class TaskEngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'TaskEngineError'; this.code = code; }
}

class ControllerTaskExecutor implements TaskExecutor {
  async execute(task: DurableTaskRecord, cwd: string, signal: AbortSignal): Promise<TurnOutcome> {
    const controller = await ZeuzController.create(cwd, { modelId: task.modelId, mode: task.mode });
    return await controller.ask(task.modelId, task.prompt, undefined, task.mode, signal);
  }
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
  private readonly launcher: WorkerLauncher;
  private readonly heartbeatMs: number;
  private readonly leaseMs: number;
  private readonly ownerProbe: (hostId: string, pid: number) => OwnerProbeState;

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
    this.launcher = options.launcher ?? new DetachedWorkerLauncher(this.root);
  }

  async submit(input: CreateTaskInput): Promise<{ task: DurableTaskRecord; launched: boolean }> {
    const task = await this.store.create(input);
    let launched = false;
    try { launched = await this.launcher.launch(task.id); } catch { launched = false; }
    return { task, launched };
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
    let preIsolation: { record: Pick<DurableTaskRecord, 'executionWorkspace' | 'repositoryIdentity' | 'baseCommit'>; release?: () => Promise<void> } | undefined;
    if (task.mode !== 'plan' && !isTaskGitRepository(task.requestedWorkspace)) {
      try { preIsolation = await this.prepareNonGitWorkspace(task, ownerId); releaseWorkspace = preIsolation.release; }
      catch (error) {
        await this.scheduler.release(task.id, ownerId).catch(() => undefined);
        if (error instanceof TaskEngineError && error.code === 'WORKSPACE_EDIT_LOCKED') return task;
        throw error;
      }
    }
    let pulseTimer: NodeJS.Timeout | undefined;
    const abort = new AbortController();
    let attemptBefore: ReturnType<typeof runtimeWorkspaceSnapshot> | undefined;
    let executionWorkspace: string | undefined;
    let pulsing = false;
    try {
      task = await this.store.claim(task.id, task.revision, { ownerId, ownerPid: process.pid, hostId: hostname(), instanceId: randomUUID() }, this.leaseMs);
      const fence = task.lease?.fencingToken;
      const epoch = task.lease?.maintenanceEpoch;
      if (fence === undefined || epoch === undefined) throw new TaskEngineError('LEASE_NOT_ESTABLISHED', 'Task claim did not establish a lease.');
      const isolation = preIsolation ?? await this.prepareWorkspace(task, ownerId);
      releaseWorkspace = isolation.release;
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
        } catch { abort.abort(); }
        finally { pulsing = false; }
      };
      executionWorkspace = task.executionWorkspace ?? task.requestedWorkspace;
      const before = runtimeWorkspaceSnapshot(this.runtime, executionWorkspace);
      attemptBefore = before;
      task = await this.store.recordAttemptStart(task.id, task.revision, ownerId, fence, epoch, before);
      pulseTimer = setInterval(() => { void pulse(); }, this.heartbeatMs);
      pulseTimer.unref();
      const outcome = await this.executor.execute(task, executionWorkspace, abort.signal);
      if (pulseTimer) clearInterval(pulseTimer);
      while (pulsing) await new Promise((resolvePromise) => setImmediate(resolvePromise));
      task = await this.store.load(task.id);
      if (task.cancelRequestedAt || abort.signal.aborted) return await this.store.cancelRunning(task.id, task.revision, ownerId, fence, epoch);
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
      if (task.status === 'queued') {
        const code = taskErrorCode(error);
        if (code === 'DEPENDENCY_BLOCKED') return await this.store.block(task.id, task.revision, 'dependency', code);
        if (code === 'DEPENDENCY_WAITING' || code === 'TASK_BACKOFF_ACTIVE' || code === 'MAINTENANCE_ACTIVE') return task;
      }
      if (task.status === 'blocked' && taskErrorCode(error) === 'STALE_MAINTENANCE_EPOCH') return task;
      if (task.status === 'running' && task.lease?.ownerId === ownerId) {
        if (task.cancelRequestedAt || abort.signal.aborted) {
          return await this.store.cancelRunning(task.id, task.revision, ownerId, task.lease.fencingToken, task.lease.maintenanceEpoch);
        }
        const code = taskErrorCode(error);
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
        return await this.store.fail(task.id, task.revision, ownerId, task.lease.fencingToken, task.lease.maintenanceEpoch, code, error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      if (pulseTimer) clearInterval(pulseTimer);
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

  private async prepareWorkspace(task: DurableTaskRecord, ownerId: string): Promise<{ record: Pick<DurableTaskRecord, 'executionWorkspace' | 'repositoryIdentity' | 'baseCommit'>; release?: () => Promise<void> }> {
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

  private async prepareNonGitWorkspace(task: DurableTaskRecord, ownerId: string): Promise<{ record: Pick<DurableTaskRecord, 'executionWorkspace' | 'repositoryIdentity' | 'baseCommit'>; release: () => Promise<void> }> {
    const workspace = await realpath(task.requestedWorkspace);
    const root = await ensureStateContainerDirectory(this.root);
    const locks = await ensurePrivateStateDirectory(join(root, 'workspace-locks'), root);
    const key = createHash('sha256').update(workspace).digest('hex');
    const path = join(locks, `${key}.lock`);
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${ownerId}\n${task.id}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TaskEngineError('WORKSPACE_EDIT_LOCKED', 'Non-Git workspace already has an editing owner.');
      throw error;
    }
    return { record: { executionWorkspace: workspace, repositoryIdentity: `non-git:${key}` }, release: async () => await rm(path, { force: true }) };
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
