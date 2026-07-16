import { createHash } from 'node:crypto';

import {
  MAX_TASK_ATTEMPTS,
  MAX_TRANSITION_HISTORY,
  type DurableTaskRecord,
  type TaskLease,
  type TaskStatus,
} from './task-schema.js';
import type { WorkspaceChangeState } from './workspace.js';

const TERMINAL = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);
const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(['running', 'blocked', 'cancelled']),
  running: new Set(['blocked', 'completed', 'failed', 'cancelled']),
  blocked: new Set(['queued', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export type OwnerProbeState = 'alive' | 'dead' | 'potentially_alive' | 'unknown';
export type ReclaimDecision = 'retain' | 'reclaim' | 'block_ambiguous';

export class TaskPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TaskPolicyError';
    this.code = code;
  }
}

export interface LeaseTimingPolicy {
  heartbeatMs: number;
  leaseMs: number;
  maxWorkers: number;
}

export const DEFAULT_LEASE_POLICY: LeaseTimingPolicy = { heartbeatMs: 30_000, leaseMs: 120_000, maxWorkers: 3 };

export function validateLeasePolicy(policy: LeaseTimingPolicy): LeaseTimingPolicy {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TaskPolicyError('INVALID_LEASE_POLICY', `${name} must be a positive finite integer.`);
  }
  if (policy.heartbeatMs > 300_000 || policy.leaseMs > 1_800_000 || policy.maxWorkers > 3) throw new TaskPolicyError('INVALID_LEASE_POLICY', 'Lease policy exceeds its maximum.');
  if (policy.heartbeatMs >= policy.leaseMs) throw new TaskPolicyError('INVALID_LEASE_POLICY', 'Heartbeat must be shorter than the lease.');
  return policy;
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to && TERMINAL.has(from)) return;
  if (!TRANSITIONS[from].has(to)) throw new TaskPolicyError(TERMINAL.has(from) ? 'TERMINAL_TASK_MUTATION' : 'INVALID_TASK_TRANSITION', `Invalid task transition: ${from} -> ${to}.`);
}

function ownerFingerprint(ownerId: string, fencingToken: number): string {
  return createHash('sha256').update(`${ownerId}:${fencingToken}`).digest('hex').slice(0, 16);
}

export function transitionTask(
  task: DurableTaskRecord,
  to: TaskStatus,
  input: { at: string; reasonCode?: string; ownerId?: string; fencingToken?: number; terminalError?: string },
): DurableTaskRecord {
  assertTransition(task.status, to);
  if (task.status === to && isTerminal(to)) return task;
  if (task.status === 'running') assertCurrentOwner(task, input.ownerId, input.fencingToken);
  if (to === 'completed') {
    if (!task.result || task.result.truncated || task.result.unsafeCompletion) throw new TaskPolicyError('RESULT_NOT_FINALIZED', 'A safe verified result is required before completion.');
    const changed = task.attempts.at(-1)?.state === 'changed';
    if (changed && task.review?.verdict !== 'PASS') throw new TaskPolicyError('REVIEW_BLOCKED', 'Artifact-changing completion requires a fresh PASS.');
    if (changed && task.review?.workspaceFingerprint !== task.attempts.at(-1)?.after?.fingerprint) throw new TaskPolicyError('STALE_REVIEW_EVIDENCE', 'Review evidence does not match the final workspace fingerprint.');
  }
  const transition = {
    at: input.at,
    from: task.status,
    to,
    attempt: task.attempt,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    ...(input.ownerId && input.fencingToken !== undefined ? { ownerFingerprint: ownerFingerprint(input.ownerId, input.fencingToken) } : {}),
  };
  const next: DurableTaskRecord = {
    ...task,
    status: to,
    revision: task.revision,
    updatedAt: input.at,
    transitions: [...task.transitions, transition].slice(-MAX_TRANSITION_HISTORY),
    ...(isTerminal(to) ? { terminalAt: input.at } : {}),
    ...(input.terminalError ? { error: input.terminalError } : {}),
  };
  if (to !== 'blocked') {
    delete next.blockedReason;
    delete next.blockedCode;
  }
  if (!isTerminal(to)) delete next.terminalAt;
  return next;
}

export function assertCurrentOwner(task: DurableTaskRecord, ownerId?: string, fencingToken?: number, maintenanceEpoch?: number): TaskLease {
  const lease = task.lease;
  if (!lease || !ownerId || fencingToken === undefined || lease.ownerId !== ownerId || lease.fencingToken !== fencingToken) {
    throw new TaskPolicyError('STALE_TASK_OWNER', 'Task owner or fencing token is stale.');
  }
  if (maintenanceEpoch !== undefined && lease.maintenanceEpoch !== maintenanceEpoch) throw new TaskPolicyError('STALE_MAINTENANCE_EPOCH', 'Task maintenance epoch is stale.');
  return lease;
}

export function reclaimDecision(lease: TaskLease, nowMs: number, probe: OwnerProbeState): ReclaimDecision {
  if (Date.parse(lease.expiresAt) > nowMs) return 'retain';
  if (probe === 'dead') return 'reclaim';
  if (probe === 'alive' || probe === 'potentially_alive') return 'retain';
  return 'block_ambiguous';
}

export function retryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_TASK_ATTEMPTS) throw new TaskPolicyError('INVALID_RETRY_POLICY', 'Retry attempt is invalid.');
  if (![baseDelayMs, maxDelayMs].every((value) => Number.isSafeInteger(value) && value >= 0) || baseDelayMs > maxDelayMs) throw new TaskPolicyError('INVALID_RETRY_POLICY', 'Retry delay is invalid.');
  return Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
}

const NON_RETRYABLE = new Set([
  'CANCELLED', 'REVIEW_BLOCKED', 'PERMISSION_DENIED', 'UNSAFE_STATE', 'UNSUPPORTED_STATE_VERSION', 'STATE_QUARANTINED',
  'STALE_TASK_OWNER', 'STALE_MAINTENANCE_EPOCH', 'STALE_WORKSPACE_LOCK_OWNER', 'WORKSPACE_EDIT_LOCK_AMBIGUOUS', 'PLAN_WRITE_VIOLATION', 'WORKSPACE_UNMEASURABLE',
]);

export function retryEligible(input: { task: DurableTaskRecord; errorCode: string; workspaceState: WorkspaceChangeState }): boolean {
  if (!input.task.retry.enabled || input.task.attempt >= input.task.retry.maxAttempts || NON_RETRYABLE.has(input.errorCode)) return false;
  if (input.task.mode !== 'plan' && input.workspaceState !== 'unchanged') return false;
  return true;
}

export function validateDependencyGraph(tasks: ReadonlyMap<string, Pick<DurableTaskRecord, 'id' | 'dependencyIds'>>): void {
  for (const task of tasks.values()) {
    for (const dependency of task.dependencyIds) if (!tasks.has(dependency)) throw new TaskPolicyError('DEPENDENCY_NOT_FOUND', `Dependency is missing for task ${task.id}.`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new TaskPolicyError('DEPENDENCY_CYCLE', 'Task dependency graph contains a cycle.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks.get(id)?.dependencyIds ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of tasks.keys()) visit(id);
}

export type DependencyReadiness = { state: 'ready' } | { state: 'waiting'; dependencyIds: string[] } | { state: 'blocked'; dependencyIds: string[] };

export function dependencyReadiness(task: DurableTaskRecord, tasks: ReadonlyMap<string, DurableTaskRecord>): DependencyReadiness {
  const dependencies = task.dependencyIds.map((id) => tasks.get(id));
  if (dependencies.some((item) => !item)) throw new TaskPolicyError('DEPENDENCY_NOT_FOUND', 'Task dependency is missing.');
  const blocked = dependencies.filter((item) => item && ['failed', 'cancelled', 'blocked'].includes(item.status)).map((item) => item?.id).filter((id): id is string => Boolean(id));
  if (blocked.length > 0) return { state: 'blocked', dependencyIds: blocked };
  const waiting = dependencies.filter((item) => item?.status !== 'completed').map((item) => item?.id).filter((id): id is string => Boolean(id));
  return waiting.length > 0 ? { state: 'waiting', dependencyIds: waiting } : { state: 'ready' };
}
