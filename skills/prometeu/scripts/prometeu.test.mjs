import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const linter = fileURLToPath(new URL('./sql-policy.mjs', import.meta.url));
const comparer = fileURLToPath(new URL('./compare-query-metrics.mjs', import.meta.url));
const metricsExample = fileURLToPath(new URL('../assets/metrics.example.json', import.meta.url));
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('rejects mutating SQL and compares only declared like-for-like metrics', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prometeu-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const safe = join(root, 'safe.sql');
  const unsafe = join(root, 'unsafe.sql');
  await writeFile(safe, 'SELECT customer_id, count(*) AS n FROM events WHERE event_date = DATE \'2026-07-14\' GROUP BY 1 LIMIT 10;');
  await writeFile(unsafe, 'DELETE FROM events;');
  assert.equal(run(linter, [safe, '--json']).status, 0);
  assert.equal(run(linter, [unsafe, '--json']).status, 1);

  const baseline = JSON.parse(await readFile(metricsExample, 'utf8'));
  baseline.label = 'baseline';
  const candidate = structuredClone(baseline);
  candidate.label = 'candidate';
  candidate.querySha256 = '1'.repeat(64);
  candidate.metrics.bytesScanned = baseline.metrics.bytesScanned / 2;
  const baselinePath = join(root, 'baseline.json');
  const candidatePath = join(root, 'candidate.json');
  await writeFile(baselinePath, JSON.stringify(baseline));
  await writeFile(candidatePath, JSON.stringify(candidate));
  assert.equal(run(comparer, [baselinePath, candidatePath, '--require-scan-improvement']).status, 0);

  candidate.context.dataSnapshot = 'different-snapshot';
  await writeFile(candidatePath, JSON.stringify(candidate));
  const incomparable = run(comparer, [baselinePath, candidatePath]);
  assert.equal(incomparable.status, 1);
  assert.match(incomparable.stderr, /not directly comparable/i);
});
