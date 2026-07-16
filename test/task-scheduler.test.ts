import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TaskScheduler } from '../src/task-scheduler.js';

function runtime(now = '2026-01-02T03:04:05.000Z') { let id = 0; return { now: () => now, nowMs: () => Date.parse(now), newId: () => `id-${++id}` }; }

test('scheduler atomically admits three workers and queues the fourth until release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-scheduler-'));
  try {
    const schedulers = [0, 1, 2, 3].map(() => new TaskScheduler(root, runtime()));
    const admitted = await Promise.all(schedulers.map((scheduler, index) => scheduler.acquire(`task-${index}`, `owner-${index}`, 120_000)));
    assert.equal(admitted.filter(Boolean).length, 3);
    assert.equal(admitted.filter((value) => !value).length, 1);
    const blocked = admitted.findIndex((value) => !value);
    const releasing = admitted.findIndex(Boolean);
    await schedulers[releasing]?.release(`task-${releasing}`, `owner-${releasing}`);
    assert.equal(await schedulers[blocked]?.acquire(`task-${blocked}`, `owner-${blocked}`, 120_000), true);
    assert.equal(await schedulers[0]?.count(), 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scheduler recovers only expired proven-dead pre-claim slots and exposes ambiguity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-scheduler-recovery-'));
  try {
    const before = runtime('2026-01-02T03:04:05.000Z');
    const scheduler = new TaskScheduler(root, before, 3, () => ({ ownerPid: 101, hostId: 'local' }));
    assert.equal(await scheduler.acquire('dead-task', 'dead-owner', 1_000), true);
    const unknown = new TaskScheduler(root, before, 3, () => ({ ownerPid: 202, hostId: 'remote' }));
    assert.equal(await unknown.acquire('unknown-task', 'unknown-owner', 1_000), true);

    const after = new TaskScheduler(root, runtime('2026-01-02T03:04:07.000Z'));
    const result = await after.recoverExpired((host) => host === 'local' ? 'dead' : 'unknown');
    assert.deepEqual(result.released, ['dead-task']);
    assert.deepEqual(result.ambiguous, ['unknown-task']);
    assert.equal(await after.count(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
