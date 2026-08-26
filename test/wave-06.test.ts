import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { COMMAND_NAMES, parseCommand } from '../src/command-dispatch.js';
import { PortableSkillRegistry } from '../src/skill-registry/registry.js';
import { TaskEngine, type TaskExecutor, type WorkerLauncher } from '../src/task-engine.js';
import { TaskResultStore } from '../src/task-result-store.js';
import { TaskStore } from '../src/task-store.js';
import type { RuntimeSeams } from '../src/runtime.js';
import type { DurableTaskRecord } from '../src/task-schema.js';

const NOW = '2026-01-02T03:04:05.000Z';
const unchanged = { policy: 'wave-03-v1' as const, kind: 'non_git' as const, measurable: true, fingerprint: 'same' };

function runtime(): RuntimeSeams {
  let id = 0;
  return { now: () => NOW, nowMs: () => Date.parse(NOW), newId: () => `wave06-${++id}`, fingerprint: () => 'same', measureWorkspace: () => unchanged };
}

class NoLaunch implements WorkerLauncher {
  async launch(): Promise<boolean> { return false; }
}

test('only Pantheon personas are promoted to top-level commands', () => {
  for (const name of ['argos', 'hefesto', 'metis', 'medusa', 'atena', 'clio', 'prometeu', 'hermes']) assert.equal(parseCommand(`/${name} task`).name, name);
  assert.equal(COMMAND_NAMES.includes('skill'), true);
  assert.throws(() => parseCommand('/code-review task'), /Unknown command/);
});

test('non-Pantheon catalog search returns metadata and explicit activation keeps dependency gates', async () => {
  const registry = new PortableSkillRegistry();
  const matches = await registry.search('code-review');
  assert.ok(matches.length >= 1);
  assert.ok(matches.every((skill) => skill.namespace !== 'zeuz/pantheon'));
  assert.ok(matches.every((skill) => skill.description && skill.revision));
  const context = await registry.contextForSkill('code-review', 'Review the parser in read-only mode.');
  assert.match(context, /<skill name="code-review"/);
  const metisContext = await registry.contextForSkill('metis', 'Research primary sources.', { scope: 'pantheon', budgetBytes: 256 * 1024 });
  assert.match(metisContext, /<skill name="metis"/);
  assert.match(metisContext, /<skill name="medusa"/);
});

test('task engine delivers queued follow-ups exactly once on the owning turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave06-engine-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-wave06-workspace-'));
  const seen: DurableTaskRecord[] = [];
  try {
    const executor: TaskExecutor = {
      async execute(task) {
        seen.push(task);
        return { response: 'done', modelId: task.modelId, changedWorkspace: false };
      },
    };
    const engine = new TaskEngine({ root, runtime: runtime(), launcher: new NoLaunch(), executor });
    const submitted = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'base task', cwd: workspace, mode: 'plan' })).task;
    const queued = await engine.queueFollowUp(submitted.id, 'Add this constraint in the next turn.');
    assert.equal(queued.delivery, 'queued');
    assert.equal((await engine.runOne(submitted.id)).status, 'completed');
    assert.match(seen[0]?.prompt ?? '', /Add this constraint in the next turn/);
    assert.equal((await engine.listMessages(submitted.id))[0]?.status, 'delivered');
    assert.equal((await engine.runOne(submitted.id)).status, 'completed');
    assert.equal(seen.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test('native live input is opt-in and root-only specialist submission is enforced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave06-live-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-wave06-live-workspace-'));
  const childRoot = await mkdtemp(join(tmpdir(), 'zeuz-wave06-child-'));
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  try {
    const executor: TaskExecutor = {
      async execute(task, _cwd, signal) {
        void task;
        started();
        await Promise.race([releasePromise, new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))]);
        return { response: 'done', modelId: task.modelId, changedWorkspace: false };
      },
      supportsLiveInput: () => true,
      async sendLiveInput(_task, content) { assert.equal(content, 'live constraint'); },
    };
    const engine = new TaskEngine({ root, runtime: runtime(), launcher: new NoLaunch(), executor, heartbeatMs: 10, leaseMs: 100 });
    const task = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'long task', cwd: workspace, mode: 'plan' })).task;
    const worker = engine.runOne(task.id);
    await startedPromise;
    const live = await engine.queueFollowUp(task.id, 'live constraint');
    assert.equal(live.delivery, 'live');
    assert.equal((await engine.listMessages(task.id))[0]?.status, 'delivered');
    release();
    assert.equal((await worker).status, 'completed');

    const childEngine = new TaskEngine({ root: childRoot, runtime: runtime(), launcher: new NoLaunch(), rootOrchestrator: false });
    await assert.rejects(() => childEngine.submitSpecialist({
      modelId: 'codex:gpt-5.6-luna@high', prompt: 'specialist', cwd: workspace, mode: 'plan',
      specialist: { personaId: 'argos', route: 'explicit', execution: 'spawn', reason: 'explicit', matchedTriggers: ['/argos'], reviewerFamily: 'Cursor Grok', dependencySkills: ['argos'] },
    }), /root ZeuZ orchestrator/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(childRoot, { recursive: true, force: true });
  }
});

test('queued follow-ups are released when cancellation wins during execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave06-cancel-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-wave06-cancel-workspace-'));
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  try {
    const executor: TaskExecutor = {
      async execute(_task, _cwd, signal) {
        started();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
        return { response: 'unreachable', modelId: 'codex:gpt-5.6-luna@high', changedWorkspace: false };
      },
    };
    const engine = new TaskEngine({ root, runtime: runtime(), launcher: new NoLaunch(), executor, heartbeatMs: 10, leaseMs: 100 });
    const task = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'cancel me', cwd: workspace, mode: 'plan' })).task;
    const worker = engine.runOne(task.id);
    await startedPromise;
    const queued = await engine.queueFollowUp(task.id, 'keep this queued');
    assert.equal(queued.delivery, 'queued');
    await new TaskStore({ root, runtime: runtime() }).requestCancel(task.id, 'test cancellation');
    assert.equal((await worker).status, 'cancelled');
    assert.equal((await engine.listMessages(task.id))[0]?.status, 'queued');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test('spawned specialist result is retrievable through the durable result store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave06-result-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-wave06-result-workspace-'));
  try {
    const executor: TaskExecutor = {
      async execute(task) { return { response: `result for ${task.specialist?.personaId}`, modelId: task.modelId, changedWorkspace: false }; },
    };
    const engine = new TaskEngine({ root, runtime: runtime(), launcher: new NoLaunch(), executor, rootOrchestrator: true });
    const parent = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'root', cwd: workspace, mode: 'plan' })).task;
    const specialist = (await engine.submitSpecialist({
      parentTaskId: parent.id, modelId: 'codex:gpt-5.6-luna@high', prompt: 'specialist', cwd: workspace, mode: 'plan',
      specialist: { personaId: 'argos', route: 'explicit', execution: 'spawn', reason: 'explicit', matchedTriggers: ['/argos'], reviewerFamily: 'Cursor Grok', dependencySkills: ['argos'] },
    })).task;
    const settled = await engine.runOne(specialist.id);
    assert.equal(settled.status, 'completed');
    assert.ok(settled.result);
    const result = await new TaskResultStore({ root, now: () => NOW }).retrieve(settled.result!);
    assert.equal(result, 'result for argos');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

function capabilityMarker(input: Record<string, unknown>): string {
  return `<zeuz_capability_request>${JSON.stringify(input)}</zeuz_capability_request>`;
}

async function specialistFixture(root: string, workspace: string, executor: TaskExecutor): Promise<{ engine: TaskEngine; taskId: string }> {
  const engine = new TaskEngine({ root, runtime: runtime(), launcher: new NoLaunch(), executor, rootOrchestrator: true });
  const parent = (await engine.submit({ modelId: 'codex:gpt-5.6-luna@high', prompt: 'root', cwd: workspace, mode: 'plan' })).task;
  const task = (await engine.submitSpecialist({
    parentTaskId: parent.id, modelId: 'codex:gpt-5.6-luna@high', prompt: 'specialist', cwd: workspace, mode: 'plan',
    specialist: { personaId: 'metis', route: 'explicit', execution: 'spawn', reason: 'explicit', matchedTriggers: ['/metis'], reviewerFamily: 'Cursor Grok', dependencySkills: ['metis', 'medusa'] },
  })).task;
  return { engine, taskId: task.id };
}

test('worker capability requests route to the root and invalid payloads are recorded safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave06-capability-root-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-wave06-capability-workspace-'));
  try {
    const rootEngine = await specialistFixture(root, workspace, { async execute() { return { response: 'unused', modelId: 'codex:gpt-5.6-luna@high', changedWorkspace: false }; } });
    const worker = new TaskEngine({
      root, runtime: runtime(), launcher: new NoLaunch(), rootOrchestrator: false,
      executor: { async execute(task) { return { response: capabilityMarker({ requesterTaskId: task.id, rootCorrelationId: task.rootCorrelationId, personaId: 'metis', capability: 'current-research', reason: 'Need primary sources.' }), modelId: task.modelId, changedWorkspace: false }; } },
    });
    await worker.runOne(rootEngine.taskId);
    const routed = (await rootEngine.engine.listCapabilityRequests())[0];
    assert.equal(routed?.code, 'ROOT_REQUIRED');
    assert.equal(routed?.status, 'pending');

    const invalidRoot = await mkdtemp(join(tmpdir(), 'zeuz-wave06-capability-invalid-'));
    const invalidWorkspace = await mkdtemp(join(tmpdir(), 'zeuz-wave06-capability-invalid-workspace-'));
    try {
      const fixture = await specialistFixture(invalidRoot, invalidWorkspace, { async execute() { return { response: 'unused', modelId: 'codex:gpt-5.6-luna@high', changedWorkspace: false }; } });
      const invalidWorker = new TaskEngine({
        root: invalidRoot, runtime: runtime(), launcher: new NoLaunch(), rootOrchestrator: false,
        executor: { async execute(task) { return { response: capabilityMarker({ requesterTaskId: task.id, rootCorrelationId: task.rootCorrelationId, personaId: 'metis', capability: '', reason: 'invalid' }), modelId: task.modelId, changedWorkspace: false }; } },
      });
      await invalidWorker.runOne(fixture.taskId);
      const invalid = (await fixture.engine.listCapabilityRequests())[0];
      assert.equal(invalid?.code, 'INVALID_CAPABILITY_REQUEST');
      assert.equal(invalid?.status, 'invalid');
    } finally {
      await rm(invalidRoot, { recursive: true, force: true });
      await rm(invalidWorkspace, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test('root approval can spawn a sibling at the same bounded depth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave06-capability-approve-'));
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-wave06-capability-approve-workspace-'));
  try {
    const engine = await specialistFixture(root, workspace, {
      async execute(task) {
        return { response: capabilityMarker({ requesterTaskId: task.id, rootCorrelationId: task.rootCorrelationId, personaId: 'metis', capability: 'current-research', reason: 'Need primary sources.' }), modelId: task.modelId, changedWorkspace: false };
      },
    });
    await engine.engine.runOne(engine.taskId);
    const request = (await engine.engine.listCapabilityRequests())[0];
    assert.ok(request);
    assert.equal(request.code, 'SIBLING_SPAWN_AVAILABLE');
    const approved = await engine.engine.approveCapabilityRequest(request.id, { prompt: 'Sibling research task' });
    assert.equal(approved.record.status, 'spawned');
    assert.equal(approved.task?.depth, 1);
    assert.equal(approved.task?.parentTaskId !== undefined, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
