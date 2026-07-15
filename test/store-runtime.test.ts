import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { makeMessage, SessionStore } from '../src/session-store.js';
import { TaskStore } from '../src/task-store.js';
import type { RuntimeSeams } from '../src/runtime.js';

function fixedRuntime(): RuntimeSeams {
  let id = 0;
  return {
    now: () => '2026-01-02T03:04:05.000Z',
    nowMs: () => 1_767_322_245_000,
    newId: () => `fixed-id-${++id}`,
    fingerprint: () => 'fixed-fingerprint',
  };
}

test('SessionStore accepts deterministic root, clock, and IDs while preserving persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-fixed-session-'));
  const runtime = fixedRuntime();
  try {
    const store = new SessionStore({ root, runtime });
    const session = await store.create('/workspace', { title: 'Fixed' });
    session.messages.push(makeMessage('user', 'hello', undefined, runtime));
    await store.save(session);

    const loaded = await store.load(session.id);
    assert.equal(loaded.id, 'fixed-id-1');
    assert.equal(loaded.createdAt, '2026-01-02T03:04:05.000Z');
    assert.equal(loaded.updatedAt, '2026-01-02T03:04:05.000Z');
    assert.equal(loaded.messages[0]?.id, 'fixed-id-2');

    const fork = await store.fork(loaded, 'Fork');
    assert.equal(fork.id, 'fixed-id-4');
    assert.equal(fork.messages[0]?.id, 'fixed-id-3');
    assert.equal(fork.parentId, loaded.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TaskStore accepts deterministic root, clock, and IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-fixed-task-'));
  const runtime = fixedRuntime();
  try {
    const store = new TaskStore({ root, runtime });
    const task = await store.create({
      modelId: 'codex:gpt-5.6-sol@medium',
      prompt: 'fixture task',
      cwd: '/workspace',
      mode: 'plan',
    });
    assert.equal(task.id, 'fixed-id-1');
    assert.equal(task.createdAt, '2026-01-02T03:04:05.000Z');
    assert.equal(task.updatedAt, '2026-01-02T03:04:05.000Z');
    assert.equal((await store.list())[0]?.id, task.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
