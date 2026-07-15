import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-invariants.mjs', import.meta.url));

test('tracks lexical invariants and reports modality for manual review', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.txt');
  const complete = join(root, 'complete.txt');
  const missing = join(root, 'missing.txt');
  await writeFile(source, 'The API must retain 42% until 2026-07-14. See https://example.test/rule');
  await writeFile(complete, 'The API deve retain 42% until 2026-07-14. See https://example.test/rule');
  await writeFile(missing, 'The API deve retain the approved percentage. See https://example.test/rule');

  const pass = spawnSync(process.execPath, [checker, source, complete, '--json'], { encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr || pass.stdout);
  assert.deepEqual(JSON.parse(pass.stdout).manualReview, ['must']);
  const fail = spawnSync(process.execPath, [checker, source, missing, '--json'], { encoding: 'utf8' });
  assert.equal(fail.status, 1);
  assert.ok(JSON.parse(fail.stdout).missing.some((item) => item.kind === 'numeric'));
});
