import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { afterEach } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const fixture = (...parts: string[]) => resolve(root, 'test', 'fixtures', ...parts);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

function node(script: string, ...args: string[]): string {
  return execFileSync(process.execPath, [resolve(root, script), ...args], { cwd: root, encoding: 'utf8' });
}

test('skill validators accept their safe fixtures', () => {
  assert.match(node('skills/metis/scripts/check-source-ledger.mjs', fixture('source-ledger.json')), /^PASS:/);
  assert.match(node('skills/prometeu/scripts/sql-policy.mjs', fixture('safe-query.sql')), /^PASS:/);
  assert.match(node('skills/clio/scripts/validate-vault.mjs', fixture('vault')), /^PASS:/);
  assert.match(execFileSync('python3', [resolve(root, 'skills/argos/scripts/leakage_audit.py'), fixture('features.csv')], { encoding: 'utf8' }), /^PASS:/);
});

test('Hefesto produces an offline dependency-free dashboard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zeuz-dashboard-'));
  temporary.push(directory);
  const output = join(directory, 'dashboard.html');
  node('skills/hefesto/scripts/build-dashboard.mjs', '--input', resolve(root, 'skills/hefesto/assets/sample-data.json'), '--output', output, '--mode', 'offline-basic');
  const html = await readFile(output, 'utf8');
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Mode: offline-basic/);
  assert.doesNotMatch(html, /code\.highcharts\.com/);
});
