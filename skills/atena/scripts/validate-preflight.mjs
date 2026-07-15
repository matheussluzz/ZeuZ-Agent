#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const [path, ...flags] = process.argv.slice(2);
if (!path || path === '--help') {
  process.stdout.write('Usage: node validate-preflight.mjs <preflight.json> [--allow-unconfirmed]\nValidates record structure only; it does not authorize, parse SQL, inspect AWS policy, predict cost, or prove correctness.\n');
  process.exit(path === '--help' ? 0 : 2);
}

const parsed = JSON.parse(await readFile(path, 'utf8'));
const errors = [];
const allowUnconfirmed = flags.includes('--allow-unconfirmed');
const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
const get = (keys) => keys.reduce((value, key) => value?.[key], record);
const requiredString = (keys, pattern) => {
  const value = get(keys);
  if (typeof value !== 'string' || !value.trim()) errors.push(`${keys.join('.')} must be a non-empty string`);
  else if (pattern && !pattern.test(value)) errors.push(`${keys.join('.')} has an invalid format`);
  return value;
};
const boundedNumber = (keys, minimum, maximum) => {
  const value = get(keys);
  if (!Number.isFinite(value) || value < minimum || value > maximum) errors.push(`${keys.join('.')} must be between ${minimum} and ${maximum}`);
};

if (record !== parsed) errors.push('root must be an object');
if (record.version !== 1) errors.push('version must be 1');
requiredString(['purpose', 'question']);
requiredString(['purpose', 'grain']);
requiredString(['purpose', 'audience']);
requiredString(['purpose', 'sensitivity']);
requiredString(['identity', 'accountId'], /^\d{12}$/);
requiredString(['identity', 'arn'], /^arn:aws(?:-[a-z]+)?:/);
requiredString(['identity', 'region'], /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/);
requiredString(['scope', 'catalog']);
requiredString(['scope', 'database']);
requiredString(['scope', 'workgroup']);
if (get(['scope', 'statementClass']) !== 'SELECT') errors.push('scope.statementClass must be SELECT');
const sql = requiredString(['scope', 'sql']);
const hash = requiredString(['scope', 'sqlSha256'], /^[a-f0-9]{64}$/i);
if (typeof sql === 'string' && typeof hash === 'string' && createHash('sha256').update(sql, 'utf8').digest('hex') !== hash.toLocaleLowerCase('en-US')) errors.push('scope.sqlSha256 does not match the exact visible scope.sql text');
const tables = get(['scope', 'tables']);
if (!Array.isArray(tables) || !tables.length) errors.push('scope.tables must contain at least one table');
else for (const [index, table] of tables.entries()) {
  if (!table || typeof table !== 'object') errors.push(`scope.tables[${index}] must be an object`);
  else {
    if (typeof table.name !== 'string' || !table.name.trim()) errors.push(`scope.tables[${index}].name is required`);
    if (!Array.isArray(table.columns) || !table.columns.length) errors.push(`scope.tables[${index}].columns must be non-empty`);
    if (typeof table.partitionPredicate !== 'string' || !table.partitionPredicate.trim()) errors.push(`scope.tables[${index}].partitionPredicate must record pruning or an approved exception`);
    if (typeof table.sensitivity !== 'string' || !table.sensitivity.trim()) errors.push(`scope.tables[${index}].sensitivity is required`);
  }
}
if (get(['plan', 'performed']) !== true || get(['plan', 'explainType']) !== 'IO') errors.push('plan must record a performed IO EXPLAIN');
if (!['low', 'medium', 'high'].includes(get(['plan', 'estimateConfidence']))) errors.push('plan.estimateConfidence must be low, medium, or high');
boundedNumber(['plan', 'estimatedScanBytes', 'minimum'], 0, Number.MAX_SAFE_INTEGER);
boundedNumber(['plan', 'estimatedScanBytes', 'maximum'], 0, Number.MAX_SAFE_INTEGER);
if (get(['plan', 'estimatedScanBytes', 'maximum']) < get(['plan', 'estimatedScanBytes', 'minimum'])) errors.push('estimated scan maximum must be >= minimum');
if (!Array.isArray(get(['plan', 'limitations'])) || !get(['plan', 'limitations']).length) errors.push('plan.limitations must record estimate limitations');
boundedNumber(['controls', 'workgroupBytesScannedCutoff'], 1, Number.MAX_SAFE_INTEGER);
boundedNumber(['controls', 'maxResultRows'], 1, 1000000);
boundedNumber(['controls', 'maxResultBytes'], 1, 1000000000);
boundedNumber(['controls', 'timeoutSeconds'], 1, 3600);
if (get(['controls', 'cancelOnTimeout']) !== true) errors.push('controls.cancelOnTimeout must be true');
if (!['managed', 'restricted-prefix'].includes(get(['controls', 'resultMode']))) errors.push('controls.resultMode must be managed or restricted-prefix');
if (get(['controls', 'encryptionVerified']) !== true) errors.push('controls.encryptionVerified must be true');
boundedNumber(['controls', 'resultReuseMaxAgeMinutes'], 0, 1440);
if (get(['controls', 'resultMode']) === 'managed' && get(['controls', 'resultReuseMaxAgeMinutes']) !== 0) errors.push('managed results do not support result reuse; max age must be 0');
if (!Array.isArray(record.exceptions)) errors.push('exceptions must be an array');
if (get(['plan', 'estimatedScanBytes', 'maximum']) > get(['controls', 'workgroupBytesScannedCutoff']) && (!Array.isArray(record.exceptions) || !record.exceptions.length)) errors.push('estimated scan maximum exceeds the workgroup cutoff; record the accepted consequence/exception');
if (get(['confirmation', 'required']) !== true) errors.push('confirmation.required must be true');
const expectedPhrase = typeof hash === 'string' ? `APPROVE ATHENA QUERY ${hash.slice(0, 12).toUpperCase()}` : '';
if (get(['confirmation', 'phrase']) !== expectedPhrase) errors.push(`confirmation.phrase must equal ${expectedPhrase || 'the hash-bound phrase'}`);
if (!allowUnconfirmed) {
  requiredString(['confirmation', 'confirmedBy']);
  requiredString(['confirmation', 'confirmedAt'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
}

function findSecretKeys(value, path = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:secret|password|credential|access.?key|session.?token)/i.test(key)) errors.push(`secret-like field is forbidden: ${[...path, key].join('.')}`);
    findSecretKeys(child, [...path, key]);
  }
}
findSecretKeys(record);

if (errors.length) {
  for (const error of errors) process.stderr.write(`FAIL: ${error}\n`);
  process.stderr.write('This validator checks record structure only and is not an AWS authorization or SQL security boundary.\n');
  process.exit(1);
}
process.stdout.write(`PASS: preflight record is structurally complete${allowUnconfirmed ? ' for review' : ' with confirmation metadata'}. This does not authorize, parse SQL, inspect AWS policy, predict cost, or prove correctness.\n`);
