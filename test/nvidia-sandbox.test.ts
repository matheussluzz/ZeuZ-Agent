import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { NvidiaAdapter, runSandboxedCommand, safeWorkspacePath } from '../src/adapters/nvidia.js';
import { createDefaultAdapterRuntime } from '../src/adapters/runtime.js';
import { requireModel } from '../src/catalog.js';
import { findExecutable } from '../src/process.js';

const roots: string[] = [];

function sandboxExecCanApplyProfile(): boolean {
  const executable = findExecutable('sandbox-exec');
  if (!executable) return false;
  const probe = spawnSync(executable, ['-p', '(version 1) (allow default)', '/usr/bin/true'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return probe.status === 0;
}

async function* chunks(values: Array<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const value of values) yield typeof value === 'string' ? Buffer.from(value) : value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

test('NVIDIA HTTP failures do not expose provider account identifiers', async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.NVIDIA_API_KEY_QWEN;
  process.env.NVIDIA_API_KEY_QWEN = ['nvapi', 'fixture-value-123456'].join('-');
  globalThis.fetch = (async () => new Response(JSON.stringify({
    title: 'Not Found',
    detail: "Function 'internal-id': Not found for account 'private-account-id'",
  }), { status: 404, headers: { 'content-type': 'application/json' } })) as typeof fetch;

  try {
    await assert.rejects(
      async () => await new NvidiaAdapter().run({
        model: requireModel('nvidia:qwen-3.5'),
        prompt: 'Reply with exactly: ok',
        cwd: process.cwd(),
        mode: 'plan',
      }),
      (error: Error) => {
        assert.match(error.message, /endpoint is unavailable/);
        assert.doesNotMatch(error.message, /private-account-id|internal-id/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.NVIDIA_API_KEY_QWEN;
    else process.env.NVIDIA_API_KEY_QWEN = previousKey;
  }
});

test('direct NVIDIA route uses injected fragmented HTTP transport', async () => {
  const base = createDefaultAdapterRuntime();
  const payload = Buffer.from(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  let observedUrl = '';
  const runtime = {
    ...base,
    envGet: (name: string) => name === 'NVIDIA_API_KEY_QWEN' ? 'fixture-route-key' : undefined,
    httpRequest: async (input: import('../src/http-transport.js').HttpRequestInput) => {
      observedUrl = input.url;
      assert.equal(input.headers.Authorization, 'Bearer fixture-route-key');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        chunks: chunks([...payload].map((byte) => Uint8Array.of(byte))),
      };
    },
  };
  const result = await new NvidiaAdapter({ runtime }).run({
    model: requireModel('nvidia:qwen-3.5'),
    prompt: 'Reply with exactly: ok',
    cwd: process.cwd(),
    mode: 'plan',
  });
  assert.equal(result.text, 'ok');
  assert.match(observedUrl, /\/chat\/completions$/);
});

test('direct NVIDIA malformed and oversized HTTP bodies fail without exposing payload', async () => {
  const base = createDefaultAdapterRuntime();
  const model = requireModel('nvidia:qwen-3.5');
  const request = { model, prompt: 'Reply with exactly: ok', cwd: process.cwd(), mode: 'plan' as const };
  const malformed = new NvidiaAdapter({
    runtime: {
      ...base,
      envGet: (name) => name === 'NVIDIA_API_KEY_QWEN' ? 'fixture-route-key' : undefined,
      httpRequest: async () => ({ ok: true, status: 200, statusText: 'OK', chunks: chunks(['{malformed-secret-shaped']) }),
    },
  });
  await assert.rejects(() => malformed.run(request), (error: Error) => {
    assert.match(error.message, /malformed JSON/);
    assert.doesNotMatch(error.message, /secret-shaped/);
    return true;
  });

  const oversized = new NvidiaAdapter({
    runtime: {
      ...base,
      envGet: (name) => name === 'NVIDIA_API_KEY_QWEN' ? 'fixture-route-key' : undefined,
      httpRequest: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        chunks: chunks(['x'.repeat(8 * 1024 * 1024 + 1)]),
      }),
    },
  });
  await assert.rejects(() => oversized.run(request), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'UNSAFE_COMPLETION');
    assert.doesNotMatch(error.message, /xxxxx/);
    return true;
  });
});

test('direct NVIDIA plan commands cannot read workspace secret files', { skip: process.platform !== 'darwin' || !sandboxExecCanApplyProfile() }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-nvidia-sandbox-'));
  roots.push(root);
  const secretFixture = `${['TEST_API_KEY', 'fixture-do-not-expose'].join('=')}\n`;
  await writeFile(join(root, 'safe.txt'), 'public fixture\n');
  await writeFile(join(root, '.env'), secretFixture, { mode: 0o600 });

  assert.match(runSandboxedCommand(root, 'cat safe.txt', 'plan'), /public fixture/);
  assert.throws(() => runSandboxedCommand(root, 'cat .env', 'plan'), /credential-bearing filenames/);
  assert.match(runSandboxedCommand(root, "printf 'generated' > output.txt", 'agent'), /no output/);
  assert.equal(await readFile(join(root, 'output.txt'), 'utf8'), 'generated');
  assert.throws(() => runSandboxedCommand(root, "printf 'overwritten' > .env", 'agent'), /credential-bearing filenames/);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), secretFixture);
});

for (const command of [
  'git status; cat safe.txt',
  'git status && cat safe.txt',
  'cat $(pwd)/safe.txt',
  'git status > status.txt',
  'cat safe.txt | wc -l',
]) {
  test(`direct NVIDIA plan mode rejects shell composition: ${command}`, () => {
    assert.throws(() => runSandboxedCommand(process.cwd(), command, 'plan'), /Shell chaining, substitution, pipes, and redirects/);
  });
}

test('direct NVIDIA paths reject external roots and escaping symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-nvidia-path-'));
  const outside = await mkdtemp(join(tmpdir(), 'zeuz-nvidia-outside-'));
  roots.push(root, outside);
  await writeFile(join(outside, 'outside.txt'), 'outside fixture\n');
  await symlink(join(outside, 'outside.txt'), join(root, 'escape-link'));

  assert.throws(() => safeWorkspacePath(root, '../outside.txt'), /Path escapes the active workspace/);
  assert.throws(() => safeWorkspacePath(root, join(outside, 'outside.txt')), /Absolute paths are not allowed/);
  assert.throws(() => safeWorkspacePath(root, 'escape-link'), /Symlink escapes the active workspace/);
});

test('direct NVIDIA yolo shell is portable and receives a sanitized synthetic environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-nvidia-env-'));
  roots.push(root);
  const previous = process.env.ZEUZ_TEST_API_KEY;
  process.env.ZEUZ_TEST_API_KEY = ['synthetic', 'fixture', 'value'].join('-');
  try {
    const output = runSandboxedCommand(root, 'env', 'yolo');
    assert.doesNotMatch(output, /ZEUZ_TEST_API_KEY|synthetic-fixture-value/);
  } finally {
    if (previous === undefined) delete process.env.ZEUZ_TEST_API_KEY;
    else process.env.ZEUZ_TEST_API_KEY = previous;
  }
});
