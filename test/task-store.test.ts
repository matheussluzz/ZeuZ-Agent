import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MaintenanceStore } from '../src/maintenance-store.js';
import { TaskResultStore } from '../src/task-result-store.js';
import { TaskStore, TaskStoreError } from '../src/task-store.js';

const NOW = '2026-01-02T03:04:05.000Z';
function runtime(constantId?: string) { let id = 0; return { now: () => NOW, nowMs: () => Date.parse(NOW), newId: () => constantId ?? `task-${++id}`, fingerprint: () => 'fingerprint' }; }
function input(prompt = 'task') { return { modelId: 'codex:gpt-5.6-luna@high', prompt, cwd: '/synthetic', mode: 'plan' as const }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test('TaskStore creates versioned records exclusively and migrates strict v0 into a backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-task-store-'));
  try {
    const store = new TaskStore({ root, runtime: runtime('same-id') });
    const task = await store.create(input('first'));
    assert.equal(task.schemaVersion, 1);
    assert.equal(task.revision, 0);
    await assert.rejects(() => store.create(input('collision')), /already exists/);

    const legacy = { id: 'legacy-id', modelId: 'codex:gpt-5.6-luna@high', prompt: 'legacy', cwd: '/synthetic', mode: 'plan', status: 'completed', createdAt: NOW, updatedAt: NOW };
    await writeFile(join(root, 'tasks', 'legacy-id.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const listed = await store.migrateAll();
    const migrated = listed.records.find((item) => item.id === 'legacy-id');
    assert.equal(migrated?.status, 'blocked');
    assert.equal(migrated?.blockedCode, 'LEGACY_RESULT_UNAVAILABLE');
    assert.equal(listed.diagnostics.some((item) => item.code === 'LEGACY_STATE_MIGRATED'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('claim, heartbeat, cancel, and stale fencing are revision-protected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-task-owner-'));
  try {
    const store = new TaskStore({ root, runtime: runtime() });
    const queued = await store.create(input());
    const owner = TaskStore.localOwner('owner', 'instance');
    const running = await store.claim(queued.id, queued.revision, owner, 120_000);
    assert.equal(running.status, 'running');
    assert.equal(running.lease?.fencingToken, 1);
    await assert.rejects(() => store.heartbeat(running.id, running.revision, 'stale', 1, 0, 120_000), /stale/);
    const heartbeat = await store.heartbeat(running.id, running.revision, 'owner', 1, 0, 120_000);
    const requested = await store.requestCancel(heartbeat.id, 'user');
    assert.ok(requested.cancelRequestedAt);
    await assert.rejects(() => store.complete(requested.id, requested.revision, 'owner', 1, 0, {
      result: { schemaVersion: 1, path: 'results/x/1.txt', sha256: 'a'.repeat(64), byteCount: 1, maxBytes: 10, truncated: false, unsafeCompletion: false, createdAt: NOW },
      artifacts: [],
      attemptEvidence: { before: { policy: 'wave-03-v1', kind: 'git', measurable: true, fingerprint: 'x' }, after: { policy: 'wave-03-v1', kind: 'git', measurable: true, fingerprint: 'x' }, state: 'unchanged' },
    }), (error: unknown) => error instanceof TaskStoreError && error.code === 'CANCEL_ALREADY_REQUESTED');
    const cancelled = await store.cancelRunning(requested.id, requested.revision, 'owner', 1, 0);
    assert.equal(cancelled.status, 'cancelled');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dependencies, durable depth, and maintenance epoch fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-task-dependency-'));
  try {
    const store = new TaskStore({ root, runtime: runtime() });
    const dependency = await store.create(input('dependency'));
    const child = await store.create({ ...input('child'), dependencyIds: [dependency.id] });
    await assert.rejects(() => store.claim(child.id, child.revision, TaskStore.localOwner('owner', 'instance'), 120_000), (error: unknown) => error instanceof TaskStoreError && error.code === 'DEPENDENCY_WAITING');
    const parent = await store.create(input('parent'));
    const nested = await store.create({ ...input('nested'), parentTaskId: parent.id });
    await assert.rejects(() => store.create({ ...input('too-deep'), parentTaskId: nested.id }), (error: unknown) => error instanceof TaskStoreError && error.code === 'DELEGATION_DEPTH_EXCEEDED');
    const maintenance = await store.enterMaintenance('migration');
    assert.equal(maintenance.active, true);
    await assert.rejects(() => store.claim(parent.id, parent.revision, TaskStore.localOwner('other', 'instance'), 120_000), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'MAINTENANCE_ACTIVE'));
    assert.equal((await store.exitMaintenance()).active, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupted root maintenance remains fenced and resumes idempotently by reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-task-maintenance-resume-'));
  try {
    const store = new TaskStore({ root, runtime: runtime() });
    const queued = await store.create(input('queued'));
    await assert.rejects(() => store.withMaintenance('state_migration', async () => { throw new Error('injected migration interruption'); }), /interruption/);
    await assert.rejects(() => store.claim(queued.id, queued.revision, TaskStore.localOwner('owner', 'instance'), 120_000), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'MAINTENANCE_ACTIVE'));
    const result = await store.withMaintenance('state_migration', async () => 'resumed');
    assert.equal(result, 'resumed');
    assert.equal((await store.enterMaintenance('first_operation')).active, true);
    await assert.rejects(() => store.enterMaintenance('different_operation'), (error: unknown) => error instanceof TaskStoreError && error.code === 'MAINTENANCE_ACTIVE');
    await store.exitMaintenance();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('root maintenance epoch rejects stale terminal writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-task-maintenance-fence-'));
  try {
    const rt = runtime();
    const store = new TaskStore({ root, runtime: rt });
    const queued = await store.create(input('running'));
    const running = await store.claim(queued.id, queued.revision, TaskStore.localOwner('owner', 'instance'), 120_000);
    await new MaintenanceStore(root, rt).enter('state_migration');
    await assert.rejects(() => store.fail(running.id, running.revision, 'owner', running.lease!.fencingToken, running.lease!.maintenanceEpoch, 'TRANSIENT_PROVIDER_FAILURE', 'must not settle'), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && ['STALE_MAINTENANCE_EPOCH', 'MAINTENANCE_ACTIVE'].includes(String(error.code))));
    assert.equal((await store.load(running.id)).status, 'running');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('maintenance activation waits for an in-flight stable-epoch mutation gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-maintenance-serialization-'));
  try {
    const maintenance = new MaintenanceStore(root, runtime());
    await maintenance.initialize();
    const entered = deferred();
    const release = deferred();
    const mutation = maintenance.withStableEpoch(undefined, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    let activated = false;
    const activation = maintenance.enter('state_migration').then((record) => { activated = true; return record; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    assert.equal(activated, false);
    release.resolve();
    await mutation;
    assert.equal((await activation).active, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancel and completion terminal intents are idempotent only when equivalent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-task-terminal-intent-'));
  try {
    const store = new TaskStore({ root, runtime: runtime() });
    const beforeClaim = await store.create(input('cancel before claim'));
    const cancelled = await store.requestCancel(beforeClaim.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await store.requestCancel(beforeClaim.id)).revision, cancelled.revision);

    const queued = await store.create(input('complete once'));
    const running = await store.claim(queued.id, queued.revision, TaskStore.localOwner('owner', 'instance'), 120_000);
    const resultStore = new TaskResultStore({ root, now: () => NOW });
    const foreign = await resultStore.persist('foreign-task', running.attempt, 'foreign');
    const snapshot = { policy: 'wave-03-v1' as const, kind: 'git' as const, measurable: true, fingerprint: 'same' };
    await assert.rejects(() => store.complete(running.id, running.revision, 'owner', running.lease!.fencingToken, running.lease!.maintenanceEpoch, { result: foreign, artifacts: [], attemptEvidence: { before: snapshot, after: snapshot, state: 'unchanged' } }), /does not belong/i);
    const result = await resultStore.persist(running.id, running.attempt, 'x');
    const intent = { result, artifacts: [], attemptEvidence: { before: snapshot, after: snapshot, state: 'unchanged' as const } };
    const completed = await store.complete(running.id, running.revision, 'owner', running.lease!.fencingToken, running.lease!.maintenanceEpoch, intent);
    assert.equal((await store.complete(running.id, running.revision, 'owner', running.lease!.fencingToken, running.lease!.maintenanceEpoch, intent)).revision, completed.revision);
    await assert.rejects(() => store.complete(running.id, completed.revision, 'owner', running.lease!.fencingToken, running.lease!.maintenanceEpoch, { ...intent, artifacts: [{ path: 'changed.txt', kind: 'created', status: 'captured' }] }), (error: unknown) => error instanceof TaskStoreError && error.code === 'DUPLICATE_COMPLETION_CONFLICT');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent orphan reclaim admits one proven-dead expired owner and fences the loser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-task-reclaim-race-'));
  try {
    let nowMs = Date.parse(NOW);
    let id = 0;
    const rt = { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs, newId: () => `reclaim-${++id}`, fingerprint: () => 'fingerprint' };
    const store = new TaskStore({ root, runtime: rt });
    const queued = await store.create({ ...input('reclaim'), retry: { enabled: true, maxAttempts: 2 } });
    const running = await store.claim(queued.id, queued.revision, { ownerId: 'dead-owner', ownerPid: 42, hostId: 'synthetic', instanceId: 'old' }, 100);
    await assert.rejects(() => store.recoverOrphan(running.id, running.revision, 'dead-owner', running.lease!.fencingToken, 'unchanged', 'dead'), (error: unknown) => error instanceof TaskStoreError && error.code === 'ORPHAN_RECLAIM_DENIED');
    nowMs += 101;
    const settled = await Promise.allSettled([
      store.recoverOrphan(running.id, running.revision, 'dead-owner', running.lease!.fencingToken, 'unchanged', 'dead'),
      store.recoverOrphan(running.id, running.revision, 'dead-owner', running.lease!.fencingToken, 'unchanged', 'dead'),
    ]);
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((item) => item.status === 'rejected').length, 1);
    assert.equal((await store.load(running.id)).status, 'queued');
  } finally { await rm(root, { recursive: true, force: true }); }
});
