import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

test('stores reject a symlinked state root', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'zeuz-state-root-'));
  const target = join(fixture, 'target');
  const root = join(fixture, 'state-link');
  try {
    await mkdir(target, { mode: 0o700 });
    await symlink(target, root);
    await assert.rejects(() => new SessionStore({ root, runtime: fixedRuntime() }).create('/workspace'), /State container must be a real non-symlink directory/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('stores reject an existing permissive private state directory', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-mode-'));
  try {
    await mkdir(join(root, 'sessions'), { mode: 0o755 });
    await assert.rejects(() => new SessionStore({ root, runtime: fixedRuntime() }).create('/workspace'), /must be owner-only \(0700\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stores reject group/world-readable persisted state files', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-file-mode-'));
  try {
    const store = new SessionStore({ root, runtime: fixedRuntime() });
    const session = await store.create('/workspace');
    await chmod(join(root, 'sessions', `${session.id}.json`), 0o644);
    await assert.rejects(() => store.list(), /must be owner-only \(0600\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stores reject symlinked persisted state files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-file-link-'));
  const target = join(root, 'outside-record');
  try {
    const store = new TaskStore({ root, runtime: fixedRuntime() });
    await store.initialize();
    await writeFile(target, '{}\n', { mode: 0o600 });
    await symlink(target, join(root, 'tasks', 'linked.json'));
    await assert.rejects(() => store.list(), /regular non-symlink file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
