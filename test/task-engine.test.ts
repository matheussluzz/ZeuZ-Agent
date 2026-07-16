import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { TaskEngine, parseGitArtifactEntries, probeOwner, type TaskExecutor, type WorkerLauncher } from '../src/task-engine.js';
import { TaskStore } from '../src/task-store.js';
import type { DurableTaskRecord } from '../src/task-schema.js';
import type { RuntimeSeams } from '../src/runtime.js';
import type { WorkspaceSnapshot } from '../src/workspace.js';

const NOW = '2026-01-02T03:04:05.000Z';
const unchanged: WorkspaceSnapshot = { policy: 'wave-03-v1', kind: 'non_git', measurable: true, fingerprint: 'same' };

function runtime(measure: () => WorkspaceSnapshot = () => unchanged): RuntimeSeams {
  let id = 0;
  return { now: () => NOW, nowMs: () => Date.parse(NOW), newId: () => `engine-task-${++id}`, fingerprint: () => 'same', measureWorkspace: measure };
}

function mutableRuntime(start = Date.parse(NOW)) {
  let current = start;
  let id = 0;
  return {
    runtime: { now: () => new Date(current).toISOString(), nowMs: () => current, newId: () => `mutable-task-${++id}`, fingerprint: () => 'same', measureWorkspace: () => unchanged } satisfies RuntimeSeams,
    advance(ms: number) { current += ms; },
  };
}

class RecordingLauncher implements WorkerLauncher {
  ids: string[] = [];
  constructor(private readonly result = false) {}
  async launch(taskId: string): Promise<boolean> { this.ids.push(taskId); return this.result; }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('NUL-delimited Git artifact evidence preserves spaces and skips rename sources', () => {
  assert.deepEqual(parseGitArtifactEntries('?? file with space.txt\0R  new name.txt\0old name.txt\0 D removed.txt\0'), [
    { path: 'file with space.txt', kind: 'created' },
    { path: 'new name.txt', kind: 'modified' },
    { path: 'removed.txt', kind: 'removed' },
  ]);
});

test('submit is durable before launcher return and restart executes queued work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-engine-restart-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-engine-workspace-'));
  try {
    const rt = runtime();
    const launcher = new RecordingLauncher(false);
    const first = new TaskEngine({ root, runtime: rt, launcher });
    const submitted = await first.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'queued', cwd: workspace, mode: 'plan' });
    assert.equal(submitted.launched, false);
    assert.deepEqual(launcher.ids, [submitted.task.id]);
    assert.equal((await new TaskStore({ root, runtime: rt }).load(submitted.task.id)).status, 'queued');

    const restarted = new TaskEngine({ root, runtime: rt, launcher, executor: { execute: async () => ({ response: 'complete', modelId: 'codex:gpt-5.6-luna@high', changedWorkspace: false }) } });
    const completed = await restarted.runOne(submitted.task.id);
    assert.equal(completed.status, 'completed');
    assert.ok(completed.result);
  } finally { await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
});

test('three plan tasks execute concurrently and a fourth remains queued until a slot is free', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-engine-concurrency-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-engine-workspace-'));
  try {
    let active = 0;
    let maximum = 0;
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const threeActive = deferred();
    const executor: TaskExecutor = {
      async execute(task: DurableTaskRecord) {
        active += 1;
        maximum = Math.max(maximum, active);
        if (task.prompt === 'task 3') {
          active -= 1;
          return { response: task.id, modelId: task.modelId, changedWorkspace: false };
        }
        if (active === 3) threeActive.resolve();
        const gate = deferred();
        gates.set(task.id, gate);
        await gate.promise;
        active -= 1;
        return { response: task.id, modelId: task.modelId, changedWorkspace: false };
      },
    };
    const rt = runtime();
    const launcher = new RecordingLauncher(false);
    const engine = new TaskEngine({ root, runtime: rt, launcher, executor });
    const tasks = [];
    for (let index = 0; index < 4; index += 1) tasks.push((await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: `task ${index}`, cwd: workspace, mode: 'plan' })).task);
    const running = tasks.slice(0, 3).map((task) => engine.runOne(task.id));
    await threeActive.promise;
    const fourth = await engine.runOne(tasks[3]!.id);
    assert.equal(fourth.status, 'queued');
    assert.equal(maximum, 3);
    for (const gate of gates.values()) gate.resolve();
    const settled = await Promise.all(running);
    assert.deepEqual(settled.map((task) => task.status), ['completed', 'completed', 'completed']);
    const fourthCompleted = await engine.runOne(fourth.id);
    assert.equal(fourthCompleted.status, 'completed');
  } finally { await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
});

test('plan workspace mutation blocks completion and cross-process cancel reaches the worker poll', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-engine-workspace-'));
  const changedRoot = await mkdtemp(join(tmpdir(), 'zeuz-engine-plan-write-'));
  const cancelRoot = await mkdtemp(join(tmpdir(), 'zeuz-engine-cancel-'));
  try {
    let measurements = 0;
    const changedRuntime = runtime(() => ({ ...unchanged, fingerprint: measurements++ === 0 ? 'before' : 'after' }));
    const launcher = new RecordingLauncher(false);
    const changedEngine = new TaskEngine({ root: changedRoot, runtime: changedRuntime, launcher, executor: { execute: async (task) => ({ response: 'unsafe', modelId: task.modelId, changedWorkspace: true }) } });
    const changed = (await changedEngine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'write', cwd: workspace, mode: 'plan' })).task;
    const blockedPlan = await changedEngine.runOne(changed.id);
    assert.equal(blockedPlan.blockedCode, 'PLAN_WRITE_VIOLATION');
    assert.ok(blockedPlan.result);
    assert.equal(await new (await import('../src/task-result-store.js')).TaskResultStore({ root: changedRoot, now: () => NOW }).retrieve(blockedPlan.result!), 'unsafe');

    const rt = runtime();
    const started = deferred();
    const cancellingExecutor: TaskExecutor = {
      async execute(task, cwd, signal) {
        void task; void cwd;
        started.resolve();
        await new Promise<void>((_resolvePromise, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        throw new Error('unreachable');
      },
    };
    const cancelEngine = new TaskEngine({ root: cancelRoot, runtime: rt, launcher, executor: cancellingExecutor, heartbeatMs: 10, leaseMs: 100 });
    const cancelTask = (await cancelEngine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'cancel', cwd: workspace, mode: 'plan' })).task;
    const worker = cancelEngine.runOne(cancelTask.id);
    await started.promise;
    await new TaskStore({ root: cancelRoot, runtime: rt }).requestCancel(cancelTask.id);
    assert.equal((await worker).status, 'cancelled');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(changedRoot, { recursive: true, force: true });
    await rm(cancelRoot, { recursive: true, force: true });
  }
});

test('retry succeeds after typed transient failure while non-retryable errors settle failed', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-engine-retry-workspace-'));
  const retryRoot = await mkdtemp(join(tmpdir(), 'zeuz-engine-retry-'));
  const blockedRoot = await mkdtemp(join(tmpdir(), 'zeuz-engine-no-retry-'));
  try {
    const clock = mutableRuntime();
    let calls = 0;
    const retryEngine = new TaskEngine({
      root: retryRoot,
      runtime: clock.runtime,
      launcher: new RecordingLauncher(false),
      executor: { execute: async (task) => { calls += 1; if (calls === 1) throw Object.assign(new Error('temporary'), { code: 'TRANSIENT_PROVIDER_FAILURE' }); return { response: 'recovered', modelId: task.modelId, changedWorkspace: false }; } },
    });
    const retryTask = (await retryEngine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'retry', cwd: workspace, mode: 'plan', retry: { enabled: true, maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 1_000 } })).task;
    const queued = await retryEngine.runOne(retryTask.id);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.attempt, 1);
    clock.advance(1_000);
    assert.equal((await retryEngine.runOne(retryTask.id)).status, 'completed');
    assert.equal(calls, 2);

    const noRetryEngine = new TaskEngine({ root: blockedRoot, runtime: runtime(), launcher: new RecordingLauncher(false), executor: { execute: async () => { throw Object.assign(new Error('review'), { code: 'REVIEW_BLOCKED' }); } } });
    const noRetry = (await noRetryEngine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'no retry', cwd: workspace, mode: 'plan', retry: { enabled: true, maxAttempts: 3 } })).task;
    const failed = await noRetryEngine.runOne(noRetry.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'REVIEW_BLOCKED');
    assert.equal(failed.attempt, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(retryRoot, { recursive: true, force: true }); await rm(blockedRoot, { recursive: true, force: true }); }
});

test('startup recovery reclaims only expired proven-dead owners and fences the old writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-engine-recovery-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-engine-recovery-workspace-'));
  try {
    const clock = mutableRuntime();
    const store = new TaskStore({ root, runtime: clock.runtime });
    const queued = await store.create({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'recover', cwd: workspace, mode: 'plan', retry: { enabled: true, maxAttempts: 2 } });
    let running = await store.claim(queued.id, queued.revision, { ownerId: 'dead-owner', ownerPid: 4242, hostId: 'synthetic-host', instanceId: 'old' }, 100);
    running = await store.setExecutionIsolation(running.id, running.revision, 'dead-owner', running.lease!.fencingToken, running.lease!.maintenanceEpoch, { executionWorkspace: workspace });
    running = await store.recordAttemptStart(running.id, running.revision, 'dead-owner', running.lease!.fencingToken, running.lease!.maintenanceEpoch, unchanged);
    clock.advance(101);
    const engine = new TaskEngine({ root, runtime: clock.runtime, store, launcher: new RecordingLauncher(false), heartbeatMs: 10, leaseMs: 100, ownerProbe: () => 'dead', executor: { execute: async (task) => ({ response: 'ok', modelId: task.modelId, changedWorkspace: false }) } });
    const recovery = await engine.recover();
    assert.equal(recovery.reclaimed, 1);
    const recovered = await store.load(running.id);
    assert.equal(recovered.status, 'queued');
    await assert.rejects(() => store.heartbeat(running.id, recovered.revision, 'dead-owner', running.lease!.fencingToken, running.lease!.maintenanceEpoch, 100), /running|stale root maintenance epoch/i);
    assert.equal((await engine.recover()).reclaimed, 0);
  } finally { await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
});

test('owner probe maps injected alive, EPERM, ESRCH, and remote-host evidence conservatively', () => {
  const localHost = 'local';
  assert.equal(probeOwner(localHost, 1, { localHost, signal: () => undefined }), 'alive');
  assert.equal(probeOwner(localHost, 1, { localHost, signal: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }), 'potentially_alive');
  assert.equal(probeOwner(localHost, 1, { localHost, signal: () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); } }), 'dead');
  assert.equal(probeOwner('remote', 1, { localHost, signal: () => { throw new Error('must not run'); } }), 'unknown');
});

test('failed dependencies durably block queued dependents without launching them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-engine-dependency-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-engine-dependency-workspace-'));
  try {
    const launcher = new RecordingLauncher(false);
    const engine = new TaskEngine({ root, runtime: runtime(), launcher, executor: { execute: async () => { throw Object.assign(new Error('permanent'), { code: 'PERMISSION_DENIED' }); } } });
    const prerequisite = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'fail', cwd: workspace, mode: 'plan' })).task;
    const dependent = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'must not run', cwd: workspace, mode: 'plan', dependencyIds: [prerequisite.id] })).task;
    assert.equal((await engine.runOne(prerequisite.id)).status, 'failed');
    const blocked = await new TaskStore({ root, runtime: runtime() }).load(dependent.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'dependency');
    assert.equal(blocked.blockedCode, 'DEPENDENCY_BLOCKED');
  } finally { await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
});

test('non-Git editing serializes canonical workspace aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-engine-nongit-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-engine-nongit-workspace-'));
  const aliasRoot = await mkdtemp(join(tmpdir(), 'zeuz-engine-nongit-alias-'));
  const alias = join(aliasRoot, 'workspace-link');
  try {
    await symlink(workspace, alias);
    const started = deferred();
    const release = deferred();
    let executions = 0;
    const executor: TaskExecutor = { execute: async (task) => { executions += 1; if (executions === 1) { started.resolve(); await release.promise; } return { response: task.id, modelId: task.modelId, changedWorkspace: false }; } };
    const rt = runtime();
    const engine = new TaskEngine({ root, runtime: rt, launcher: new RecordingLauncher(false), executor });
    const first = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'first', cwd: workspace, mode: 'agent' })).task;
    const second = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'second', cwd: alias, mode: 'agent' })).task;
    const firstWorker = engine.runOne(first.id);
    await started.promise;
    assert.equal((await engine.runOne(second.id)).status, 'queued');
    release.resolve();
    assert.equal((await firstWorker).status, 'completed');
    assert.equal((await engine.runOne(second.id)).status, 'completed');
  } finally { await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); await rm(aliasRoot, { recursive: true, force: true }); }
});

test('Git editing tasks use distinct managed branches and worktrees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-engine-git-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-engine-git-workspace-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['init']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'user.name', 'Fixture']);
    await (await import('node:fs/promises')).writeFile(join(workspace, 'file.txt'), 'one\n');
    git(['add', 'file.txt']);
    git(['commit', '-m', 'initial']);
    const seen = new Map<string, string>();
    const rt = runtime();
    const engine = new TaskEngine({ root, runtime: rt, launcher: new RecordingLauncher(false), executor: { execute: async (task, cwd) => { seen.set(task.id, cwd); return { response: 'ok', modelId: task.modelId, changedWorkspace: false }; } } });
    const first = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'first edit', cwd: workspace, mode: 'agent' })).task;
    const second = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'second edit', cwd: workspace, mode: 'agent' })).task;
    const settled = await Promise.all([engine.runOne(first.id), engine.runOne(second.id)]);
    assert.deepEqual(settled.map((task) => task.status), ['completed', 'completed']);
    assert.notEqual(seen.get(first.id), seen.get(second.id));
    assert.equal(settled.every((task) => task.executionWorkspace !== workspace && task.repositoryIdentity && task.baseCommit), true);
  } finally {
    const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: workspace, encoding: 'utf8' }).stdout;
    for (const line of list.split('\n').filter((item) => item.startsWith('worktree ')).slice(1)) spawnSync('git', ['worktree', 'remove', '--force', line.slice(9)], { cwd: workspace });
    for (const branch of spawnSync('git', ['branch', '--format=%(refname:short)', '--list', 'zeuz/task-*'], { cwd: workspace, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) spawnSync('git', ['branch', '-D', branch], { cwd: workspace });
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Git retry reuses the persisted clean worktree instead of creating another branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-engine-git-retry-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-engine-git-retry-workspace-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['init']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'user.name', 'Fixture']);
    await (await import('node:fs/promises')).writeFile(join(workspace, 'file.txt'), 'one\n');
    git(['add', 'file.txt']);
    git(['commit', '-m', 'initial']);
    const clock = mutableRuntime();
    const seen: string[] = [];
    let calls = 0;
    const engine = new TaskEngine({
      root,
      runtime: clock.runtime,
      launcher: new RecordingLauncher(false),
      executor: { execute: async (task, cwd) => { seen.push(cwd); calls += 1; if (calls === 1) throw Object.assign(new Error('temporary'), { code: 'TRANSIENT_PROVIDER_FAILURE' }); return { response: 'ok', modelId: task.modelId, changedWorkspace: false }; } },
    });
    const submitted = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'retry edit', cwd: workspace, mode: 'agent', retry: { enabled: true, maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 1_000 } })).task;
    assert.equal((await engine.runOne(submitted.id)).status, 'queued');
    clock.advance(1_000);
    assert.equal((await engine.runOne(submitted.id)).status, 'completed');
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);
    assert.equal(git(['branch', '--format=%(refname:short)', '--list', 'zeuz/task-*']).split('\n').filter(Boolean).length, 1);
  } finally {
    const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: workspace, encoding: 'utf8' }).stdout;
    for (const line of list.split('\n').filter((item) => item.startsWith('worktree ')).slice(1)) spawnSync('git', ['worktree', 'remove', '--force', line.slice(9)], { cwd: workspace });
    for (const branch of spawnSync('git', ['branch', '--format=%(refname:short)', '--list', 'zeuz/task-*'], { cwd: workspace, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) spawnSync('git', ['branch', '-D', branch], { cwd: workspace });
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
