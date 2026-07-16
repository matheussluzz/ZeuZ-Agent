import { hostname } from 'node:os';
import { resolve } from 'node:path';

import { MaintenanceStore, MaintenanceStoreError, type MaintenanceRecord } from './maintenance-store.js';
import { redactSecrets } from './redact.js';
import { systemRuntime, type RuntimeSeams } from './runtime.js';
import { stateDirectory } from './state-root.js';
import { StateRepository, StateRepositoryError, type StateDiagnostic, type StateListResult } from './state-repository.js';
import { assertStateRecordId } from './state-policy.js';
import { TaskResultStore } from './task-result-store.js';
import {
  LEASE_SCHEMA_VERSION,
  MAX_TASK_ATTEMPTS,
  MAX_TASK_DEPTH,
  TASK_SCHEMA_VERSION,
  TaskSchemaError,
  assertTaskRecord,
  type DurableTaskRecord,
  type TaskAttemptEvidence,
  type TaskBlockedReason,
  type TaskLease,
  type TaskRetryPolicy,
} from './task-schema.js';
import { TaskPolicyError, assertCurrentOwner, dependencyReadiness, reclaimDecision, retryEligible, transitionTask, validateDependencyGraph, type OwnerProbeState } from './task-policy.js';
import type { PermissionMode, ReviewResult } from './types.js';
import type { WorkspaceChangeState, WorkspaceSnapshot } from './workspace.js';

export interface TaskStoreOptions {
  root?: string;
  runtime?: RuntimeSeams;
}

export interface CreateTaskInput {
  parentTaskId?: string;
  parentSessionId?: string;
  rootCorrelationId?: string;
  dependencyIds?: string[];
  modelId: string;
  prompt: string;
  cwd: string;
  mode: PermissionMode;
  retry?: Partial<TaskRetryPolicy>;
}

export interface TaskOwner {
  ownerId: string;
  ownerPid: number;
  hostId: string;
  instanceId: string;
}

export interface CompleteTaskInput {
  result: NonNullable<DurableTaskRecord['result']>;
  artifacts: DurableTaskRecord['artifacts'];
  attemptEvidence: { before: WorkspaceSnapshot; after: WorkspaceSnapshot; state: WorkspaceChangeState };
  review?: Pick<ReviewResult, 'verdict' | 'reviewerFamily' | 'workspaceFingerprint' | 'packetFingerprint'>;
}

export class TaskStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TaskStoreError';
    this.code = code;
  }
}

function legacyText(record: Record<string, unknown>, key: string, maximum = 1_000_000): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new TaskSchemaError('LEGACY_STATE_INVALID', `Legacy task ${key} is invalid.`);
  return value;
}

function importLegacyTask(value: unknown): DurableTaskRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskSchemaError('LEGACY_STATE_INVALID', 'Legacy task must be an object.');
  const legacy = value as Record<string, unknown>;
  const id = legacyText(legacy, 'id', 200);
  assertStateRecordId(id);
  const mode = legacy.mode;
  if (!['plan', 'agent', 'yolo'].includes(String(mode))) throw new TaskSchemaError('LEGACY_STATE_INVALID', 'Legacy task mode is invalid.');
  const oldStatus = legacy.status;
  if (!['queued', 'running', 'completed', 'failed'].includes(String(oldStatus))) throw new TaskSchemaError('LEGACY_STATE_INVALID', 'Legacy task status is invalid.');
  const createdAt = legacyText(legacy, 'createdAt', 64);
  const updatedAt = legacyText(legacy, 'updatedAt', 64);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new TaskSchemaError('LEGACY_STATE_INVALID', 'Legacy task timestamp is invalid.');
  const status = oldStatus === 'queued' ? 'queued' : oldStatus === 'failed' ? 'failed' : 'blocked';
  const blockedCode = oldStatus === 'running' ? 'LEGACY_OWNER_UNKNOWN' : oldStatus === 'completed' ? 'LEGACY_RESULT_UNAVAILABLE' : undefined;
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    revision: 0,
    id,
    ...(typeof legacy.parentSessionId === 'string' ? { parentSessionId: legacy.parentSessionId } : {}),
    rootCorrelationId: id,
    depth: 0,
    dependencyIds: [],
    modelId: legacyText(legacy, 'modelId', 500),
    prompt: redactSecrets(legacyText(legacy, 'prompt')),
    requestedWorkspace: legacyText(legacy, 'cwd', 8_192),
    mode: mode as PermissionMode,
    status,
    ...(blockedCode ? { blockedReason: 'migration' as const, blockedCode } : {}),
    attempt: oldStatus === 'queued' ? 0 : 1,
    retry: { enabled: false, maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 1_000 },
    artifacts: [],
    attempts: [],
    transitions: [],
    createdAt,
    updatedAt,
    ...(oldStatus === 'failed' ? { terminalAt: updatedAt, errorCode: 'LEGACY_TASK_FAILED', ...(typeof legacy.error === 'string' ? { error: redactSecrets(legacy.error) } : {}) } : {}),
  };
}

function upsertAttempt(task: DurableTaskRecord, evidence: TaskAttemptEvidence): TaskAttemptEvidence[] {
  return [...task.attempts.filter((attempt) => attempt.attempt !== evidence.attempt), evidence].sort((left, right) => left.attempt - right.attempt);
}

export class TaskStore {
  private readonly runtime: RuntimeSeams;
  private readonly repository: StateRepository<DurableTaskRecord>;
  private readonly maintenance: MaintenanceStore;
  private readonly results: TaskResultStore;
  private lastDiagnostics: StateDiagnostic[] = [];

  constructor(options: TaskStoreOptions = {}) {
    const root = resolve(options.root ?? stateDirectory());
    this.runtime = options.runtime ?? systemRuntime;
    this.repository = new StateRepository({ root, collection: 'tasks', runtime: this.runtime, validate: assertTaskRecord, importLegacy: importLegacyTask });
    this.maintenance = new MaintenanceStore(root, this.runtime);
    this.results = new TaskResultStore({ root, now: () => this.runtime.now() });
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
    await this.maintenance.initialize();
  }

  async create(input: CreateTaskInput): Promise<DurableTaskRecord> {
    await this.initialize();
    return await this.maintenance.withStableEpoch(undefined, async () => {
    const all = await this.listDetailed();
    const parent = input.parentTaskId ? all.records.find((task) => task.id === input.parentTaskId) : undefined;
    if (input.parentTaskId && !parent) throw new TaskStoreError('PARENT_TASK_NOT_FOUND', 'Parent task does not exist.');
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_TASK_DEPTH) throw new TaskStoreError('DELEGATION_DEPTH_EXCEEDED', 'Delegation depth exceeds one.');
    const timestamp = this.runtime.now();
    const id = this.runtime.newId();
    const retry: TaskRetryPolicy = {
      enabled: input.retry?.enabled ?? false,
      maxAttempts: input.retry?.maxAttempts ?? 1,
      baseDelayMs: input.retry?.baseDelayMs ?? 1_000,
      maxDelayMs: input.retry?.maxDelayMs ?? 30_000,
    };
    if (retry.maxAttempts < 1 || retry.maxAttempts > MAX_TASK_ATTEMPTS || retry.baseDelayMs < 0 || retry.maxDelayMs < retry.baseDelayMs) throw new TaskStoreError('INVALID_RETRY_POLICY', 'Retry policy is invalid.');
    const task: DurableTaskRecord = {
      schemaVersion: TASK_SCHEMA_VERSION,
      revision: 0,
      id,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      rootCorrelationId: input.rootCorrelationId ?? parent?.rootCorrelationId ?? id,
      depth,
      dependencyIds: [...new Set(input.dependencyIds ?? [])],
      modelId: input.modelId,
      prompt: redactSecrets(input.prompt),
      requestedWorkspace: resolve(input.cwd),
      mode: input.mode,
      status: 'queued',
      attempt: 0,
      retry,
      artifacts: [],
      attempts: [],
      transitions: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const graph = new Map(all.records.map((item) => [item.id, item]));
    graph.set(task.id, task);
    validateDependencyGraph(graph);
    return await this.repository.create(task);
    });
  }

  async load(idOrPrefix: string): Promise<DurableTaskRecord> {
    const result = await this.listDetailed();
    const exact = result.records.find((task) => task.id === idOrPrefix);
    if (exact) return exact;
    const matches = result.records.filter((task) => task.id.startsWith(idOrPrefix));
    if (matches.length !== 1 || !matches[0]) throw new TaskStoreError(matches.length > 1 ? 'TASK_PREFIX_AMBIGUOUS' : 'TASK_NOT_FOUND', matches.length > 1 ? 'Task prefix is ambiguous.' : 'Task was not found.');
    return matches[0];
  }

  async list(limit = 30): Promise<DurableTaskRecord[]> {
    const result = await this.listDetailed();
    return result.records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit);
  }

  async listDetailed(): Promise<StateListResult<DurableTaskRecord>> {
    await this.initialize();
    const result = await this.repository.listDetailed();
    this.lastDiagnostics = result.diagnostics;
    return result;
  }

  async migrateAll(): Promise<StateListResult<DurableTaskRecord>> {
    return await this.withMaintenance('state_migration', async () => await this.migrateRecordsInMaintenance());
  }

  async migrateRecordsInMaintenance(): Promise<StateListResult<DurableTaskRecord>> {
    const maintenance = await this.maintenance.current();
    if (!maintenance.active) throw new TaskStoreError('MAINTENANCE_REQUIRED', 'Task migration requires the root maintenance fence.');
    const result = await this.repository.migrateAll();
    this.lastDiagnostics = result.diagnostics;
    return result;
  }

  async withMaintenance<T>(reasonCode: string, action: () => Promise<T>): Promise<T> {
    await this.enterMaintenance(reasonCode);
    try {
      const result = await action();
      await this.exitMaintenance();
      return result;
    } catch (error) {
      // Leave the fence active after an ambiguous or incomplete maintenance action.
      throw error;
    }
  }

  diagnostics(): StateDiagnostic[] {
    return structuredClone(this.lastDiagnostics);
  }

  async replace(task: DurableTaskRecord, expectedRevision: number): Promise<DurableTaskRecord> {
    return await this.maintenance.withStableEpoch(undefined, async () => {
      const current = await this.repository.load(task.id);
      if (current.status !== 'queued') throw new TaskStoreError('DIRECT_TASK_REPLACE_DENIED', 'Running or terminal tasks require a fenced transition API.');
      if (current.revision !== expectedRevision) throw new TaskStoreError('STALE_STATE_REVISION', 'Task revision is stale.');
      const records = (await this.listDetailed()).records.map((item) => item.id === task.id ? task : item);
      validateDependencyGraph(new Map(records.map((item) => [item.id, item])));
      return await this.repository.replace(task, expectedRevision);
    });
  }

  async claim(id: string, expectedRevision: number, owner: TaskOwner, leaseMs: number): Promise<DurableTaskRecord> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 1_800_000) throw new TaskStoreError('INVALID_LEASE_POLICY', 'Lease duration is invalid.');
    return await this.maintenance.withStableEpoch(undefined, async (maintenance) => {
      const task = await this.repository.load(id);
      if (task.revision !== expectedRevision) throw new TaskStoreError('STALE_STATE_REVISION', 'Task revision is stale.');
      if (task.notBefore && Date.parse(task.notBefore) > this.runtime.nowMs()) throw new TaskStoreError('TASK_BACKOFF_ACTIVE', 'Task retry backoff is still active.');
      const all = new Map((await this.listDetailed()).records.map((item) => [item.id, item]));
      const readiness = dependencyReadiness(task, all);
      if (readiness.state !== 'ready') throw new TaskStoreError(readiness.state === 'blocked' ? 'DEPENDENCY_BLOCKED' : 'DEPENDENCY_WAITING', 'Task dependencies are not ready.');
      const now = this.runtime.now();
      const lease: TaskLease = {
        schemaVersion: LEASE_SCHEMA_VERSION, revision: 0, taskId: task.id, ownerId: owner.ownerId, ownerPid: owner.ownerPid,
        hostId: owner.hostId, instanceId: owner.instanceId, fencingToken: (task.lease?.fencingToken ?? 0) + 1,
        maintenanceEpoch: maintenance.epoch, claimedAt: now, heartbeatAt: now, expiresAt: new Date(this.runtime.nowMs() + leaseMs).toISOString(),
      };
      return await this.repository.replace(transitionTask({ ...task, lease, attempt: task.attempt + 1 }, 'running', { at: now }), expectedRevision);
    });
  }

  async heartbeat(id: string, expectedRevision: number, ownerId: string, fencingToken: number, maintenanceEpoch: number, leaseMs: number): Promise<DurableTaskRecord> {
    return await this.maintenance.withStableEpoch(maintenanceEpoch, async () => {
      const task = await this.repository.load(id);
      if (task.revision !== expectedRevision) throw new TaskStoreError('STALE_STATE_REVISION', 'Task revision is stale.');
      if (task.status !== 'running') throw new TaskStoreError('INVALID_TASK_TRANSITION', 'Only a running task can heartbeat.');
      const lease = assertCurrentOwner(task, ownerId, fencingToken, maintenanceEpoch);
      const now = this.runtime.now();
      return await this.repository.replace({ ...task, lease: { ...lease, revision: lease.revision + 1, heartbeatAt: now, expiresAt: new Date(this.runtime.nowMs() + leaseMs).toISOString() } }, task.revision);
    });
  }

  async setExecutionIsolation(
    id: string,
    expectedRevision: number,
    ownerId: string,
    fencingToken: number,
    maintenanceEpoch: number,
    isolation: Pick<DurableTaskRecord, 'executionWorkspace' | 'repositoryIdentity' | 'baseCommit'>,
  ): Promise<DurableTaskRecord> {
    return await this.maintenance.withStableEpoch(maintenanceEpoch, async () => {
      const task = await this.repository.load(id);
      if (task.revision !== expectedRevision) throw new TaskStoreError('STALE_STATE_REVISION', 'Task revision is stale.');
      assertCurrentOwner(task, ownerId, fencingToken, maintenanceEpoch);
      if (task.status !== 'running') throw new TaskStoreError('INVALID_TASK_TRANSITION', 'Only a running owner can set execution isolation.');
      return await this.repository.replace({ ...task, ...isolation }, task.revision);
    });
  }

  async recordAttemptStart(id: string, expectedRevision: number, ownerId: string, fencingToken: number, maintenanceEpoch: number, before: WorkspaceSnapshot): Promise<DurableTaskRecord> {
    return await this.maintenance.withStableEpoch(maintenanceEpoch, async () => {
      const task = await this.repository.load(id);
      if (task.revision !== expectedRevision) throw new TaskStoreError('STALE_STATE_REVISION', 'Task revision is stale.');
      assertCurrentOwner(task, ownerId, fencingToken, maintenanceEpoch);
      const attempts = upsertAttempt(task, { attempt: task.attempt, before });
      return await this.repository.replace({ ...task, attempts }, task.revision);
    });
  }

  async requestCancel(idOrPrefix: string, cause = 'user_request'): Promise<DurableTaskRecord> {
    const initial = await this.load(idOrPrefix);
    return await this.maintenance.withStableEpoch(undefined, async () => {
      const task = await this.repository.load(initial.id);
      if (task.status === 'cancelled') return task;
      if (['completed', 'failed'].includes(task.status)) throw new TaskStoreError('TERMINAL_TASK_MUTATION', 'Terminal task cannot be cancelled.');
      if (task.cancelRequestedAt) return task;
      const now = this.runtime.now();
      if (task.status === 'running') return await this.repository.replace({ ...task, cancelRequestedAt: now, cancelCause: redactSecrets(cause).slice(0, 200) }, task.revision);
      return await this.repository.replace(transitionTask(task, 'cancelled', { at: now, reasonCode: 'CANCEL_REQUESTED' }), task.revision);
    });
  }

  async complete(id: string, expectedRevision: number, ownerId: string, fencingToken: number, maintenanceEpoch: number, input: CompleteTaskInput): Promise<DurableTaskRecord> {
    const task = await this.repository.load(id);
    const review = input.review ? {
      verdict: input.review.verdict,
      reviewerFamily: input.review.reviewerFamily,
      workspaceFingerprint: input.review.workspaceFingerprint ?? '',
      ...(input.review.packetFingerprint ? { packetFingerprint: input.review.packetFingerprint } : {}),
    } : undefined;
    const intendedAttempt = { attempt: task.attempt, ...input.attemptEvidence };
    if (task.status === 'completed') {
      if (JSON.stringify(task.result) === JSON.stringify(input.result)
        && JSON.stringify(task.artifacts) === JSON.stringify(input.artifacts)
        && JSON.stringify(task.attempts.at(-1)) === JSON.stringify(intendedAttempt)
        && JSON.stringify(task.review) === JSON.stringify(review)) return task;
      throw new TaskStoreError('DUPLICATE_COMPLETION_CONFLICT', 'Completed task cannot accept different terminal evidence.');
    }
    return await this.maintenance.withStableEpoch(maintenanceEpoch, async () => {
      const current = await this.repository.load(id);
      if (current.revision !== expectedRevision) throw new TaskStoreError('STALE_STATE_REVISION', 'Task revision is stale.');
      if (['failed', 'cancelled'].includes(current.status)) throw new TaskStoreError('TERMINAL_TASK_MUTATION', 'Terminal task cannot be completed.');
      assertCurrentOwner(current, ownerId, fencingToken, maintenanceEpoch);
      if (current.cancelRequestedAt) throw new TaskStoreError('CANCEL_ALREADY_REQUESTED', 'Cancellation won before completion.');
      await this.results.verifyForTask(input.result, current.id, current.attempt);
      if (input.artifacts.length > 0) {
        if (!current.executionWorkspace) throw new TaskStoreError('ARTIFACT_WORKSPACE_UNAVAILABLE', 'Artifact verification requires the execution workspace.');
        await this.results.verifyArtifacts(current.executionWorkspace, input.artifacts);
      }
      const evidence = { attempt: current.attempt, ...input.attemptEvidence };
      const withEvidence: DurableTaskRecord = { ...current, result: input.result, artifacts: input.artifacts, attempts: upsertAttempt(current, evidence), ...(review ? { review } : {}) };
      return await this.repository.replace(transitionTask(withEvidence, 'completed', { at: this.runtime.now(), ownerId, fencingToken }), current.revision);
    });
  }

  async blockWithOutcome(
    id: string,
    expectedRevision: number,
    ownerId: string,
    fencingToken: number,
    maintenanceEpoch: number,
    reason: TaskBlockedReason,
    code: string,
    input: CompleteTaskInput,
  ): Promise<DurableTaskRecord> {
    return await this.maintenance.withStableEpoch(maintenanceEpoch, async () => {
      const task = await this.repository.load(id);
      if (task.revision !== expectedRevision) throw new TaskStoreError('STALE_STATE_REVISION', 'Task revision is stale.');
      assertCurrentOwner(task, ownerId, fencingToken, maintenanceEpoch);
      await this.results.verifyForTask(input.result, task.id, task.attempt);
      if (input.artifacts.length > 0) {
        if (!task.executionWorkspace) throw new TaskStoreError('ARTIFACT_WORKSPACE_UNAVAILABLE', 'Artifact verification requires the execution workspace.');
        await this.results.verifyArtifacts(task.executionWorkspace, input.artifacts);
      }
      const review = input.review ? { verdict: input.review.verdict, reviewerFamily: input.review.reviewerFamily, workspaceFingerprint: input.review.workspaceFingerprint ?? '', ...(input.review.packetFingerprint ? { packetFingerprint: input.review.packetFingerprint } : {}) } : undefined;
      const withEvidence: DurableTaskRecord = {
        ...task, result: input.result, artifacts: input.artifacts, attempts: upsertAttempt(task, { attempt: task.attempt, ...input.attemptEvidence }),
        blockedReason: reason, blockedCode: code, ...(review ? { review } : {}),
      };
      return await this.repository.replace(transitionTask(withEvidence, 'blocked', { at: this.runtime.now(), ownerId, fencingToken, reasonCode: code }), task.revision);
    });
  }

  async cancelRunning(id: string, expectedRevision: number, ownerId: string, fencingToken: number, maintenanceEpoch: number): Promise<DurableTaskRecord> {
    return await this.maintenance.withStableEpoch(maintenanceEpoch, async () => {
      const task = await this.repository.load(id);
      if (task.revision !== expectedRevision) throw new TaskStoreError('STALE_STATE_REVISION', 'Task revision is stale.');
      assertCurrentOwner(task, ownerId, fencingToken, maintenanceEpoch);
      if (!task.cancelRequestedAt) throw new TaskStoreError('CANCEL_NOT_REQUESTED', 'Running task has no durable cancellation request.');
      return await this.repository.replace(transitionTask(task, 'cancelled', { at: this.runtime.now(), ownerId, fencingToken, reasonCode: 'CANCEL_REQUESTED' }), task.revision);
    });
  }

  async block(id: string, expectedRevision: number, reason: TaskBlockedReason, code: string): Promise<DurableTaskRecord> {
    return await this.maintenance.withStableEpoch(undefined, async (maintenance) => {
      const task = await this.repository.load(id);
      if (task.status === 'running' && task.lease?.maintenanceEpoch !== maintenance.epoch) throw new TaskStoreError('STALE_MAINTENANCE_EPOCH', 'Task write uses a stale root maintenance epoch.');
      const input = task.status === 'running' && task.lease ? { at: this.runtime.now(), ownerId: task.lease.ownerId, fencingToken: task.lease.fencingToken, reasonCode: code } : { at: this.runtime.now(), reasonCode: code };
      return await this.repository.replace(transitionTask({ ...task, blockedReason: reason, blockedCode: code }, 'blocked', input), expectedRevision);
    });
  }

  async fail(id: string, expectedRevision: number, ownerId: string, fencingToken: number, maintenanceEpoch: number, code: string, message: string): Promise<DurableTaskRecord> {
    const task = await this.repository.load(id);
    if (task.status === 'failed' && task.errorCode === code && task.error === redactSecrets(message).slice(0, 4_096)) return task;
    return await this.maintenance.withStableEpoch(maintenanceEpoch, async () => {
      const current = await this.repository.load(id);
      if (current.revision !== expectedRevision) throw new TaskStoreError('STALE_STATE_REVISION', 'Task revision is stale.');
      if (['completed', 'failed', 'cancelled'].includes(current.status)) throw new TaskStoreError('TERMINAL_TASK_MUTATION', 'Terminal task cannot be failed again.');
      assertCurrentOwner(current, ownerId, fencingToken, maintenanceEpoch);
      return await this.repository.replace(transitionTask({ ...current, errorCode: code }, 'failed', { at: this.runtime.now(), ownerId, fencingToken, reasonCode: code, terminalError: redactSecrets(message).slice(0, 4_096) }), current.revision);
    });
  }

  async scheduleRetry(
    id: string,
    expectedRevision: number,
    ownerId: string,
    fencingToken: number,
    maintenanceEpoch: number,
    code: string,
    workspaceState: WorkspaceChangeState,
    before: WorkspaceSnapshot,
    after: WorkspaceSnapshot,
    delayMs: number,
  ): Promise<DurableTaskRecord> {
    return await this.maintenance.withStableEpoch(maintenanceEpoch, async () => {
      const task = await this.repository.load(id);
      if (task.revision !== expectedRevision) throw new TaskStoreError('STALE_STATE_REVISION', 'Task revision is stale.');
      assertCurrentOwner(task, ownerId, fencingToken, maintenanceEpoch);
      if (!retryEligible({ task, errorCode: code, workspaceState })) throw new TaskStoreError('RETRY_NOT_ELIGIBLE', 'Task is not eligible for automatic retry.');
      const now = this.runtime.now();
      const attempts = upsertAttempt(task, { attempt: task.attempt, before, after, state: workspaceState, errorCode: code });
      const blocked = transitionTask({ ...task, attempts, errorCode: code }, 'blocked', { at: now, ownerId, fencingToken, reasonCode: 'RETRY_SCHEDULED' });
      return await this.repository.replace({ ...transitionTask(blocked, 'queued', { at: now, reasonCode: 'RETRY_SCHEDULED' }), notBefore: new Date(this.runtime.nowMs() + delayMs).toISOString() }, task.revision);
    });
  }

  async recoverOrphan(id: string, expectedRevision: number, ownerId: string, fencingToken: number, workspaceState: WorkspaceChangeState, liveness: OwnerProbeState): Promise<DurableTaskRecord> {
    const initial = await this.repository.load(id);
    if (!initial.lease) throw new TaskStoreError('STALE_TASK_OWNER', 'Orphan recovery evidence is stale.');
    return await this.maintenance.withStableEpoch(initial.lease.maintenanceEpoch, async () => {
      const task = await this.repository.load(id);
      if (task.status !== 'running' || task.revision !== expectedRevision || task.lease?.ownerId !== ownerId || task.lease.fencingToken !== fencingToken) throw new TaskStoreError('STALE_TASK_OWNER', 'Orphan recovery evidence is stale.');
      if (reclaimDecision(task.lease, this.runtime.nowMs(), liveness) !== 'reclaim') throw new TaskStoreError('ORPHAN_RECLAIM_DENIED', 'Orphan recovery requires an expired lease and proven-dead owner.');
      const canRetry = task.retry.enabled && task.attempt < task.retry.maxAttempts && workspaceState === 'unchanged';
      const now = this.runtime.now();
      if (!canRetry) return await this.repository.replace(transitionTask({ ...task, blockedReason: 'ownership', blockedCode: workspaceState !== 'unchanged' ? 'UNSAFE_RECOVERY_EVIDENCE' : 'RETRY_EXHAUSTED' }, 'blocked', { at: now, ownerId, fencingToken, reasonCode: workspaceState !== 'unchanged' ? 'UNSAFE_RECOVERY_EVIDENCE' : 'RETRY_EXHAUSTED' }), task.revision);
      const blocked = transitionTask({ ...task, errorCode: 'WORKER_CRASH' }, 'blocked', { at: now, ownerId, fencingToken, reasonCode: 'WORKER_CRASH' });
      return await this.repository.replace({ ...transitionTask(blocked, 'queued', { at: now, reasonCode: 'ORPHAN_RECLAIMED' }), notBefore: now }, task.revision);
    });
  }

  async enterMaintenance(reasonCode: string): Promise<MaintenanceRecord> {
    const current = await this.maintenance.current();
    if (current.active && current.reasonCode !== reasonCode) throw new TaskStoreError('MAINTENANCE_ACTIVE', 'A different maintenance operation is already active.');
    const before = (await this.listDetailed()).records.filter((task) => task.status === 'running');
    if (before.length > 0) throw new TaskStoreError('WORKERS_ACTIVE', 'Active workers must drain before maintenance.');
    const maintenance = current.active ? current : await this.maintenance.enter(reasonCode);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const running = (await this.listDetailed()).records.filter((task) => task.status === 'running');
    if (running.length > 0) {
      if (!current.active) await this.maintenance.abortEnter(maintenance.revision, current.epoch);
      throw new TaskStoreError('WORKERS_ACTIVE', 'Active workers must drain before maintenance.');
    }
    return maintenance;
  }

  async exitMaintenance(): Promise<MaintenanceRecord> {
    return await this.maintenance.exit();
  }

  static localOwner(ownerId: string, instanceId: string): TaskOwner {
    return { ownerId, instanceId, ownerPid: process.pid, hostId: hostname() };
  }
}

export function taskErrorCode(error: unknown): string {
  if (error instanceof TaskStoreError || error instanceof TaskPolicyError || error instanceof TaskSchemaError || error instanceof StateRepositoryError || error instanceof MaintenanceStoreError) return error.code;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)) return error.code;
  return 'TASK_EXECUTION_FAILED';
}
