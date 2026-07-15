import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AdapterRegistry } from '../src/adapters/index.js';
import { DEFAULT_MODEL_ID } from '../src/catalog.js';
import { ZeuzController, type ControllerDependencies } from '../src/controller.js';
import { SessionStore } from '../src/session-store.js';
import type { RuntimeSeams } from '../src/runtime.js';
import type { AgentAdapter, AgentEvent, HealthResult, ProviderId, RunRequest, RunResult, WorkspaceBootstrap } from '../src/types.js';

const BOOTSTRAP: WorkspaceBootstrap = {
  userSlug: 'fixture-user',
  onboardingRequired: false,
  files: ['AGENTS.md'],
  context: 'Synthetic bootstrap contract.',
  warnings: [],
};

function deterministicRuntime(fingerprints: Array<string | undefined> = ['clean']): RuntimeSeams {
  let id = 0;
  let fingerprint = 0;
  return {
    now: () => '2026-01-02T03:04:05.000Z',
    nowMs: () => 1_767_322_245_000,
    newId: () => `controller-id-${++id}`,
    fingerprint: () => fingerprints[Math.min(fingerprint++, fingerprints.length - 1)],
  };
}

function fakeRegistry(input: {
  run(request: RunRequest): Promise<RunResult>;
  health?: Partial<Record<ProviderId, boolean>>;
}): AdapterRegistry {
  return new AdapterRegistry({
    factory: (provider): AgentAdapter => ({
      provider,
      run: input.run,
      health: async (): Promise<HealthResult> => ({
        provider,
        ok: input.health?.[provider] ?? true,
        version: 'fixture',
      }),
    }),
  });
}

async function harness(input: {
  fingerprints?: Array<string | undefined>;
  modelId?: string;
  mode?: 'plan' | 'agent' | 'yolo';
  run(request: RunRequest): Promise<RunResult>;
  health?: Partial<Record<ProviderId, boolean>>;
}): Promise<{ controller: ZeuzController; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-controller-'));
  const runtime = deterministicRuntime(input.fingerprints);
  const sessions = new SessionStore({ root, runtime });
  const contexts: ControllerDependencies['contexts'] = {
    load: async () => BOOTSTRAP,
    initialize: async () => BOOTSTRAP,
    updateHandoff: async () => undefined,
  };
  const skills: ControllerDependencies['skills'] = {
    contextFor: async () => undefined,
    list: async () => [],
  };
  const controller = await ZeuzController.create('/fixture-workspace', {
    ...(input.modelId ? { modelId: input.modelId } : {}),
    mode: input.mode ?? 'agent',
  }, {
    runtime,
    sessions,
    contexts,
    skills,
    registry: fakeRegistry({ run: input.run, ...(input.health ? { health: input.health } : {}) }),
  });
  return { controller, root };
}

test('controller defaults to primary Sol and honors explicit session model selection', async () => {
  const first = await harness({ mode: 'plan', run: async () => ({ text: 'unused' }) });
  const second = await harness({ modelId: 'copilot:claude-sonnet-5', mode: 'plan', run: async () => ({ text: 'unused' }) });
  try {
    assert.equal(first.controller.session.activeModelId, DEFAULT_MODEL_ID);
    assert.equal(first.controller.activeModel().family, 'GPT-5.6 Sol');
    assert.equal(second.controller.session.activeModelId, 'copilot:claude-sonnet-5');
  } finally {
    await Promise.all([first.root, second.root].map(async (root) => await rm(root, { recursive: true, force: true })));
  }
});

test('controller uses explicit fallback only when the workspace is measurably unchanged', async () => {
  const calls: string[] = [];
  const events: AgentEvent[] = [];
  const { controller, root } = await harness({
    fingerprints: ['same', 'same', 'same'],
    health: { claude: false },
    run: async (request) => {
      calls.push(request.model.id);
      if (request.model.provider === 'codex') throw new Error('model unavailable');
      return { text: 'fallback response' };
    },
  });
  try {
    const outcome = await controller.send('do work', (event) => events.push(event));
    assert.equal(outcome.modelId, 'cursor:claude-fable-5-thinking-high');
    assert.deepEqual(calls, [DEFAULT_MODEL_ID, 'cursor:claude-fable-5-thinking-high']);
    assert.ok(events.some((event) => event.type === 'warning' && /Falling back explicitly/.test(event.text)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('controller never advances from failed Claude fallback to Cursor after a workspace change', async () => {
  const calls: string[] = [];
  const { controller, root } = await harness({
    fingerprints: ['clean', 'clean', 'changed'],
    health: { claude: true },
    run: async (request) => {
      calls.push(request.model.id);
      if (request.model.provider === 'codex') throw new Error('model unavailable');
      if (request.model.provider === 'claude') throw new Error('authentication failed after possible edit');
      return { text: 'must not run' };
    },
  });
  try {
    await assert.rejects(() => controller.send('possibly mutate during fallback'), /authentication failed/);
    assert.deepEqual(calls, [DEFAULT_MODEL_ID, 'claude:fable']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: 'changed', fingerprints: ['before', 'after'] as Array<string | undefined> },
  { name: 'unmeasurable', fingerprints: [undefined, undefined] as Array<string | undefined> },
]) {
  test(`controller never replays a failed potentially mutating turn when workspace state is ${scenario.name}`, async () => {
    const calls: string[] = [];
    const { controller, root } = await harness({
      fingerprints: scenario.fingerprints,
      health: { claude: false },
      run: async (request) => {
        calls.push(request.model.id);
        throw new Error('model unavailable');
      },
    });
    try {
      await assert.rejects(() => controller.send('possibly mutate'), /model unavailable/);
      assert.deepEqual(calls, [DEFAULT_MODEL_ID]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('controller deterministically reviews changed work and persists provider state', async () => {
  const calls: string[] = [];
  const { controller, root } = await harness({
    fingerprints: ['before', 'after', 'after'],
    run: async (request) => {
      calls.push(request.model.id);
      if (request.model.provider === 'cursor') {
        return { text: JSON.stringify({ verdict: 'PASS', summary: 'fixture pass', findings: [] }) };
      }
      return { text: 'producer response', nativeSessionId: 'native-session-1' };
    },
  });
  try {
    const outcome = await controller.send('change work');
    assert.equal(outcome.changedWorkspace, true);
    assert.equal(outcome.review?.verdict, 'PASS');
    assert.deepEqual(calls, [DEFAULT_MODEL_ID, 'cursor:claude-fable-5-thinking-high']);

    const persisted = await controller.sessions.load(controller.session.id);
    assert.equal(persisted.lastUsedModelId, DEFAULT_MODEL_ID);
    assert.equal(persisted.providerSessions[DEFAULT_MODEL_ID], 'native-session-1');
    assert.ok(persisted.messages.some((message) => message.role === 'reviewer'));
    assert.ok(persisted.messages.every((message) => message.createdAt === '2026-01-02T03:04:05.000Z'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('controller remediates once and re-runs review deterministically', async () => {
  let producerRuns = 0;
  let reviewRuns = 0;
  const { controller, root } = await harness({
    fingerprints: ['before', 'after', 'after', 'after'],
    run: async (request) => {
      if (request.model.provider === 'cursor') {
        reviewRuns += 1;
        return reviewRuns === 1
          ? { text: JSON.stringify({ verdict: 'CHANGES_REQUIRED', summary: 'fix it', findings: [{ severity: 'high', title: 'fixture', detail: 'fix' }] }) }
          : { text: JSON.stringify({ verdict: 'PASS', summary: 'fixed', findings: [] }) };
      }
      producerRuns += 1;
      return { text: producerRuns === 1 ? 'initial response' : 'remediated response', nativeSessionId: 'native-session-1' };
    },
  });
  try {
    const outcome = await controller.send('change and review');
    assert.equal(producerRuns, 2);
    assert.equal(reviewRuns, 2);
    assert.equal(outcome.review?.verdict, 'PASS');
    assert.match(outcome.response, /Adversarial remediation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('characterizes reviewer execution failure as CHANGES_REQUIRED before Wave 02', async () => {
  const { controller, root } = await harness({ fingerprints: ['before', 'after', 'after'], run: async (request) => {
    if (request.model.provider === 'cursor') throw new Error('reviewer unavailable');
    return { text: 'producer response' };
  } });
  try {
    const outcome = await controller.send('change work');
    assert.equal(outcome.review?.verdict, 'CHANGES_REQUIRED');
    assert.match(outcome.review?.summary ?? '', /did not return valid structured evidence/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('characterizes delivery after a second CHANGES_REQUIRED verdict before Wave 02', async () => {
  let producerRuns = 0;
  const { controller, root } = await harness({ fingerprints: ['before', 'after', 'after', 'after'], run: async (request) => {
    if (request.model.provider === 'cursor') return { text: JSON.stringify({ verdict: 'CHANGES_REQUIRED', summary: 'still broken', findings: [{ severity: 'high', title: 'fixture', detail: 'fix' }] }) };
    producerRuns += 1;
    return { text: producerRuns === 1 ? 'initial response' : 'remediated response' };
  } });
  try {
    const outcome = await controller.send('change and remain broken');
    assert.equal(outcome.review?.verdict, 'CHANGES_REQUIRED');
    assert.match(outcome.response, /Adversarial remediation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
