import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseProgress, validateProgress } from './validate-progress.mjs';

const ledgerPath = fileURLToPath(new URL('../PROGRESS.md', import.meta.url));

test('the repository progress ledger is valid and starts at task 00001', async () => {
  const result = validateProgress(await readFile(ledgerPath, 'utf8'));
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.entries[0]?.task, 1);
});

test('the validator rejects task gaps, malformed headings, and missing status', () => {
  const result = validateProgress(`# ZeuZ progress ledger\n\n## 20260826182754678 - 00001 - fc4f2c7\n\n- Status: started\n\n## 20260826182754679 - 00003 - fc4f2c7\n\n- Task: skipped\n`);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('task numbering')));
  assert.ok(result.errors.some((error) => error.includes('missing or invalid status')));
});

test('the validator rejects secret-shaped content without exposing the value', () => {
  const shapedSecret = ['nvapi', 'fixture-value-123456789'].join('-');
  const result = validateProgress(`# ZeuZ progress ledger\n\n## 20260826182754678 - 00001 - fc4f2c7\n\n- Status: started\n- Note: ${shapedSecret}\n`);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['secret-shaped content found']);
});

test('the parser preserves repeated checkpoints for one task', () => {
  const entries = parseProgress(`# ZeuZ progress ledger\n\n## 20260826182754678 - 00001 - fc4f2c7\n\n- Status: started\n\n## 20260826182754679 - 00001 - fc4f2c7\n\n- Status: completed\n`);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].task, entries[1].task);
});
