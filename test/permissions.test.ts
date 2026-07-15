import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AgyAdapter } from '../src/adapters/agy.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { CopilotAdapter } from '../src/adapters/copilot.js';
import { CursorAdapter } from '../src/adapters/cursor.js';
import { NvidiaAdapter } from '../src/adapters/nvidia.js';
import { createDefaultAdapterRuntime, type AdapterRuntime } from '../src/adapters/runtime.js';
import { requireModel } from '../src/catalog.js';
import { permissionCapability, UnsupportedCapabilityError } from '../src/permissions.js';
import type { AgentAdapter, ModelProfile, PermissionMode, ProviderId } from '../src/types.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/adapters');

function model(provider: Exclude<ProviderId, 'nvidia'>): ModelProfile {
  return {
    id: `${provider}:permission-fixture`,
    provider,
    model: 'permission-fixture',
    label: 'Permission fixture',
    family: 'Fixture',
    description: 'Permission conformance fixture',
    aliases: [],
  };
}

function harness(provider: ProviderId): { adapter: AgentAdapter; model: ModelProfile; calls: string[][] } {
  const calls: string[][] = [];
  const base = createDefaultAdapterRuntime();
  const fixture = provider === 'nvidia' ? 'nvidia.jsonl' : provider === 'agy' ? 'agy.txt' : `${provider}.jsonl`;
  const executable = provider === 'cursor' ? 'cursor-agent' : provider === 'nvidia' ? 'copilot' : provider;
  const path = `/fixture/bin/${executable}`;
  const runtime: AdapterRuntime = {
    findExecutable: (name) => name === executable ? path : undefined,
    resolveCodexExecutable: () => path,
    runProcess: async (_command, args, options) => {
      calls.push(args);
      const stdout = readFileSync(join(FIXTURE_DIR, fixture), 'utf8');
      if (provider === 'agy') options.onStdoutChunk?.(stdout);
      else for (const line of stdout.split(/\r?\n/).filter(Boolean)) options.onStdoutLine?.(line);
      return { exitCode: 0, stdout, stderr: '' };
    },
    spawnSync: () => ({ status: 0, stdout: 'fixture', stderr: '' }),
    now: () => 1,
    randomUUID: () => 'permission-session',
    sanitizedChildEnvironment: (extra) => base.sanitizedChildEnvironment(extra),
    envGet: (name) => name === 'NVIDIA_API_KEY_GLM_52' ? 'fixture-route-key' : undefined,
    httpRequest: base.httpRequest,
  };

  if (provider === 'codex') return { adapter: new CodexAdapter(runtime), model: model(provider), calls };
  if (provider === 'cursor') return { adapter: new CursorAdapter(runtime), model: model(provider), calls };
  if (provider === 'claude') return { adapter: new ClaudeAdapter(runtime), model: model(provider), calls };
  if (provider === 'copilot') return { adapter: new CopilotAdapter({ runtime }), model: model(provider), calls };
  if (provider === 'agy') return { adapter: new AgyAdapter(runtime), model: model(provider), calls };
  const copilot = new CopilotAdapter({ provider: 'nvidia', nvidia: true, runtime });
  return { adapter: new NvidiaAdapter({ runtime, copilot }), model: requireModel('nvidia:glm-5.2'), calls };
}

function containsSequence(args: string[], expected: readonly string[]): boolean {
  return expected.every((value, index) => args.slice(index).includes(value));
}

for (const provider of ['codex', 'cursor', 'claude', 'copilot', 'agy', 'nvidia'] as const) {
  for (const mode of ['plan', 'agent', 'yolo'] as const) {
    test(`${provider} applies the shared ${mode} permission capability to new sessions`, async () => {
      const fixture = harness(provider);
      await fixture.adapter.run({ model: fixture.model, prompt: 'permission fixture', cwd: FIXTURE_DIR, mode });
      assert.equal(fixture.calls.length, 1);
      assert.equal(containsSequence(fixture.calls[0] ?? [], permissionCapability(provider, mode).nativeArguments), true);
    });
  }

  for (const mode of ['plan', 'agent', 'yolo'] as const) {
    test(`${provider} resume is fail-closed and preserves the requested ${mode} capability`, async () => {
      const fixture = harness(provider);
      const request = { model: fixture.model, prompt: 'resume permission fixture', cwd: FIXTURE_DIR, mode: mode as PermissionMode, resumeId: 'existing-session' };
      if (provider === 'agy') {
        await assert.rejects(() => fixture.adapter.run(request), UnsupportedCapabilityError);
        assert.equal(fixture.calls.length, 0);
        return;
      }
      await fixture.adapter.run(request);
      assert.equal(containsSequence(fixture.calls[0] ?? [], permissionCapability(provider, mode).nativeArguments), true);
    });
  }
}

test('NVIDIA Copilot route receives only its selected synthetic provider key', async () => {
  const calls: NodeJS.ProcessEnv[] = [];
  const base = createDefaultAdapterRuntime();
  const stdout = readFileSync(join(FIXTURE_DIR, 'nvidia.jsonl'), 'utf8');
  const runtime: AdapterRuntime = {
    findExecutable: (name) => name === 'copilot' ? '/fixture/bin/copilot' : undefined,
    resolveCodexExecutable: () => '/fixture/bin/codex',
    runProcess: async (_command, _args, options) => {
      calls.push(options.env ?? {});
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) options.onStdoutLine?.(line);
      return { exitCode: 0, stdout, stderr: '' };
    },
    spawnSync: () => ({ status: 0, stdout: 'fixture', stderr: '' }),
    now: () => 1,
    randomUUID: () => 'permission-session',
    sanitizedChildEnvironment: (extra) => ({ ...base.sanitizedChildEnvironment(), ...extra }),
    envGet: (name) => name === 'NVIDIA_API_KEY_GLM_52' ? 'selected-fixture-key' : name === 'NVIDIA_API_BASE_URL' ? 'https://example.invalid/v1' : undefined,
    httpRequest: base.httpRequest,
  };
  const copilot = new CopilotAdapter({ provider: 'nvidia', nvidia: true, runtime });
  await new NvidiaAdapter({ runtime, copilot }).run({ model: requireModel('nvidia:glm-5.2'), prompt: 'fixture', cwd: FIXTURE_DIR, mode: 'plan' });

  assert.equal(calls[0]?.COPILOT_PROVIDER_API_KEY, 'selected-fixture-key');
  assert.equal(calls[0]?.NVIDIA_API_KEY_GLM_52, undefined);
  assert.equal(calls[0]?.AWS_SECRET_ACCESS_KEY, undefined);
});
