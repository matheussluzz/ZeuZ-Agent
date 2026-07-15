import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { loadConfig } from '../src/config.js';

const relevant = [
  'AWS_REGION',
  'ZEUZ_AWS_ALLOWED_ACCOUNT',
  'ZEUZ_ATHENA_WORKGROUP',
  'ZEUZ_ATHENA_CATALOG',
  'ZEUZ_ATHENA_DATABASE_ALLOWLIST',
  'ZEUZ_ATHENA_MAX_ROWS',
  'ZEUZ_ATHENA_TIMEOUT_MS',
  'ZEUZ_ATHENA_OUTPUT_LOCATION',
] as const;
const original = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of relevant) original.set(name, process.env[name]);
  process.env.AWS_REGION = 'us-east-1';
  process.env.ZEUZ_AWS_ALLOWED_ACCOUNT = '123456789012';
  process.env.ZEUZ_ATHENA_WORKGROUP = 'zeuz-read-only';
  process.env.ZEUZ_ATHENA_DATABASE_ALLOWLIST = 'analytics,product';
  for (const name of ['ZEUZ_ATHENA_CATALOG', 'ZEUZ_ATHENA_MAX_ROWS', 'ZEUZ_ATHENA_TIMEOUT_MS', 'ZEUZ_ATHENA_OUTPUT_LOCATION']) delete process.env[name];
});

afterEach(() => {
  for (const name of relevant) {
    const value = original.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('loads bounded safe defaults', () => {
  const config = loadConfig();
  assert.equal(config.allowedAccount, '123456789012');
  assert.equal(config.maxRows, 500);
  assert.equal(config.timeoutMs, 60_000);
  assert.deepEqual([...config.databases], ['analytics', 'product']);
});

test('rejects malformed numeric, account, and output configuration', () => {
  process.env.ZEUZ_ATHENA_MAX_ROWS = 'NaN';
  assert.throws(() => loadConfig(), /must be an integer/);
  process.env.ZEUZ_ATHENA_MAX_ROWS = '100';
  process.env.ZEUZ_AWS_ALLOWED_ACCOUNT = 'production';
  assert.throws(() => loadConfig(), /12-digit/);
  process.env.ZEUZ_AWS_ALLOWED_ACCOUNT = '123456789012';
  process.env.ZEUZ_ATHENA_OUTPUT_LOCATION = 'https://example.com/results';
  assert.throws(() => loadConfig(), /valid s3:\/\//);
});
