import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDatasetReadOnlySql } from '../src/sql-policy.js';

test('accepts bounded select and CTE query shapes', () => {
  assert.equal(validateDatasetReadOnlySql('SELECT id FROM events WHERE dt = ? LIMIT 10').kind, 'query');
  assert.equal(validateDatasetReadOnlySql('WITH scoped AS (SELECT id FROM events) SELECT id FROM scoped').kind, 'query');
  assert.equal(validateDatasetReadOnlySql('EXPLAIN SELECT id FROM events').kind, 'explain');
});

test('rejects writes hidden after CTEs or comments and multiple statements', () => {
  assert.throws(() => validateDatasetReadOnlySql('WITH scoped AS (SELECT 1) INSERT INTO target SELECT * FROM scoped'), /Forbidden/);
  assert.throws(() => validateDatasetReadOnlySql('SELECT 1; DROP TABLE x'), /one SQL statement|Forbidden/);
  assert.throws(() => validateDatasetReadOnlySql('EXPLAIN ANALYZE SELECT 1'), /Forbidden/);
  assert.throws(() => validateDatasetReadOnlySql('/* comment */ UNLOAD (SELECT 1) TO \'s3:\/\/bucket\''), /Forbidden/);
});

test('does not treat forbidden words inside literals as operations', () => {
  assert.equal(validateDatasetReadOnlySql("SELECT 'DROP TABLE x' AS example").kind, 'query');
});
