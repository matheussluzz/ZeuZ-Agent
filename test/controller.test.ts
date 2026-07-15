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

function reviewPacket(prompt: string): {
  packetFingerprint: string;
  expectedReviewer: { provider: string; model: string; family: string };
  criteria: Array<{ id: string }>;
} {
  const match = prompt.match(/MEDUSA_RUNTIME_PACKET_JSON\n(.+)\nEND_MEDUSA_RUNTIME_PACKET_JSON/);
  assert.ok(match?.[1], 'review prompt must contain the runtime evidence packet');
  return JSON.parse(match[1]) as ReturnType<typeof reviewPacket>;
}

function reviewReport(request: RunRequest, verdict: 'PASS' | 'CHANGES_REQUIRED' = 'PASS'): RunResult {
  const packet = reviewPacket(request.prompt);
  const finding = {
    id: 'FIND-001',
    severity: 'HIGH',
    title: 'Fixture defect',
    location: 'fixture.ts:1',
    evidence: 'Synthetic failing evidence.',
    reproduction: 'Run the fixture.',
    expectedCorrection: 'Fix the fixture.',
    criterionIds: [packet.criteria[0]?.id],
  };
  return {
    text: JSON.stringify({
      schemaVersion: '1.0',
      packetFingerprint: packet.packetFingerprint,
      reviewer: packet.expectedReviewer,
      deterministicChecks: [{ id: 'CHK-001', command: 'fixture check', status: 'PASS', required: true, evidence: 'fixture exit 0' }],
      criteria: packet.criteria.map((criterion, index) => ({
        id: criterion.id,
        status: verdict === 'CHANGES_REQUIRED' && index === 0 ? 'NOT_MET' : 'MET',
        evidence: ['fixture evidence'],
        findingIds: verdict === 'CHANGES_REQUIRED' && index === 0 ? ['FIND-001'] : [],
      })),
      verificationGaps: [{ id: 'GAP-001', changedBehavior: 'fixture behavior', assertion: 'fixture assertion', status: verdict === 'PASS' ? 'COVERED' : 'GAP', evidence: 'fixture test' }],
      findings: verdict === 'CHANGES_REQUIRED' ? [finding] : [],
      blockers: [],
      verdict,
      summary: verdict === 'PASS' ? 'fixture pass' : 'fixture changes required',
    }),
  };
}

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
        return reviewReport(request);
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
        return reviewReport(request, reviewRuns === 1 ? 'CHANGES_REQUIRED' : 'PASS');
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

test('reviewer execution failure blocks delivery as REVIEW_BLOCKED', async () => {
  const { controller, root } = await harness({
    fingerprints: ['before', 'after', 'after'],
    run: async (request) => {
      if (request.model.provider === 'cursor') throw new Error('reviewer unavailable');
      return { text: 'producer response' };
    },
  });
  try {
    await assert.rejects(
      () => controller.send('change work'),
      (error: Error & { review?: { verdict?: string } }) => {
        assert.equal(error.name, 'ReviewGateError');
        assert.equal(error.review?.verdict, 'REVIEW_BLOCKED');
        assert.match(error.message, /Reviewer execution failed/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a second CHANGES_REQUIRED verdict blocks delivery after remediation', async () => {
  let producerRuns = 0;
  const { controller, root } = await harness({
    fingerprints: ['before', 'after', 'after', 'after'],
    run: async (request) => {
      if (request.model.provider === 'cursor') {
        return reviewReport(request, 'CHANGES_REQUIRED');
      }
      producerRuns += 1;
      return { text: producerRuns === 1 ? 'initial response' : 'remediated response' };
    },
  });
  try {
    await assert.rejects(
      () => controller.send('change and remain broken'),
      (error: Error & { review?: { verdict?: string } }) => {
        assert.equal(error.name, 'ReviewGateError');
        assert.equal(error.review?.verdict, 'CHANGES_REQUIRED');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resuming a provider session reapplies the current less-permissive mode', async () => {
  const requests: RunRequest[] = [];
  const { controller, root } = await harness({
    mode: 'yolo',
    fingerprints: ['same', 'same', 'same', 'same'],
    run: async (request) => {
      requests.push(request);
      return { text: 'producer response', nativeSessionId: 'native-session-1' };
    },
  });
  try {
    await controller.send('first turn');
    await controller.setPermission('plan');
    await controller.send('resumed turn');
    assert.equal(requests[0]?.mode, 'yolo');
    assert.equal(requests[0]?.resumeId, undefined);
    assert.equal(requests[1]?.mode, 'plan');
    assert.equal(requests[1]?.resumeId, 'native-session-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
