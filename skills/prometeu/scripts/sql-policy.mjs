#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const [path, ...flags] = process.argv.slice(2);
if (!path || path === '--help') {
  process.stdout.write('Usage: node sql-policy.mjs <file.sql> [--json]\nThis is a conservative lexical linter, not a parser, authorization check, correctness proof, or security boundary.\n');
  process.exit(path ? 0 : 2);
}

const raw = await readFile(path, 'utf8');
const stripped = raw
  .replace(/--[^\n]*/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/'(?:''|[^'])*'/g, "''")
  .replace(/"(?:""|[^"])*"/g, '""');
const normalized = stripped.replace(/\s+/g, ' ').trim();
const errors = [];
const warnings = [];

if (!normalized) errors.push('query is empty');
if ((normalized.match(/;/g) ?? []).length > 1 || (/;/.test(normalized) && !/;\s*$/.test(normalized))) errors.push('multiple or embedded statements are not allowed');
if (!/^(?:SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(normalized)) errors.push('statement is outside the conservative read-only allowlist');
const forbidden = normalized.match(/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|UNLOAD|MSCK|VACUUM|OPTIMIZE|PREPARE|EXECUTE|CALL|ANALYZE)\b/gi);
if (forbidden) errors.push(`forbidden keywords: ${[...new Set(forbidden.map((word) => word.toUpperCase()))].join(', ')}`);
if (/^EXPLAIN\s+ANALYZE\b/i.test(normalized)) errors.push('EXPLAIN ANALYZE executes the query');
if (/\bSELECT\s+(?:[A-Za-z_][\w$]*\.)?\*/i.test(normalized)) warnings.push('SELECT * or alias.* can increase scan cost and weaken schema contracts');
if (!/\b(?:WHERE|LIMIT)\b/i.test(normalized) && /\bSELECT\b/i.test(normalized)) warnings.push('no WHERE or LIMIT detected; verify partition and result bounds');
if (/\bUNION\b(?!\s+ALL\b)/i.test(normalized)) warnings.push('UNION deduplicates; verify UNION ALL is not sufficient');
if (/\bCROSS\s+JOIN\b/i.test(normalized)) warnings.push('CROSS JOIN can multiply rows; document the expected cardinality and bound it');
if (/\bNOT\s+IN\s*\(/i.test(normalized)) warnings.push('NOT IN has surprising null semantics; prove behavior or prefer a null-safe anti-join pattern');
if (/\bORDER\s+BY\b/i.test(normalized) && !/\bLIMIT\b/i.test(normalized)) warnings.push('full ORDER BY can be expensive; verify global ordering is part of the contract');
if (/\bLIMIT\b/i.test(normalized)) warnings.push('LIMIT bounds returned rows, not necessarily bytes scanned');

const result = {
  pass: errors.length === 0,
  errors,
  warnings,
  disclaimer: 'Lexical preflight only; use a dialect-compatible parser plus authorization, execution controls, and independent correctness tests.',
};
if (flags.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  for (const warning of warnings) process.stderr.write(`WARN: ${warning}\n`);
  for (const error of errors) process.stderr.write(`FAIL: ${error}\n`);
  if (result.pass) process.stdout.write(`PASS: conservative SQL preflight completed. ${result.disclaimer}\n`);
}
process.exit(result.pass ? 0 : 1);
