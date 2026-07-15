#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const [baselinePath, candidatePath, ...flags] = process.argv.slice(2);
if (!baselinePath || !candidatePath || baselinePath === '--help') {
  process.stdout.write('Usage: node compare-query-metrics.mjs <baseline.json> <candidate.json> [--require-scan-improvement] [--json]\nChecks recorded comparability and arithmetic only; it does not prove semantic equivalence or measurement quality.\n');
  process.exit(baselinePath === '--help' ? 0 : 2);
}

const [baseline, candidate] = await Promise.all([
  readFile(baselinePath, 'utf8').then(JSON.parse),
  readFile(candidatePath, 'utf8').then(JSON.parse),
]);
const errors = [];
const warnings = [];
const hashPattern = /^[a-f0-9]{64}$/i;
const comparableFields = ['dialect', 'engineVersion', 'workgroup', 'dataSnapshot', 'parametersSha256', 'resultReuse'];

function validate(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) { errors.push(`${label}: root must be an object`); return; }
  if (typeof record.label !== 'string' || !record.label.trim()) errors.push(`${label}: label is required`);
  if (!hashPattern.test(record.querySha256 ?? '')) errors.push(`${label}: querySha256 must be 64 hexadecimal characters`);
  if (!record.context || typeof record.context !== 'object') errors.push(`${label}: context is required`);
  if (!hashPattern.test(record.context?.parametersSha256 ?? '')) errors.push(`${label}: context.parametersSha256 must be 64 hexadecimal characters`);
  for (const field of ['bytesScanned', 'engineMilliseconds', 'wallMilliseconds', 'rowsReturned']) {
    const value = record.metrics?.[field];
    if (!Number.isFinite(value) || value < 0) errors.push(`${label}: metrics.${field} must be a non-negative finite number`);
  }
  if (!Array.isArray(record.checks) || !record.checks.length) errors.push(`${label}: checks must contain independent correctness evidence`);
  else for (const [index, check] of record.checks.entries()) {
    if (typeof check?.name !== 'string' || !check.name.trim()) errors.push(`${label}: checks[${index}].name is required`);
    if (check?.passed !== true) errors.push(`${label}: checks[${index}] did not pass`);
    if (typeof check?.evidence !== 'string' || !check.evidence.trim()) errors.push(`${label}: checks[${index}].evidence is required`);
  }
  if (!Array.isArray(record.limitations)) errors.push(`${label}: limitations must be an array`);
}

validate(baseline, 'baseline');
validate(candidate, 'candidate');
for (const field of comparableFields) {
  if (baseline.context?.[field] !== candidate.context?.[field]) errors.push(`runs are not directly comparable: context.${field} differs`);
}
const baselineChecks = new Set((baseline.checks ?? []).map((check) => check?.name));
const candidateChecks = new Set((candidate.checks ?? []).map((check) => check?.name));
for (const name of baselineChecks) if (!candidateChecks.has(name)) errors.push(`candidate is missing baseline correctness check: ${name}`);
for (const name of candidateChecks) if (!baselineChecks.has(name)) warnings.push(`candidate adds a check not present in the baseline: ${name}`);

const reduction = (before, after) => before === 0 ? (after === 0 ? 0 : null) : ((before - after) / before) * 100;
const deltas = {
  bytesScannedPercentReduction: reduction(baseline.metrics?.bytesScanned, candidate.metrics?.bytesScanned),
  engineTimePercentReduction: reduction(baseline.metrics?.engineMilliseconds, candidate.metrics?.engineMilliseconds),
  wallTimePercentReduction: reduction(baseline.metrics?.wallMilliseconds, candidate.metrics?.wallMilliseconds),
  returnedRowDifference: (candidate.metrics?.rowsReturned ?? 0) - (baseline.metrics?.rowsReturned ?? 0),
};
if (deltas.returnedRowDifference !== 0) warnings.push('returned row count differs; this may be valid, but requires explicit semantic evidence');
if (flags.includes('--require-scan-improvement') && !(candidate.metrics?.bytesScanned < baseline.metrics?.bytesScanned)) errors.push('candidate did not reduce recorded bytes scanned');

const result = {
  pass: errors.length === 0,
  directlyComparable: !errors.some((error) => error.startsWith('runs are not directly comparable')),
  deltas,
  errors,
  warnings,
  disclaimer: 'Recorded comparability and arithmetic only; passing does not prove semantic equivalence, unbiased measurement, or an optimization claim.',
};
if (flags.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  for (const warning of warnings) process.stderr.write(`WARN: ${warning}\n`);
  for (const error of errors) process.stderr.write(`FAIL: ${error}\n`);
  process.stdout.write(`${JSON.stringify(deltas, null, 2)}\n`);
  if (result.pass) process.stdout.write(`PASS: recorded runs are comparable under declared fields and checks passed. ${result.disclaimer}\n`);
  else process.stderr.write(`${result.disclaimer}\n`);
}
process.exit(result.pass ? 0 : 1);
