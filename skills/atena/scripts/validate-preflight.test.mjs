import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const validator = fileURLToPath(new URL('./validate-preflight.mjs', import.meta.url));
const example = fileURLToPath(new URL('../assets/preflight.example.json', import.meta.url));
const run = (path, ...args) => spawnSync(process.execPath, [validator, path, ...args], { encoding: 'utf8' });

test('requires hash-bound confirmation after review preflight', async (t) => {
  const review = run(example, '--allow-unconfirmed');
  assert.equal(review.status, 0, review.stderr);
  assert.equal(run(example).status, 1);

  const root = await mkdtemp(join(tmpdir(), 'atena-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = JSON.parse(await readFile(example, 'utf8'));
  record.confirmation.confirmedBy = 'authorized-user';
  record.confirmation.confirmedAt = '2026-07-14T12:00:00-03:00';
  const confirmed = join(root, 'confirmed.json');
  await writeFile(confirmed, JSON.stringify(record));
  assert.equal(run(confirmed).status, 0);

  record.apiSecret = 'forbidden-even-as-a-field-name';
  const unsafe = join(root, 'unsafe.json');
  await writeFile(unsafe, JSON.stringify(record));
  const rejected = run(unsafe);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /secret-like field/i);
});
