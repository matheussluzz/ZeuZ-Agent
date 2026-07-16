import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LEASE_POLICY,
  TaskPolicyError,
  assertTransition,
  dependencyReadiness,
  reclaimDecision,
  retryDelayMs,
  retryEligible,
  transitionTask,
  validateDependencyGraph,
  validateLeasePolicy,
} from '../src/task-policy.js';
import { TASK_SCHEMA_VERSION, assertTaskRecord, type DurableTaskRecord, type TaskStatus } from '../src/task-schema.js';

const NOW = '2026-01-02T03:04:05.000Z';

function task(id: string, status: TaskStatus = 'queued', dependencies: string[] = []): DurableTaskRecord {
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    revision: 0,
    id,
    rootCorrelationId: id,
    depth: 0,
    dependencyIds: dependencies,
    modelId: 'codex:gpt-5.6-luna@high',
    prompt: 'synthetic',
    requestedWorkspace: '/synthetic',
    mode: 'plan',
    status,
    attempt: status === 'queued' ? 0 : 1,
    retry: { enabled: false, maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 4_000 },
    artifacts: [],
    attempts: [],
    transitions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test('task transition policy accepts only the six-state graph and protects terminals', () => {
  const valid: Array<[TaskStatus, TaskStatus]> = [
    ['queued', 'running'], ['queued', 'blocked'], ['queued', 'cancelled'],
    ['running', 'blocked'], ['running', 'completed'], ['running', 'failed'], ['running', 'cancelled'],
    ['blocked', 'queued'], ['blocked', 'failed'], ['blocked', 'cancelled'],
  ];
  for (const [from, to] of valid) assert.doesNotThrow(() => assertTransition(from, to));
  for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
    assert.doesNotThrow(() => assertTransition(terminal, terminal));
    assert.throws(() => assertTransition(terminal, 'queued'), (error: unknown) => error instanceof TaskPolicyError && error.code === 'TERMINAL_TASK_MUTATION');
  }
  assert.throws(() => assertTransition('queued', 'completed'), /Invalid task transition/);
});

test('running transition requires current fenced owner and completion evidence', () => {
  const running = task('running', 'running');
  running.lease = {
    schemaVersion: 1, revision: 0, taskId: running.id, ownerId: 'owner', ownerPid: 1, hostId: 'host', instanceId: 'instance',
    fencingToken: 2, maintenanceEpoch: 3, claimedAt: NOW, heartbeatAt: NOW, expiresAt: '2026-01-02T03:06:05.000Z',
  };
  assert.throws(() => transitionTask(running, 'failed', { at: NOW, ownerId: 'stale', fencingToken: 2 }), /stale/);
  assert.throws(() => transitionTask(running, 'completed', { at: NOW, ownerId: 'owner', fencingToken: 2 }), /result/i);
  running.result = { schemaVersion: 1, path: 'results/result.txt', sha256: 'a'.repeat(64), byteCount: 2, maxBytes: 100, truncated: false, unsafeCompletion: false, createdAt: NOW };
  const completed = transitionTask(running, 'completed', { at: NOW, ownerId: 'owner', fencingToken: 2 });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.revision, 0);
  assert.equal(completed.transitions[0]?.ownerFingerprint?.length, 16);
});

test('lease validation and conservative reclaim distinguish dead from ambiguous owners', () => {
  assert.deepEqual(validateLeasePolicy(DEFAULT_LEASE_POLICY), DEFAULT_LEASE_POLICY);
  assert.throws(() => validateLeasePolicy({ heartbeatMs: 0, leaseMs: 10, maxWorkers: 3 }), /positive/);
  assert.throws(() => validateLeasePolicy({ heartbeatMs: 10, leaseMs: 10, maxWorkers: 3 }), /shorter/);
  const lease = { ...task('lease'), schemaVersion: 1 as const };
  void lease;
  const actualLease = {
    schemaVersion: 1 as const, revision: 0, taskId: 'lease', ownerId: 'owner', ownerPid: 1, hostId: 'host', instanceId: 'instance',
    fencingToken: 1, maintenanceEpoch: 0, claimedAt: NOW, heartbeatAt: NOW, expiresAt: '2026-01-02T03:05:00.000Z',
  };
  const expired = Date.parse('2026-01-02T03:05:01.000Z');
  assert.equal(reclaimDecision(actualLease, expired, 'dead'), 'reclaim');
  assert.equal(reclaimDecision(actualLease, expired, 'alive'), 'retain');
  assert.equal(reclaimDecision(actualLease, expired, 'potentially_alive'), 'retain');
  assert.equal(reclaimDecision(actualLease, expired, 'unknown'), 'block_ambiguous');
});

test('dependency DAG rejects missing and cyclic edges and computes readiness', () => {
  const a = task('a', 'completed');
  const b = task('b', 'queued', ['a']);
  const c = task('c', 'queued', ['a', 'b']);
  const graph = new Map([['a', a], ['b', b], ['c', c]]);
  assert.doesNotThrow(() => validateDependencyGraph(graph));
  assert.deepEqual(dependencyReadiness(b, graph), { state: 'ready' });
  assert.deepEqual(dependencyReadiness(c, graph), { state: 'waiting', dependencyIds: ['b'] });
  b.status = 'failed';
  assert.deepEqual(dependencyReadiness(c, graph), { state: 'blocked', dependencyIds: ['b'] });
  assert.throws(() => validateDependencyGraph(new Map([['a', task('a', 'queued', ['missing'])]])), /missing/);
  assert.throws(() => validateDependencyGraph(new Map([['a', task('a', 'queued', ['b'])], ['b', task('b', 'queued', ['a'])]])), /cycle/);
});

test('retry is bounded, typed, and writable attempts require unchanged evidence', () => {
  const retrying = task('retry', 'running');
  retrying.retry = { enabled: true, maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 2_500 };
  retrying.attempt = 1;
  assert.equal(retryDelayMs(1, 1_000, 2_500), 1_000);
  assert.equal(retryDelayMs(3, 1_000, 2_500), 2_500);
  assert.equal(retryEligible({ task: retrying, errorCode: 'TRANSIENT_PROVIDER_FAILURE', workspaceState: 'unchanged' }), true);
  assert.equal(retryEligible({ task: retrying, errorCode: 'REVIEW_BLOCKED', workspaceState: 'unchanged' }), false);
  retrying.mode = 'agent';
  assert.equal(retryEligible({ task: retrying, errorCode: 'TRANSIENT_PROVIDER_FAILURE', workspaceState: 'changed' }), false);
  assert.equal(retryEligible({ task: retrying, errorCode: 'TRANSIENT_PROVIDER_FAILURE', workspaceState: 'unmeasurable' }), false);
});

test('runtime task schema rejects unknown nested fields and malformed evidence', () => {
  const retry = structuredClone(task('narrow-retry')) as DurableTaskRecord & { retry: DurableTaskRecord['retry'] & { surprise?: boolean } };
  retry.retry.surprise = true;
  assert.throws(() => assertTaskRecord(retry), /unknown fields/);

  const running = task('narrow-lease', 'running') as DurableTaskRecord & { lease?: DurableTaskRecord['lease'] & { secret?: string } };
  running.lease = {
    schemaVersion: 1, revision: 0, taskId: running.id, ownerId: 'owner', ownerPid: 1, hostId: 'host', instanceId: 'instance',
    fencingToken: 1, maintenanceEpoch: 0, claimedAt: NOW, heartbeatAt: NOW, expiresAt: '2026-01-02T03:05:05.000Z', secret: 'unexpected',
  };
  assert.throws(() => assertTaskRecord(running), /unknown fields/);
});
