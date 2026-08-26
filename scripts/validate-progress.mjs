#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const HEADER_PATTERN = /^## (\d{17}) - (\d{5}) - ([0-9a-f]{7,40})$/;
const STATUS_PATTERN = /^- Status: (started|in_progress|blocked|completed|verified)$/m;
const SECRET_PATTERNS = [
  /nvapi-[A-Za-z0-9_-]{16,}/,
  /sk-or-v1-[A-Za-z0-9_-]{16,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /gh[opusr]_[A-Za-z0-9]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function validTimestamp(value) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const millisecond = Number(value.slice(14, 17));
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59 || millisecond > 999) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second
    && date.getUTCMilliseconds() === millisecond;
}

export function parseProgress(content) {
  const lines = content.split(/\r?\n/);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADER_PATTERN.exec(lines[index]);
    if (!match) continue;
    let end = index + 1;
    while (end < lines.length && !HEADER_PATTERN.test(lines[end])) end += 1;
    entries.push({
      utid: `${match[1]} - ${match[2]} - ${match[3]}`,
      timestamp: match[1],
      task: Number(match[2]),
      commit: match[3],
      body: lines.slice(index + 1, end).join('\n'),
      line: index + 1,
    });
    index = end - 1;
  }
  return entries;
}

export function validateProgress(content) {
  const errors = [];
  const lines = content.split(/\r?\n/);
  if (!content.startsWith('# ZeuZ progress ledger')) errors.push('missing progress ledger title');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) errors.push('secret-shaped content found');

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('## ') && !HEADER_PATTERN.test(lines[index])) errors.push(`invalid UTID heading at line ${index + 1}`);
  }

  const entries = parseProgress(content);
  if (entries.length === 0) errors.push('no UTID entries found');
  const seen = new Set();
  let currentTask = 0;
  let previousTimestamp = '';
  for (const entry of entries) {
    if (!validTimestamp(entry.timestamp)) errors.push(`invalid UTC timestamp at line ${entry.line}`);
    if (entry.timestamp < previousTimestamp) errors.push(`timestamps are not in append order at line ${entry.line}`);
    previousTimestamp = entry.timestamp;
    if (entry.task < 1 || entry.task > 99_999) errors.push(`invalid task number at line ${entry.line}`);
    if (entry.task !== currentTask && entry.task !== currentTask + 1) {
      errors.push(`task numbering gap or out-of-order task at line ${entry.line}`);
    }
    if (entry.task === currentTask + 1) currentTask = entry.task;
    if (seen.has(entry.utid)) errors.push(`duplicate UTID at line ${entry.line}`);
    seen.add(entry.utid);
    if (!STATUS_PATTERN.test(entry.body)) errors.push(`missing or invalid status at line ${entry.line}`);
  }
  if (entries[0]?.task !== 1) errors.push('first task must be 00001');
  return { ok: errors.length === 0, entries, errors };
}

export function validateProgressFile(filePath = resolve('PROGRESS.md')) {
  return validateProgress(readFileSync(filePath, 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateProgressFile(process.argv[2] ? resolve(process.argv[2]) : undefined);
  if (!result.ok) {
    console.error('Progress ledger validation failed:');
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`Progress ledger valid (${result.entries.length} entries).`);
}
