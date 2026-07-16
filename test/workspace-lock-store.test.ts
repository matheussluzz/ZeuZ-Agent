import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { RuntimeSeams } from '../src/runtime.js';
import { WorkspaceLockStore } from '../src/workspace-lock-store.js';

const NOW = Date.parse('2026-01-02T03:04:05.000Z');

function clock() {
  let current = NOW;
  let id = 0;
  return {
    runtime: { now: () => new Date(current).toISOString(), nowMs: () => current, newId: () => `workspace-lock-${++id}`, fingerprint: () => 'fingerprint' } satisfies RuntimeSeams,
    advance(ms: number) { current += ms; },
  };
}

test('non-Git workspace lock is CAS-reclaimed only after expiry and proven-dead ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-workspace-lock-state-'));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'zeuz-workspace-lock-workspace-')));
  try {
    const time = clock();
    let probe: 'alive' | 'dead' | 'unknown' = 'alive';
    const store = new WorkspaceLockStore(root, time.runtime, () => probe);
    const first = await store.acquire('a'.repeat(64), workspace, 'task-one', { ownerId: 'owner-one', ownerPid: 11, hostId: 'local' }, 1_000);
    assert.equal(first.status, 'acquired');
    assert.equal((await store.acquire('a'.repeat(64), workspace, 'task-two', { ownerId: 'owner-two', ownerPid: 22, hostId: 'local' }, 1_000)).status, 'locked');
    time.advance(1_001);
    assert.equal((await store.acquire('a'.repeat(64), workspace, 'task-two', { ownerId: 'owner-two', ownerPid: 22, hostId: 'local' }, 1_000)).status, 'locked');
    probe = 'dead';
    const reclaimed = await store.acquire('a'.repeat(64), workspace, 'task-two', { ownerId: 'owner-two', ownerPid: 22, hostId: 'local' }, 1_000);
    assert.equal(reclaimed.status, 'acquired');
    if (first.status === 'acquired') await first.handle.release();
    assert.equal((await store.acquire('a'.repeat(64), workspace, 'task-three', { ownerId: 'owner-three', ownerPid: 33, hostId: 'local' }, 1_000)).status, 'locked');
    if (reclaimed.status === 'acquired') await reclaimed.handle.release();
    assert.equal((await store.acquire('a'.repeat(64), workspace, 'task-three', { ownerId: 'owner-three', ownerPid: 33, hostId: 'local' }, 1_000)).status, 'acquired');
  } finally { await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
});

test('expired unknown ownership blocks while heartbeat extends the current lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-workspace-lock-ambiguous-'));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'zeuz-workspace-lock-workspace-')));
  try {
    const time = clock();
    const store = new WorkspaceLockStore(root, time.runtime, () => 'unknown');
    const acquired = await store.acquire('b'.repeat(64), workspace, 'task-one', { ownerId: 'owner-one', ownerPid: 11, hostId: 'remote' }, 1_000);
    assert.equal(acquired.status, 'acquired');
    time.advance(900);
    if (acquired.status === 'acquired') await acquired.handle.heartbeat(1_000);
    time.advance(900);
    assert.equal((await store.acquire('b'.repeat(64), workspace, 'task-two', { ownerId: 'owner-two', ownerPid: 22, hostId: 'local' }, 1_000)).status, 'locked');
    time.advance(101);
    assert.equal((await store.acquire('b'.repeat(64), workspace, 'task-two', { ownerId: 'owner-two', ownerPid: 22, hostId: 'local' }, 1_000)).status, 'ambiguous');
  } finally { await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
});
