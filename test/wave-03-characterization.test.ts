/**
 * Wave 03 baseline characterization — green checkpoint against commit b4e20c5.
 * These tests freeze current gaps; they are not target acceptance tests.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, statSync, utimesSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AgyAdapter } from '../src/adapters/agy.js';
import { AdapterRegistry } from '../src/adapters/index.js';
import { NvidiaAdapter } from '../src/adapters/nvidia.js';
import { createDefaultAdapterRuntime, type AdapterRuntime } from '../src/adapters/runtime.js';
import { DEFAULT_MODEL_ID } from '../src/catalog.js';
import { ZeuzController, type ControllerDependencies } from '../src/controller.js';
import { isGitRepository, workspaceFingerprint } from '../src/git.js';
import { runProcess, type ProcessResult } from '../src/process.js';
import { measurablyUnchanged } from '../src/runtime.js';
import { SessionStore } from '../src/session-store.js';
import type { AgentEvent, HealthResult, ProviderId, RunRequest, RunResult, WorkspaceBootstrap } from '../src/types.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROCESS_SOURCE = readFileSync(join(REPO_ROOT, 'src/process.ts'), 'utf8');
const LEGACY_PROCESS_SOURCE = PROCESS_SOURCE.slice(
  PROCESS_SOURCE.indexOf('export async function runProcessLegacy'),
  PROCESS_SOURCE.indexOf('export function findExecutable'),
);
const CONTROLLER_SOURCE = readFileSync(join(REPO_ROOT, 'src/controller.ts'), 'utf8');
const GIT_SOURCE = readFileSync(join(REPO_ROOT, 'src/git.ts'), 'utf8');
const NVIDIA_SOURCE = readFileSync(join(REPO_ROOT, 'src/adapters/nvidia.ts'), 'utf8');

const BOOTSTRAP: WorkspaceBootstrap = {
  userSlug: 'fixture-user',
  onboardingRequired: false,
  files: ['AGENTS.md'],
  context: 'Synthetic bootstrap contract.',
  warnings: [],
};

function assertNoTruncationMetadata(result: ProcessResult): void {
  assert.equal('truncation' in result, false);
  assert.equal('terminationStage' in result, false);
  assert.equal('abortCause' in result, false);
}

function deterministicRuntime(fingerprints: Array<string | undefined> = ['clean']): ControllerDependencies['runtime'] {
  let id = 0;
  let fingerprint = 0;
  return {
    now: () => '2026-01-02T03:04:05.000Z',
    nowMs: () => 1_767_322_245_000,
    newId: () => `wave03-id-${++id}`,
    fingerprint: () => fingerprints[Math.min(fingerprint++, fingerprints.length - 1)],
  };
}

function fakeRegistry(input: {
  run(request: RunRequest): Promise<RunResult>;
  health?: Partial<Record<ProviderId, boolean>>;
}): AdapterRegistry {
  return new AdapterRegistry({
    factory: (provider): import('../src/types.js').AgentAdapter => ({
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

type CompetingFailureKind = 'timeout' | 'cancel' | 'availability';

function throwCompetingFailure(kind: CompetingFailureKind): never {
  if (kind === 'timeout') {
    const error = new Error('The operation timed out');
    error.name = 'TimeoutError';
    throw error;
  }
  if (kind === 'cancel') throw new DOMException('The operation was aborted', 'AbortError');
  throw new Error('model unavailable');
}

function competingProducerFailure(winner: CompetingFailureKind, loser: CompetingFailureKind): () => Promise<RunResult> {
  return async () => await new Promise<RunResult>((_resolve, reject) => {
    let settled = false;
    const settle = (kind: CompetingFailureKind) => {
      if (settled) return;
      settled = true;
      try {
        throwCompetingFailure(kind);
      } catch (error) {
        reject(error);
      }
    };
    settle(winner);
    queueMicrotask(() => settle(loser));
  });
}

async function controllerHarness(input: {
  fingerprints?: Array<string | undefined>;
  mode?: 'plan' | 'agent' | 'yolo';
  run(request: RunRequest): Promise<RunResult>;
  health?: Partial<Record<ProviderId, boolean>>;
}): Promise<{ controller: ZeuzController; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave03-'));
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

test('[characterization] runProcess retains full stdout/stderr buffers without truncation metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave03-process-'));
  try {
    const stdoutPayload = 'x'.repeat(120_000);
    const stderrPayload = 'y'.repeat(40_000);
    const script = `process.stdout.write(${JSON.stringify(stdoutPayload)}); process.stderr.write(${JSON.stringify(stderrPayload)});`;
    const result = await runProcess(process.execPath, ['-e', script], { cwd: root });
    assert.equal(result.stdout.length, stdoutPayload.length);
    assert.equal(result.stderr.length, stderrPayload.length);
    assertNoTruncationMetadata(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[characterization] legacy runner preserves the untyped SIGINT then 1500ms SIGKILL rollback behavior', () => {
  assert.match(LEGACY_PROCESS_SOURCE, /child\.kill\('SIGINT'\)/);
  assert.match(LEGACY_PROCESS_SOURCE, /setTimeout\(\(\) => child\.kill\('SIGKILL'\), 1_500\)/);
  assert.doesNotMatch(LEGACY_PROCESS_SOURCE, /terminationStage|abortCause/);
  assert.match(LEGACY_PROCESS_SOURCE, /BoundedByteAccumulator/);
});

test('[characterization] runProcess abort during active streaming settles once with partial stdout and no typed termination metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave03-stream-'));
  const controller = new AbortController();
  let sawChunk = false;
  const script = [
    "process.stdout.write('streamed-partial');",
    "try { require('fs').readSync(0, Buffer.alloc(1), 0, 1, null); } catch {}",
  ].join(' ');
  try {
    const result = await runProcess(process.execPath, ['-e', script], {
      cwd: root,
      signal: controller.signal,
      onStdoutChunk: (chunk) => {
        if (!sawChunk && chunk.includes('streamed-partial')) {
          sawChunk = true;
          controller.abort();
        }
      },
    });
    assert.equal(sawChunk, true);
    assert.match(result.stdout, /streamed-partial/);
    assertNoTruncationMetadata(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[characterization] runProcess close-before-abort completes normally with full output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave03-close-first-'));
  const controller = new AbortController();
  try {
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('closed-cleanly');"], {
      cwd: root,
      signal: controller.signal,
    });
    controller.abort();
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'closed-cleanly');
    assertNoTruncationMetadata(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[characterization] runProcess abort-before-close settles exactly once without typed termination metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave03-abort-first-'));
  const controller = new AbortController();
  const settlements: ProcessResult[] = [];
  const script = "process.stdout.write('live'); setInterval(() => {}, 1_000_000);";
  try {
    const pending = runProcess(process.execPath, ['-e', script], {
      cwd: root,
      signal: controller.signal,
      onStdoutChunk: (chunk) => {
        if (chunk.includes('live')) controller.abort();
      },
    }).then((result) => {
      settlements.push(result);
      return result;
    });
    const result = await pending;
    assert.equal(settlements.length, 1);
    assert.match(result.stdout, /live/);
    assertNoTruncationMetadata(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[characterization] runProcess non-zero close-before-abort settles once with stderr buffers and no truncation metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave03-error-close-'));
  const controller = new AbortController();
  try {
    const result = await runProcess(process.execPath, ['-e', "process.stderr.write('failed'); process.exit(4);"], {
      cwd: root,
      signal: controller.signal,
    });
    controller.abort();
    assert.equal(result.exitCode, 4);
    assert.equal(result.stderr, 'failed');
    assertNoTruncationMetadata(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[characterization] runProcess spawn error-before-abort rejects exactly once before abort can settle close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave03-error-first-'));
  const controller = new AbortController();
  let settlements = 0;
  try {
    await assert.rejects(
      () => runProcess('zeuz-missing-executable-fixture', [], { cwd: root, signal: controller.signal })
        .then((result) => {
          settlements += 1;
          return result;
        })
        .catch((error) => {
          settlements += 1;
          throw error;
        }),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, 'ENOENT');
        return true;
      },
    );
    controller.abort();
    assert.equal(settlements, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[characterization transition] legacy rollback no longer signals a child when already aborted', { timeout: 5_000 }, async () => {
  const probe = spawn(process.execPath, [
    '--import', 'tsx',
    '--input-type=module',
    '-e',
    [
      'import { runProcessLegacy } from "./src/process.ts";',
      'const controller = new AbortController();',
      'controller.abort();',
      'await runProcessLegacy("zeuz-missing-executable-after-preabort-fixture", [], { cwd: process.cwd(), signal: controller.signal });',
    ].join(' '),
  ], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
  });

  const terminal = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    probe.once('error', reject);
    probe.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(terminal.signal, null);
  assert.equal(terminal.code, 0);
});

test('[characterization] runProcess abort-before-nonzero-close resolves exactly once instead of producing a parent error event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave03-abort-before-error-'));
  const controller = new AbortController();
  const settlements: Array<'resolve' | 'reject'> = [];
  const script = [
    "process.stdout.write('live');",
    "process.nextTick(() => { throw new Error('child-error-after-abort-window'); });",
    'setInterval(() => {}, 1_000_000);',
  ].join(' ');
  try {
    const result = await runProcess(process.execPath, ['-e', script], {
      cwd: root,
      signal: controller.signal,
      onStdoutChunk: (chunk) => {
        if (chunk.includes('live')) controller.abort();
      },
    }).then((value) => {
      settlements.push('resolve');
      return value;
    }).catch((error) => {
      settlements.push('reject');
      throw error;
    });
    assert.deepEqual(settlements, ['resolve']);
    assert.match(result.stdout, /live/);
    assertNoTruncationMetadata(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[characterization transition] controller phases now use the shared deadline policy without changing deep-health timeout', () => {
  assert.match(CONTROLLER_SOURCE, /resolveDeadlinePolicy/);
  assert.match(CONTROLLER_SOURCE, /runPhase\('producer'/);
  assert.match(CONTROLLER_SOURCE, /runPhase\('review'/);
  assert.match(CONTROLLER_SOURCE, /runPhase\('remediation'/);
  assert.match(CONTROLLER_SOURCE, /AbortSignal\.timeout\(45_000\)/);
});

for (const scenario of [
  {
    name: 'timeout-before-availability',
    winner: 'timeout' as const,
    loser: 'availability' as const,
    expectFallback: false,
    expectedCalls: [DEFAULT_MODEL_ID],
    expectedError: /timed out/i,
  },
  {
    name: 'cancel-before-availability',
    winner: 'cancel' as const,
    loser: 'availability' as const,
    expectFallback: false,
    expectedCalls: [DEFAULT_MODEL_ID],
    expectedError: /aborted/i,
  },
  {
    name: 'availability-before-timeout',
    winner: 'availability' as const,
    loser: 'timeout' as const,
    expectFallback: true,
    expectedCalls: [DEFAULT_MODEL_ID, 'cursor:claude-fable-5-thinking-high'],
    expectedError: undefined,
  },
  {
    name: 'availability-before-cancel',
    winner: 'availability' as const,
    loser: 'cancel' as const,
    expectFallback: true,
    expectedCalls: [DEFAULT_MODEL_ID, 'cursor:claude-fable-5-thinking-high'],
    expectedError: undefined,
  },
]) {
  test(`[characterization] controller ${scenario.name} settles once with current fallback eligibility`, async () => {
    const calls: string[] = [];
    let producerAttempts = 0;
    const { controller, root } = await controllerHarness({
      fingerprints: ['same', 'same', 'same'],
      health: { claude: false },
      run: async (request) => {
        calls.push(request.model.id);
        if (request.model.provider !== 'codex') {
          return { text: 'fallback characterization response' };
        }
        producerAttempts += 1;
        return await competingProducerFailure(scenario.winner, scenario.loser)();
      },
    });
    try {
      if (scenario.expectFallback) {
        const outcome = await controller.send(`competing failure ${scenario.name}`);
        assert.equal(outcome.modelId, 'cursor:claude-fable-5-thinking-high');
      } else {
        const expectedError = scenario.expectedError;
        assert.ok(expectedError);
        await assert.rejects(() => controller.send(`competing failure ${scenario.name}`), expectedError);
      }
      assert.equal(producerAttempts, 1);
      assert.deepEqual(calls, scenario.expectedCalls);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { label: 'changed', fingerprints: ['before', 'after'] as Array<string | undefined> },
  { label: 'unmeasurable', fingerprints: [undefined, undefined] as Array<string | undefined> },
]) {
  test(`[characterization] availability failure does not replay when workspace is ${scenario.label}`, async () => {
    const calls: string[] = [];
    const { controller, root } = await controllerHarness({
      fingerprints: scenario.fingerprints,
      health: { claude: false },
      run: async (request) => {
        calls.push(request.model.id);
        throw new Error('model unavailable');
      },
    });
    try {
      await assert.rejects(() => controller.send('blocked fallback characterization'), /model unavailable/);
      assert.deepEqual(calls, [DEFAULT_MODEL_ID]);
      assert.equal(measurablyUnchanged(scenario.fingerprints[0], scenario.fingerprints[1]), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('[characterization] recordRun persists native session only from returned RunResult after successful close', async () => {
  const { controller, root } = await controllerHarness({
    fingerprints: ['same', 'same'],
    run: async () => ({ text: 'producer characterization', nativeSessionId: 'native-session-observed' }),
  });
  try {
    await controller.send('successful close characterization');
    const persisted = await controller.sessions.load(controller.session.id);
    assert.equal(persisted.providerSessions[DEFAULT_MODEL_ID], 'native-session-observed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    label: 'cancel',
    error: new DOMException('The operation was aborted', 'AbortError'),
    expectedError: /aborted/i,
  },
  {
    label: 'ordinary error',
    error: new Error('provider failed after observing native session'),
    expectedError: /provider failed/i,
  },
]) {
  test(`[characterization] native session observed in-stream before ${scenario.label} is not persisted because recordRun requires a returned RunResult`, async () => {
    let observedNativeSession: string | undefined;
    const { controller, root } = await controllerHarness({
      fingerprints: ['same', 'same'],
      run: async (request) => {
        observedNativeSession = 'native-session-observed-before-terminal-error';
        request.onEvent?.({ type: 'status', text: 'native session observed before terminal error' });
        throw scenario.error;
      },
    });
    try {
      await assert.rejects(() => controller.send(`native session before ${scenario.label} characterization`), scenario.expectedError);
      assert.equal(observedNativeSession, 'native-session-observed-before-terminal-error');
      const persisted = await controller.sessions.load(controller.session.id);
      assert.equal(persisted.providerSessions[DEFAULT_MODEL_ID], undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('[characterization transition] legacy undefined fingerprint is now fail-closed as unmeasurable', async () => {
  const nonGitRoot = await mkdtemp(join(tmpdir(), 'zeuz-wave03-nongit-'));
  const { controller, root } = await controllerHarness({
    fingerprints: [undefined, undefined, undefined],
    mode: 'agent',
    run: async () => ({ text: 'non-git characterization response' }),
  });
  try {
    assert.equal(isGitRepository(nonGitRoot), false);
    assert.equal(workspaceFingerprint(nonGitRoot), undefined);
    await assert.rejects(
      () => controller.send('non-git writable characterization'),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'WORKSPACE_UNMEASURABLE');
        assert.match(error.message, /unmeasurable/i);
        return true;
      },
    );
  } finally {
    await Promise.all([nonGitRoot, root].map(async (dir) => await rm(dir, { recursive: true, force: true })));
  }
});

test('[characterization] oversized untracked Git files hide same-length content edits when size/mtime identity is restored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave03-oversized-'));
  try {
    assert.match(GIT_SOURCE, /info\.isFile\(\) && info\.size <= 5 \* 1024 \* 1024\) hash\.update\(readFileSync\(path\)\)/);
    assert.match(GIT_SOURCE, /else hash\.update\(`\$\{info\.size\}:\$\{info\.mtimeMs\}`\)/);

    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'ZeuZ Test'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'tracked\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });

    const oversizedPath = join(root, 'oversized-untracked.bin');
    const size = 5 * 1024 * 1024 + 1;
    const payloadA = 'A'.repeat(size);
    const payloadB = 'B'.repeat(size);
    await writeFile(oversizedPath, payloadA);
    const controlledMtime = new Date(1_700_000_000_000);
    utimesSync(oversizedPath, controlledMtime, controlledMtime);
    const identityStat = statSync(oversizedPath);
    const before = workspaceFingerprint(root);

    await writeFile(oversizedPath, payloadB);
    utimesSync(oversizedPath, new Date(identityStat.atimeMs), new Date(identityStat.mtimeMs));
    const restoredStat = statSync(oversizedPath);
    const after = workspaceFingerprint(root);

    assert.equal(restoredStat.size, identityStat.size);
    assert.equal(restoredStat.mtimeMs, identityStat.mtimeMs);
    assert.notEqual(payloadA.slice(0, 32), payloadB.slice(0, 32));
    assert.equal(before, after, 'current baseline keys oversized untracked files by restored size/mtime identity only');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('[characterization] AgyAdapter final response depends on returned full stdout rather than incremental chunks alone', async () => {
  const base = createDefaultAdapterRuntime();
  const runtime: AdapterRuntime = {
    ...base,
    findExecutable: () => '/fixture/bin/agy',
    runProcess: async (_command, _args, options) => {
      options.onStdoutChunk?.('chunk-only-incremental');
      return { exitCode: 0, stdout: 'full-stdout-final-response', stderr: '' };
    },
    spawnSync: () => ({ status: 0, stdout: 'zeuz-fixture 0.0.0', stderr: '' }),
  };
  const events: AgentEvent[] = [];
  const result = await new AgyAdapter(runtime).run({
    model: {
      id: 'agy:fixture',
      provider: 'agy',
      model: 'fixture',
      label: 'Fixture',
      family: 'Fixture',
      description: 'fixture',
      aliases: ['fixture'],
    },
    prompt: 'agy stdout characterization',
    cwd: REPO_ROOT,
    mode: 'agent',
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.text, 'full-stdout-final-response');
  assert.ok(events.some((event) => event.type === 'delta' && event.text === 'chunk-only-incremental'));
  assert.notEqual(result.text, 'chunk-only-incremental');
});

test('[characterization transition] NvidiaAdapter direct route uses injected bounded HTTP transport', () => {
  assert.match(NVIDIA_SOURCE, /runtime\.httpRequest/);
  assert.match(NVIDIA_SOURCE, /stream:\s*false/);
  assert.match(NVIDIA_SOURCE, /readBoundedHttpBody/);
  assert.doesNotMatch(NVIDIA_SOURCE, /await response\.json\(\)/);
});

test('[characterization] NvidiaAdapter.runDirect posts stream:false through global fetch and parses JSON body', async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.NVIDIA_API_KEY_QWEN;
  process.env.NVIDIA_API_KEY_QWEN = 'fixture-wave03-key';
  let observedStream: unknown;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    observedStream = body.stream;
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const result = await new NvidiaAdapter().run({
      model: {
        id: 'nvidia:qwen-3.5',
        provider: 'nvidia',
        model: 'qwen/qwen3.5-397b-a17b',
        label: 'Qwen fixture',
        family: 'Qwen',
        description: 'fixture',
        aliases: ['qwen'],
        apiKeyEnv: 'NVIDIA_API_KEY_QWEN',
      },
      prompt: 'Reply with exactly: ok',
      cwd: REPO_ROOT,
      mode: 'plan',
    });
    assert.equal(observedStream, false);
    assert.equal(result.text, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.NVIDIA_API_KEY_QWEN;
    else process.env.NVIDIA_API_KEY_QWEN = previousKey;
  }
});
