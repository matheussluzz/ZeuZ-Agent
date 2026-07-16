import { isAbsolute, normalize } from 'node:path';

import type { PermissionMode, ReviewResult } from './types.js';
import type { WorkspaceChangeState, WorkspaceSnapshot } from './workspace.js';

export const TASK_SCHEMA_VERSION = 1 as const;
export const LEASE_SCHEMA_VERSION = 1 as const;
export const RESULT_SCHEMA_VERSION = 1 as const;
export const MAX_TASK_DEPTH = 1;
export const MAX_TASK_ATTEMPTS = 3;
export const MAX_TRANSITION_HISTORY = 64;
export const DEFAULT_RESULT_MAX_BYTES = 8 * 1024 * 1024;

export type TaskStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type TaskBlockedReason = 'dependency' | 'review' | 'workspace' | 'ownership' | 'migration' | 'preflight';
export type ArtifactKind = 'created' | 'modified' | 'removed';
export type ArtifactStatus = 'captured' | 'missing' | 'rejected';

export interface TaskTransition {
  at: string;
  from: TaskStatus;
  to: TaskStatus;
  attempt: number;
  reasonCode?: string;
  ownerFingerprint?: string;
}

export interface TaskLease {
  schemaVersion: typeof LEASE_SCHEMA_VERSION;
  revision: number;
  taskId: string;
  ownerId: string;
  ownerPid: number;
  hostId: string;
  instanceId: string;
  fencingToken: number;
  maintenanceEpoch: number;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface TaskResultReference {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  path: string;
  sha256: string;
  byteCount: number;
  maxBytes: number;
  truncated: boolean;
  unsafeCompletion: boolean;
  createdAt: string;
}

export interface TaskArtifact {
  path: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  sha256?: string;
  byteCount?: number;
}

export interface TaskReviewEvidence {
  verdict: ReviewResult['verdict'];
  reviewerFamily: string;
  workspaceFingerprint: string;
  packetFingerprint?: string;
}

export interface TaskAttemptEvidence {
  attempt: number;
  before: WorkspaceSnapshot;
  after?: WorkspaceSnapshot;
  state?: WorkspaceChangeState;
  errorCode?: string;
}

export interface TaskRetryPolicy {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface DurableTaskRecord {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  revision: number;
  id: string;
  parentTaskId?: string;
  parentSessionId?: string;
  rootCorrelationId: string;
  depth: number;
  dependencyIds: string[];
  modelId: string;
  prompt: string;
  requestedWorkspace: string;
  repositoryIdentity?: string;
  baseCommit?: string;
  executionWorkspace?: string;
  mode: PermissionMode;
  status: TaskStatus;
  blockedReason?: TaskBlockedReason;
  blockedCode?: string;
  attempt: number;
  retry: TaskRetryPolicy;
  lease?: TaskLease;
  cancelRequestedAt?: string;
  cancelCause?: string;
  result?: TaskResultReference;
  artifacts: TaskArtifact[];
  review?: TaskReviewEvidence;
  attempts: TaskAttemptEvidence[];
  transitions: TaskTransition[];
  createdAt: string;
  updatedAt: string;
  notBefore?: string;
  terminalAt?: string;
  errorCode?: string;
  error?: string;
}

export class TaskSchemaError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TaskSchemaError';
    this.code = code;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', `${label} contains unknown fields.`);
}

function text(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', `${label} is invalid.`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', `${label} is invalid.`);
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', `${label} is invalid.`);
  return result;
}

function safeCode(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^[A-Z0-9_]+$/.test(result)) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', `${label} is not a safe code.`);
  return result;
}

function assertWorkspaceSnapshot(value: unknown, label: string): asserts value is WorkspaceSnapshot {
  const snapshot = record(value, label);
  exact(snapshot, ['policy', 'kind', 'measurable', 'fingerprint', 'reason', 'filesMeasured', 'bytesHashed'], label);
  if (snapshot.policy !== 'wave-03-v1' || !['git', 'non_git', 'unknown'].includes(String(snapshot.kind)) || typeof snapshot.measurable !== 'boolean') throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', `${label} is invalid.`);
  if (snapshot.fingerprint !== undefined) text(snapshot.fingerprint, `${label}.fingerprint`, 256);
  if (snapshot.reason !== undefined && !['git_command_failed', 'repository_changed_during_measurement', 'sensitive_path', 'unsafe_symlink', 'entry_too_large', 'scan_budget_exceeded', 'permission_denied', 'concurrent_mutation', 'workspace_unavailable', 'policy_mismatch'].includes(String(snapshot.reason))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', `${label}.reason is invalid.`);
  if (snapshot.filesMeasured !== undefined) integer(snapshot.filesMeasured, `${label}.filesMeasured`);
  if (snapshot.bytesHashed !== undefined) integer(snapshot.bytesHashed, `${label}.bytesHashed`);
}

export function assertPortableRelativePath(path: string, label: string): void {
  const portable = path.replaceAll('\\', '/');
  if (!portable || isAbsolute(portable) || portable.startsWith('/') || portable.includes('\0')) throw new TaskSchemaError('UNSAFE_ARTIFACT_PATH', `${label} must be workspace-relative.`);
  const normalized = normalize(portable).replaceAll('\\', '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized !== portable.replace(/^\.\//, '')) {
    throw new TaskSchemaError('UNSAFE_ARTIFACT_PATH', `${label} escapes its boundary.`);
  }
}

export function assertTaskRecord(value: unknown): asserts value is DurableTaskRecord {
  const task = record(value, 'task');
  const allowed = new Set([
    'schemaVersion', 'revision', 'id', 'parentTaskId', 'parentSessionId', 'rootCorrelationId', 'depth', 'dependencyIds', 'modelId', 'prompt',
    'requestedWorkspace', 'repositoryIdentity', 'baseCommit', 'executionWorkspace', 'mode', 'status', 'blockedReason', 'blockedCode', 'attempt', 'retry',
    'lease', 'cancelRequestedAt', 'cancelCause', 'result', 'artifacts', 'review', 'attempts', 'transitions', 'createdAt', 'updatedAt', 'notBefore',
    'terminalAt', 'errorCode', 'error',
  ]);
  if (Object.keys(task).some((key) => !allowed.has(key))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Task contains unknown fields.');
  const version = integer(task.schemaVersion, 'task.schemaVersion', 0, 1_000_000);
  if (version > TASK_SCHEMA_VERSION) throw new TaskSchemaError('UNSUPPORTED_STATE_VERSION', 'Task state version is newer than this runtime.');
  if (version !== TASK_SCHEMA_VERSION) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Task state is not current.');
  integer(task.revision, 'task.revision');
  const id = text(task.id, 'task.id');
  text(task.rootCorrelationId, 'task.rootCorrelationId');
  integer(task.depth, 'task.depth', 0, MAX_TASK_DEPTH);
  if (!Array.isArray(task.dependencyIds) || !task.dependencyIds.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'task.dependencyIds is invalid.');
  }
  if (new Set(task.dependencyIds).size !== task.dependencyIds.length || task.dependencyIds.includes(id)) throw new TaskSchemaError('INVALID_DEPENDENCY_GRAPH', 'Task dependencies are invalid.');
  text(task.modelId, 'task.modelId');
  text(task.prompt, 'task.prompt', 1_000_000);
  text(task.requestedWorkspace, 'task.requestedWorkspace', 8_192);
  if (!['plan', 'agent', 'yolo'].includes(String(task.mode))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'task.mode is invalid.');
  if (!['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'].includes(String(task.status))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'task.status is invalid.');
  integer(task.attempt, 'task.attempt', 0, MAX_TASK_ATTEMPTS);
  const retry = record(task.retry, 'task.retry');
  exact(retry, ['enabled', 'maxAttempts', 'baseDelayMs', 'maxDelayMs'], 'task.retry');
  if (typeof retry.enabled !== 'boolean') throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'task.retry.enabled is invalid.');
  integer(retry.maxAttempts, 'task.retry.maxAttempts', 1, MAX_TASK_ATTEMPTS);
  integer(retry.baseDelayMs, 'task.retry.baseDelayMs', 0, 3_600_000);
  integer(retry.maxDelayMs, 'task.retry.maxDelayMs', 0, 3_600_000);
  if ((retry.baseDelayMs as number) > (retry.maxDelayMs as number)) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'task.retry delay bounds are inverted.');
  if (!Array.isArray(task.artifacts) || !Array.isArray(task.attempts) || !Array.isArray(task.transitions)) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Task arrays are invalid.');
  if (task.artifacts.length > 10_000 || task.attempts.length > MAX_TASK_ATTEMPTS) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Task arrays exceed their budgets.');
  for (const artifactValue of task.artifacts) {
    const artifact = record(artifactValue, 'task.artifact');
    exact(artifact, ['path', 'kind', 'status', 'sha256', 'byteCount'], 'task.artifact');
    const path = text(artifact.path, 'task.artifact.path', 8_192);
    assertPortableRelativePath(path, 'task.artifact.path');
    if (!['created', 'modified', 'removed'].includes(String(artifact.kind)) || !['captured', 'missing', 'rejected'].includes(String(artifact.status))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Task artifact metadata is invalid.');
    if (artifact.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(artifact.sha256))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Task artifact digest is invalid.');
    if (artifact.byteCount !== undefined) integer(artifact.byteCount, 'task.artifact.byteCount');
  }
  if (task.transitions.length > MAX_TRANSITION_HISTORY) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Task transition history exceeds its budget.');
  for (const transitionValue of task.transitions) {
    const transition = record(transitionValue, 'task.transition');
    exact(transition, ['at', 'from', 'to', 'attempt', 'reasonCode', 'ownerFingerprint'], 'task.transition');
    timestamp(transition.at, 'task.transition.at');
    if (!['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'].includes(String(transition.from)) || !['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'].includes(String(transition.to))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Task transition state is invalid.');
    integer(transition.attempt, 'task.transition.attempt', 0, MAX_TASK_ATTEMPTS);
    if (transition.reasonCode !== undefined) safeCode(transition.reasonCode, 'task.transition.reasonCode');
    if (transition.ownerFingerprint !== undefined && !/^[a-f0-9]{16}$/.test(String(transition.ownerFingerprint))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'task.transition.ownerFingerprint is invalid.');
  }
  for (const attemptValue of task.attempts) {
    const attempt = record(attemptValue, 'task.attempt');
    exact(attempt, ['attempt', 'before', 'after', 'state', 'errorCode'], 'task.attempt');
    integer(attempt.attempt, 'task.attempt.attempt', 1, MAX_TASK_ATTEMPTS);
    assertWorkspaceSnapshot(attempt.before, 'task.attempt.before');
    if (attempt.after !== undefined) assertWorkspaceSnapshot(attempt.after, 'task.attempt.after');
    if (attempt.state !== undefined && !['changed', 'unchanged', 'unmeasurable'].includes(String(attempt.state))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'task.attempt.state is invalid.');
    if (attempt.errorCode !== undefined) safeCode(attempt.errorCode, 'task.attempt.errorCode');
  }
  const attemptNumbers = (task.attempts as TaskAttemptEvidence[]).map((item) => item.attempt);
  if (new Set(attemptNumbers).size !== attemptNumbers.length || (task.attempt as number) > (retry.maxAttempts as number)) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Task attempt evidence is inconsistent.');
  timestamp(task.createdAt, 'task.createdAt');
  timestamp(task.updatedAt, 'task.updatedAt');
  if (task.parentTaskId !== undefined) text(task.parentTaskId, 'task.parentTaskId');
  if (task.parentSessionId !== undefined) text(task.parentSessionId, 'task.parentSessionId');
  if (task.repositoryIdentity !== undefined) text(task.repositoryIdentity, 'task.repositoryIdentity', 8_192);
  if (task.baseCommit !== undefined) text(task.baseCommit, 'task.baseCommit', 256);
  if (task.executionWorkspace !== undefined) text(task.executionWorkspace, 'task.executionWorkspace', 8_192);
  if (task.result !== undefined) assertTaskResultReference(task.result);
  if (task.lease !== undefined) assertTaskLease(task.lease, id);
  if (task.cancelRequestedAt !== undefined) timestamp(task.cancelRequestedAt, 'task.cancelRequestedAt');
  if (task.cancelCause !== undefined) text(task.cancelCause, 'task.cancelCause', 200);
  if (task.notBefore !== undefined) timestamp(task.notBefore, 'task.notBefore');
  if (task.terminalAt !== undefined) timestamp(task.terminalAt, 'task.terminalAt');
  if (task.blockedReason !== undefined && !['dependency', 'review', 'workspace', 'ownership', 'migration', 'preflight'].includes(String(task.blockedReason))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'task.blockedReason is invalid.');
  if (task.blockedCode !== undefined) safeCode(task.blockedCode, 'task.blockedCode');
  if (task.errorCode !== undefined) safeCode(task.errorCode, 'task.errorCode');
  if (task.error !== undefined && (typeof task.error !== 'string' || Buffer.byteLength(task.error) > 4_096)) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'task.error is invalid.');
  if (task.review !== undefined) {
    const review = record(task.review, 'task.review');
    exact(review, ['verdict', 'reviewerFamily', 'workspaceFingerprint', 'packetFingerprint'], 'task.review');
    if (!['PASS', 'CHANGES_REQUIRED', 'REVIEW_BLOCKED'].includes(String(review.verdict))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'task.review.verdict is invalid.');
    text(review.reviewerFamily, 'task.review.reviewerFamily', 500);
    text(review.workspaceFingerprint, 'task.review.workspaceFingerprint', 256);
    if (review.packetFingerprint !== undefined) text(review.packetFingerprint, 'task.review.packetFingerprint', 256);
  }
  if (task.status === 'running' && task.lease === undefined) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Running task requires a lease.');
  if (task.status === 'blocked' && (!task.blockedReason || !task.blockedCode)) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Blocked task requires a safe reason.');
  if (task.status !== 'blocked' && (task.blockedReason !== undefined || task.blockedCode !== undefined)) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Only a blocked task may carry a current blocked reason.');
  if (['completed', 'failed', 'cancelled'].includes(String(task.status)) && task.terminalAt === undefined) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Terminal task requires terminalAt.');
  if (!['completed', 'failed', 'cancelled'].includes(String(task.status)) && task.terminalAt !== undefined) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Non-terminal task cannot carry terminalAt.');
  if (task.result !== undefined && !['blocked', 'completed'].includes(String(task.status))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Result evidence belongs only to blocked or completed tasks.');
  if (task.review !== undefined && !['blocked', 'completed'].includes(String(task.status))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Review evidence belongs only to blocked or completed tasks.');
  if (task.status === 'failed' && task.errorCode === undefined) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Failed task requires an error code.');
  if ((task.transitions as TaskTransition[]).length > 0 && (task.transitions as TaskTransition[]).at(-1)?.to !== task.status) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Task status does not match its latest transition.');
  if (task.status === 'completed' && task.result === undefined) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Completed task requires a result.');
  if (task.status === 'completed') {
    if (task.result?.truncated || task.result?.unsafeCompletion) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Completed task result is not safe and final.');
    const finalAttempt = (task.attempts as TaskAttemptEvidence[]).find((attempt) => attempt.attempt === task.attempt);
    if (!finalAttempt?.after || !finalAttempt.state) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Completed task requires finalized current-attempt evidence.');
    if ((task.transitions as TaskTransition[]).at(-1)?.to !== 'completed') throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Completed task requires a matching terminal transition.');
    if ((task.artifacts as TaskArtifact[]).some((artifact) => artifact.status === 'rejected')) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Completed task contains rejected artifacts.');
  }
}

function assertTaskLease(value: unknown, taskId: string): asserts value is TaskLease {
  const lease = record(value, 'task.lease');
  exact(lease, ['schemaVersion', 'revision', 'taskId', 'ownerId', 'ownerPid', 'hostId', 'instanceId', 'fencingToken', 'maintenanceEpoch', 'claimedAt', 'heartbeatAt', 'expiresAt'], 'task.lease');
  if (integer(lease.schemaVersion, 'task.lease.schemaVersion') !== LEASE_SCHEMA_VERSION) throw new TaskSchemaError('UNSUPPORTED_STATE_VERSION', 'Lease state version is unsupported.');
  integer(lease.revision, 'task.lease.revision');
  if (text(lease.taskId, 'task.lease.taskId') !== taskId) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Lease task ID does not match.');
  text(lease.ownerId, 'task.lease.ownerId');
  integer(lease.ownerPid, 'task.lease.ownerPid', 1);
  text(lease.hostId, 'task.lease.hostId', 1_000);
  text(lease.instanceId, 'task.lease.instanceId');
  integer(lease.fencingToken, 'task.lease.fencingToken', 1);
  integer(lease.maintenanceEpoch, 'task.lease.maintenanceEpoch');
  const claimed = timestamp(lease.claimedAt, 'task.lease.claimedAt');
  const heartbeat = timestamp(lease.heartbeatAt, 'task.lease.heartbeatAt');
  const expires = timestamp(lease.expiresAt, 'task.lease.expiresAt');
  if (Date.parse(heartbeat) < Date.parse(claimed) || Date.parse(expires) <= Date.parse(heartbeat)) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Lease timestamps are invalid.');
}

export function assertTaskResultReference(value: unknown): asserts value is TaskResultReference {
  const result = record(value, 'result');
  exact(result, ['schemaVersion', 'path', 'sha256', 'byteCount', 'maxBytes', 'truncated', 'unsafeCompletion', 'createdAt'], 'result');
  if (integer(result.schemaVersion, 'result.schemaVersion') !== RESULT_SCHEMA_VERSION) throw new TaskSchemaError('UNSUPPORTED_STATE_VERSION', 'Result state version is unsupported.');
  const path = text(result.path, 'result.path', 8_192);
  assertPortableRelativePath(path, 'result.path');
  if (!/^[a-f0-9]{64}$/.test(text(result.sha256, 'result.sha256', 64))) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'result.sha256 is invalid.');
  integer(result.byteCount, 'result.byteCount', 0, DEFAULT_RESULT_MAX_BYTES);
  integer(result.maxBytes, 'result.maxBytes', 1, DEFAULT_RESULT_MAX_BYTES);
  if ((result.byteCount as number) > (result.maxBytes as number)) throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Result byte count exceeds its declared budget.');
  if (typeof result.truncated !== 'boolean' || typeof result.unsafeCompletion !== 'boolean') throw new TaskSchemaError('STATE_SCHEMA_MISMATCH', 'Result completion metadata is invalid.');
  timestamp(result.createdAt, 'result.createdAt');
}
