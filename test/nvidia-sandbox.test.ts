import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { NvidiaAdapter, runSandboxedCommand } from '../src/adapters/nvidia.js';
import { requireModel } from '../src/catalog.js';
import { findExecutable } from '../src/process.js';

const roots: string[] = [];

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

test('direct NVIDIA plan commands cannot read workspace secret files', { skip: process.platform !== 'darwin' || !findExecutable('sandbox-exec') }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-nvidia-sandbox-'));
  roots.push(root);
  const secretFixture = `${['TEST_API_KEY', 'fixture-do-not-expose'].join('=')}\n`;
  await writeFile(join(root, 'safe.txt'), 'public fixture\n');
  await writeFile(join(root, '.env'), secretFixture, { mode: 0o600 });

  assert.match(runSandboxedCommand(root, 'cat safe.txt', 'plan'), /public fixture/);
  assert.throws(() => runSandboxedCommand(root, 'cat .env', 'plan'), /Command exited/);
  assert.match(runSandboxedCommand(root, "printf 'generated' > output.txt", 'agent'), /no output/);
  assert.equal(await readFile(join(root, 'output.txt'), 'utf8'), 'generated');
  assert.throws(() => runSandboxedCommand(root, "printf 'overwritten' > .env", 'agent'), /Command exited/);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), secretFixture);
});
