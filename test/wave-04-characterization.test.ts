import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RuntimeSeams } from '../src/runtime.js';
import { SessionStore } from '../src/session-store.js';
import { TaskStore } from '../src/task-store.js';
import type { TaskRecord } from '../src/types.js';

const NOW = '2026-01-02T03:04:05.000Z';
const NOW_MS = Date.parse(NOW);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runtime(options: { constantId?: string } = {}): RuntimeSeams {
  let id = 0;
  return {
    now: () => NOW,
    nowMs: () => NOW_MS,
    newId: () => options.constantId ?? `wave04-id-${++id}`,
    fingerprint: () => 'wave04-characterization-fingerprint',
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

function taskInput(prompt: string) {
  return {
    modelId: 'codex:gpt-5.6-luna@high',
    prompt,
    cwd: '/synthetic/workspace',
    mode: 'plan' as const,
  };
}

test('[wave04 characterization] task and session records are unversioned mutable legacy snapshots', async () => {
  const root = await temporaryRoot('zeuz-wave04-shapes-');
  try {
    const tasks = new TaskStore({ root, runtime: runtime() });
    const task = await tasks.create(taskInput('legacy task'));
    const taskJson = JSON.parse(await readFile(join(root, 'tasks', `${task.id}.json`), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(taskJson).sort(), ['createdAt', 'cwd', 'id', 'mode', 'modelId', 'prompt', 'status', 'updatedAt']);
    assert.equal(taskJson.status, 'queued');
    for (const absent of ['schemaVersion', 'revision', 'attempt', 'dependencies', 'owner', 'lease', 'result', 'artifacts', 'transitionHistory']) {
      assert.equal(Object.hasOwn(taskJson, absent), false, absent);
    }

    const sessions = new SessionStore({ root, runtime: runtime() });
    const session = await sessions.create('/synthetic/workspace', { title: 'Legacy session' });
    const sessionJson = JSON.parse(await readFile(join(root, 'sessions', `${session.id}.json`), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(sessionJson).sort(), [
      'activeModelId', 'createdAt', 'cwd', 'id', 'messages', 'permissionMode', 'providerSessions', 'title', 'updatedAt',
    ]);
    assert.equal(Object.hasOwn(sessionJson, 'schemaVersion'), false);
    assert.equal(Object.hasOwn(sessionJson, 'revision'), false);
    assert.equal((await sessions.load(session.id)).id, session.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[wave04 characterization] TaskStore performs no runtime state or transition validation', async () => {
  const root = await temporaryRoot('zeuz-wave04-status-');
  try {
    const store = new TaskStore({ root, runtime: runtime() });
    const observed = ['queued', 'running', 'completed', 'failed', 'blocked'];
    for (const status of observed) {
      const task = await store.create(taskInput(`status ${status}`));
      (task as unknown as { status: string }).status = status;
      await store.save(task);
    }
    const listed = await store.list();
    assert.deepEqual(new Set(listed.map((task) => task.status)), new Set(observed));
    const completed = listed.find((task) => task.status === 'completed');
    assert.equal(completed?.resultPreview, undefined);
    const running = listed.find((task) => task.status === 'running') as TaskRecord & { owner?: unknown; lease?: unknown };
    assert.equal(running.owner, undefined);
    assert.equal(running.lease, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[wave04 characterization] stores silently skip malformed JSON but return parseable incomplete records', async () => {
  const root = await temporaryRoot('zeuz-wave04-corrupt-');
  try {
    const tasks = new TaskStore({ root, runtime: runtime() });
    const healthyTask = await tasks.create(taskInput('healthy'));
    await writeFile(join(root, 'tasks', 'corrupt.json'), '{"id":', { mode: 0o600 });
    await writeFile(join(root, 'tasks', 'incomplete.json'), `${JSON.stringify({ id: 'incomplete-task', updatedAt: '2026-01-02T03:04:06.000Z' })}\n`, { mode: 0o600 });
    const taskList = await tasks.list();
    assert.equal(taskList.some((task) => task.id === healthyTask.id), true);
    assert.equal(taskList.some((task) => task.id === 'corrupt'), false);
    assert.equal(taskList.some((task) => task.id === 'incomplete-task'), true);

    const sessions = new SessionStore({ root, runtime: runtime() });
    const healthySession = await sessions.create('/synthetic/workspace');
    await writeFile(join(root, 'sessions', 'corrupt.json'), '{"id":', { mode: 0o600 });
    await writeFile(join(root, 'sessions', 'incomplete.json'), `${JSON.stringify({ id: 'incomplete-session', updatedAt: '2026-01-02T03:04:06.000Z' })}\n`, { mode: 0o600 });
    const sessionList = await sessions.list();
    assert.equal(sessionList.some((session) => session.id === healthySession.id), true);
    assert.equal(sessionList.some((session) => session.id === 'corrupt'), false);
    assert.equal(sessionList.some((session) => session.id === 'incomplete-session'), true);

    assert.equal(await stat(join(root, 'tasks', 'corrupt.json')).then(() => true), true);
    assert.equal(await stat(join(root, 'sessions', 'corrupt.json')).then(() => true), true);
    await assert.rejects(() => stat(join(root, 'quarantine')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[wave04 characterization] duplicate create IDs overwrite the final task and session records', async () => {
  const root = await temporaryRoot('zeuz-wave04-collision-');
  try {
    const tasks = new TaskStore({ root, runtime: runtime({ constantId: 'duplicate-id' }) });
    await tasks.create(taskInput('first prompt'));
    await tasks.create(taskInput('second prompt'));
    const taskFiles = await readdir(join(root, 'tasks'));
    assert.deepEqual(taskFiles, ['duplicate-id.json']);
    assert.equal((JSON.parse(await readFile(join(root, 'tasks', 'duplicate-id.json'), 'utf8')) as { prompt: string }).prompt, 'second prompt');

    const sessions = new SessionStore({ root, runtime: runtime({ constantId: 'duplicate-session' }) });
    await sessions.create('/synthetic/workspace', { title: 'First title' });
    await sessions.create('/synthetic/workspace', { title: 'Second title' });
    const sessionFiles = await readdir(join(root, 'sessions'));
    assert.deepEqual(sessionFiles, ['duplicate-session.json']);
    assert.equal((JSON.parse(await readFile(join(root, 'sessions', 'duplicate-session.json'), 'utf8')) as { title: string }).title, 'Second title');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[wave04 characterization] save accepts two stale snapshots and last writer replaces without CAS', async () => {
  const root = await temporaryRoot('zeuz-wave04-cas-');
  try {
    const store = new TaskStore({ root, runtime: runtime() });
    const original = await store.create(taskInput('original'));
    const first = { ...original, prompt: 'first writer' };
    const second = { ...original, prompt: 'second writer' };
    await store.save(first);
    await store.save(second);
    const final = (await store.list()).find((task) => task.id === original.id);
    assert.equal(final?.prompt, 'second writer');
    assert.equal(Object.hasOwn(final ?? {}, 'revision'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[wave04 characterization] concurrency is represented by exactly three PID and timestamp lock files', async () => {
  const root = await temporaryRoot('zeuz-wave04-locks-');
  const releases: Array<() => Promise<void>> = [];
  try {
    const store = new TaskStore({ root, runtime: runtime() });
    releases.push(await store.acquireSlot(), await store.acquireSlot(), await store.acquireSlot());
    assert.deepEqual((await readdir(join(root, 'runtime'))).sort(), ['delegate-0.lock', 'delegate-1.lock', 'delegate-2.lock']);
    for (let slot = 0; slot < 3; slot += 1) {
      const path = join(root, 'runtime', `delegate-${slot}.lock`);
      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      assert.deepEqual(lines, [String(process.pid), String(NOW_MS)]);
      if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    for (const release of releases.reverse()) await release();
    await rm(root, { recursive: true, force: true });
  }
});

test('[wave04 characterization] an old mtime is reclaimed without heartbeat, token, or owner liveness proof', async () => {
  const root = await temporaryRoot('zeuz-wave04-stale-lock-');
  try {
    const store = new TaskStore({ root, runtime: runtime() });
    await store.initialize();
    const runtimeDir = join(root, 'runtime');
    for (let slot = 0; slot < 3; slot += 1) {
      const path = join(runtimeDir, `delegate-${slot}.lock`);
      await writeFile(path, '999999\n0\n', { mode: 0o600 });
      await chmod(path, 0o600);
      const timestamp = new Date(slot === 0 ? NOW_MS - 31 * 60 * 1000 : NOW_MS);
      await utimes(path, timestamp, timestamp);
    }
    const release = await store.acquireSlot();
    assert.deepEqual((await readFile(join(runtimeDir, 'delegate-0.lock'), 'utf8')).trim().split('\n'), [String(process.pid), String(NOW_MS)]);
    await release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[wave04 characterization] unsafe lock inspection is swallowed and the next filename is used', async () => {
  const root = await temporaryRoot('zeuz-wave04-lock-race-');
  try {
    const store = new TaskStore({ root, runtime: runtime() });
    await store.initialize();
    const runtimeDir = join(root, 'runtime');
    await writeFile(join(runtimeDir, 'lock-target'), 'synthetic\n', { mode: 0o600 });
    await symlink(join(runtimeDir, 'lock-target'), join(runtimeDir, 'delegate-0.lock'));
    const release = await store.acquireSlot();
    assert.deepEqual((await readdir(runtimeDir)).sort(), ['delegate-0.lock', 'delegate-1.lock', 'lock-target']);
    await release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[wave04 characterization] delegate and /tasks remain blocking, environment-depth, preview-only source paths', () => {
  const cli = readFileSync(join(repositoryRoot, 'src', 'cli.tsx'), 'utf8');
  const ui = readFileSync(join(repositoryRoot, 'src', 'ui.tsx'), 'utf8');

  const acquireIndex = cli.indexOf('release = await taskStore.acquireSlot()');
  const askIndex = cli.indexOf('const outcome = await controller.ask');
  const completedIndex = cli.indexOf("taskRecord.status = 'completed'");
  assert.ok(acquireIndex >= 0 && askIndex > acquireIndex && completedIndex > askIndex);
  assert.match(cli, /process\.env\.ZEUZ_DELEGATION_DEPTH/);
  assert.match(cli, /if \(depth >= 1\)/);
  assert.match(cli, /outcome\.response\.slice\(0, 500\)/);
  assert.match(cli, /taskRecord\.error = error instanceof Error \? error\.message : String\(error\)/);
  assert.doesNotMatch(cli, /--wait/);
  assert.doesNotMatch(cli, /command === 'task'/);

  assert.match(ui, /new TaskStore\(\)\.list\(\)/);
  assert.match(ui, /task\.prompt\.slice\(0, 160\)/);
  assert.doesNotMatch(ui, /task result|task cancel|task wait/i);
});
