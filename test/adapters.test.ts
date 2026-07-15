import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AgyAdapter } from '../src/adapters/agy.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CopilotAdapter } from '../src/adapters/copilot.js';
import { CursorAdapter } from '../src/adapters/cursor.js';
import { AdapterRegistry } from '../src/adapters/index.js';
import { NvidiaAdapter } from '../src/adapters/nvidia.js';
import {
  createDefaultAdapterRuntime,
  type AdapterRuntime,
} from '../src/adapters/runtime.js';
import { MODEL_CATALOG } from '../src/catalog.js';
import type { AgentEvent, ModelProfile, ProviderId } from '../src/types.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/adapters');

interface ExecutableFixture {
  file: string;
  mode: 'jsonl' | 'text';
  exitCode?: number;
  stderr?: string;
}

function testModel(provider: ProviderId, model = 'zeuz-fixture-model'): ModelProfile {
  return {
    id: `${provider}:fixture`,
    provider,
    model,
    label: 'Fixture model',
    family: 'Fixture',
    description: 'Synthetic adapter fixture model',
    aliases: ['fixture'],
  };
}

function createFixtureRuntime(
  fixtures: Record<string, ExecutableFixture>,
  overrides: Partial<AdapterRuntime> = {},
): AdapterRuntime {
  const base = createDefaultAdapterRuntime();
  const paths = new Map<string, ExecutableFixture>();
  for (const [name, spec] of Object.entries(fixtures)) {
    paths.set(`/fixture/bin/${name}`, spec);
  }

  return {
    findExecutable: (name) => (fixtures[name] ? `/fixture/bin/${name}` : undefined),
    resolveCodexExecutable: () => {
      if (!fixtures.codex) throw new Error('Fixture runtime blocked resolveCodexExecutable: codex fixture missing');
      return '/fixture/bin/codex';
    },
    runProcess: async (command, _args, options) => {
      const spec = paths.get(command);
      if (!spec) throw new Error(`Fixture runtime blocked runProcess: ${command}`);

      const stdout = readFileSync(join(FIXTURE_DIR, spec.file), 'utf8');
      if (spec.mode === 'jsonl') {
        for (const line of stdout.split(/\r?\n/).filter((value) => value.trim())) {
          options.onStdoutLine?.(line);
        }
      } else {
        options.onStdoutChunk?.(stdout);
      }

      return {
        exitCode: spec.exitCode ?? 0,
        stdout,
        stderr: spec.stderr ?? '',
      };
    },
    spawnSync: (executable, args) => {
      if (!paths.has(executable)) throw new Error(`Fixture runtime blocked spawnSync: ${executable}`);
      if (args[0] === '--version') {
        return { status: 0, stdout: 'zeuz-fixture 0.0.0', stderr: '' };
      }
      throw new Error(`Fixture runtime blocked spawnSync: ${executable} ${args.join(' ')}`);
    },
    now: () => 1_000,
    randomUUID: () => 'zeuz-fixture-copilot-session-0001',
    sanitizedChildEnvironment: (extra) => base.sanitizedChildEnvironment(extra),
    envGet: (name) => {
      if (name === 'NVIDIA_API_KEY_GLM_52') return 'zeuz-fixture-glm-route-key';
      return process.env[name];
    },
    ...overrides,
  };
}

async function runFixture(
  adapter: { run: (request: import('../src/types.js').RunRequest) => Promise<import('../src/types.js').RunResult> },
  model: ModelProfile,
): Promise<{ result: import('../src/types.js').RunResult; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const result = await adapter.run({
    model,
    prompt: 'zeuz fixture replay',
    cwd: FIXTURE_DIR,
    mode: 'agent',
    onEvent: (event) => events.push(event),
  });
  return { result, events };
}

async function capturedArgs(input: {
  adapter: { run: (request: import('../src/types.js').RunRequest) => Promise<import('../src/types.js').RunResult> };
  model: ModelProfile;
  runtime: AdapterRuntime;
  mode: 'plan' | 'agent' | 'yolo';
  resumeId?: string;
}): Promise<string[]> {
  let args: string[] | undefined;
  input.runtime.runProcess = async (_command, captured, options) => {
    args = captured;
    const line = readFileSync(join(FIXTURE_DIR, 'codex.jsonl'), 'utf8');
    for (const item of line.split(/\r?\n/).filter(Boolean)) options.onStdoutLine?.(item);
    return { exitCode: 0, stdout: line, stderr: '' };
  };
  await input.adapter.run({ model: input.model, prompt: 'characterize permissions', cwd: FIXTURE_DIR, mode: input.mode, ...(input.resumeId ? { resumeId: input.resumeId } : {}) });
  assert.ok(args);
  return args;
}

test('CodexAdapter replays sanitized fixture with session, usage, and tool events', async () => {
  const runtime = createFixtureRuntime({ codex: { file: 'codex.jsonl', mode: 'jsonl' } });
  const { result, events } = await runFixture(new CodexAdapter(runtime), testModel('codex'));

  assert.match(result.text, /Synthetic Codex fixture response/);
  assert.equal(result.nativeSessionId, 'zeuz-fixture-codex-thread-0001');
  assert.equal(result.usage?.total_tokens, 59);
  assert.ok(events.some((event) => event.type === 'tool' && event.status === 'started'));
  assert.ok(events.some((event) => event.type === 'tool' && event.status === 'completed'));
});

test('CursorAdapter replays sanitized fixture with deltas, session, and usage', async () => {
  const runtime = createFixtureRuntime({ 'cursor-agent': { file: 'cursor.jsonl', mode: 'jsonl' } });
  const { result, events } = await runFixture(new CursorAdapter(runtime), testModel('cursor'));

  assert.match(result.text, /Synthetic Cursor fixture response/);
  assert.equal(result.nativeSessionId, 'zeuz-fixture-cursor-session-0001');
  assert.equal(result.usage?.total_tokens, 52);
  assert.ok(events.some((event) => event.type === 'delta'));
  assert.ok(events.some((event) => event.type === 'tool' && event.text === 'zeuz-fixture-read'));
});

test('ClaudeAdapter replays sanitized fixture with deltas, session, and usage', async () => {
  const runtime = createFixtureRuntime({ claude: { file: 'claude.jsonl', mode: 'jsonl' } });
  const { result, events } = await runFixture(new ClaudeAdapter(runtime), testModel('claude'));

  assert.match(result.text, /Synthetic Claude fixture response/);
  assert.equal(result.nativeSessionId, 'zeuz-fixture-claude-session-0001');
  assert.equal(result.usage?.total_tokens, 55);
  assert.ok(events.some((event) => event.type === 'delta'));
  assert.ok(events.some((event) => event.type === 'tool' && event.text === 'zeuz-fixture-bash'));
});

test('CopilotAdapter replays sanitized fixture with deltas, session id, and usage', async () => {
  const runtime = createFixtureRuntime({ copilot: { file: 'copilot.jsonl', mode: 'jsonl' } });
  const { result, events } = await runFixture(new CopilotAdapter({ runtime }), testModel('copilot'));

  assert.match(result.text, /Synthetic Copilot fixture response/);
  assert.equal(result.nativeSessionId, 'zeuz-fixture-copilot-session-0001');
  assert.equal(result.usage?.total_tokens, 43);
  assert.ok(events.some((event) => event.type === 'delta'));
  assert.ok(events.some((event) => event.type === 'tool' && event.text === 'zeuz-fixture-shell'));
});

test('NvidiaAdapter replays GLM fixture through injected Copilot path', async () => {
  const runtime = createFixtureRuntime({ copilot: { file: 'nvidia.jsonl', mode: 'jsonl' } });
  const copilot = new CopilotAdapter({ provider: 'nvidia', nvidia: true, runtime });
  const glm = MODEL_CATALOG.find((model) => model.id === 'nvidia:glm-5.2');
  assert.ok(glm);
  const adapter = new NvidiaAdapter({ runtime, copilot });
  const { result, events } = await runFixture(adapter, glm);

  assert.match(result.text, /\[zeuz-nvidia-glm-fixture\]/);
  assert.equal(result.nativeSessionId, 'zeuz-fixture-copilot-session-0001');
  assert.equal(result.usage?.provider, 'nvidia-glm-fixture');
  assert.ok(events.some((event) => event.type === 'tool' && event.text === 'zeuz-fixture-read_file'));
});

test('AgyAdapter replays sanitized plain-text fixture', async () => {
  const runtime = createFixtureRuntime({ agy: { file: 'agy.txt', mode: 'text' } });
  const { result, events } = await runFixture(new AgyAdapter(runtime), testModel('agy'));

  assert.match(result.text, /Synthetic Antigravity fixture response/);
  assert.equal(result.nativeSessionId, undefined);
  assert.equal(result.usage, undefined);
  assert.ok(events.some((event) => event.type === 'delta'));
});

test('CodexAdapter rejects non-zero fixture exit', async () => {
  const runtime = createFixtureRuntime({
    codex: { file: 'codex.jsonl', mode: 'jsonl', exitCode: 2, stderr: 'fixture exit failure' },
  });
  await assert.rejects(
    () => runFixture(new CodexAdapter(runtime), testModel('codex')),
  );
});

test('characterizes Codex resume omitting the requested plan sandbox before Wave 02', async () => {
  const runtime = createFixtureRuntime({ codex: { file: 'codex.jsonl', mode: 'jsonl' } });
  const args = await capturedArgs({ adapter: new CodexAdapter(runtime), model: testModel('codex'), runtime, mode: 'plan', resumeId: 'existing-thread' });
  assert.deepEqual(args.slice(0, 5), ['exec', 'resume', '--json', '--skip-git-repo-check', '-m']);
  assert.equal(args.includes('-s'), false);
  assert.equal(args.includes('read-only'), false);
});

test('CursorAdapter rejects fixture without final response', async () => {
  const partialRuntime: AdapterRuntime = {
    ...createFixtureRuntime({ 'cursor-agent': { file: 'cursor.jsonl', mode: 'jsonl' } }),
    runProcess: async (_command, _args, options) => {
      const stdout = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"zeuz-fixture-read"}]}}\n';
      for (const line of stdout.split('\n').filter((value) => value.trim())) {
        options.onStdoutLine?.(line);
      }
      return { exitCode: 0, stdout, stderr: '' };
    },
  };
  await assert.rejects(
    () => runFixture(new CursorAdapter(partialRuntime), testModel('cursor')),
    /without a final response/,
  );
});

test('AdapterRegistry preserves default construction', () => {
  const registry = new AdapterRegistry();
  assert.equal(registry.all().length, 6);
  assert.equal(registry.get('codex').provider, 'codex');
});

test('AdapterRegistry accepts injected adapters and factory', () => {
  const runtime = createFixtureRuntime({ codex: { file: 'codex.jsonl', mode: 'jsonl' } });
  const injected = new CodexAdapter(runtime);
  const registry = new AdapterRegistry({
    runtime,
    adapters: { codex: injected },
    factory: (provider, factoryRuntime) => new CursorAdapter(factoryRuntime),
  });

  assert.equal(registry.get('codex'), injected);
  assert.equal(registry.get('cursor').provider, 'cursor');
  assert.equal(registry.all().length, 6);
});
