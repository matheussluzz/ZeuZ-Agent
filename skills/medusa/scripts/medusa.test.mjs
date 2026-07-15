import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 5_000_000 });
}

function runNode(script, args, cwd) {
  return run(process.execPath, [resolve(scriptsDirectory, script), ...args], cwd);
}

function mustPass(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

async function createFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'zeuz-medusa-test-'));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(cwd, 'artifact.txt'), 'hello ZeuZ\n'),
    writeFile(join(cwd, 'request.md'), 'Create an artifact containing hello ZeuZ.\n'),
    writeFile(join(cwd, 'delivery.md'), 'Created artifact.txt.\n'),
    writeFile(join(cwd, 'verification.txt'), 'manual observation: artifact contains exact text\n'),
    writeFile(join(cwd, 'criteria.json'), `${JSON.stringify([{ id: 'REQ-001', text: 'artifact.txt contains hello ZeuZ', required: true, source: 'user' }], null, 2)}\n`),
  ]);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'ZeuZ Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['add', '.'],
    ['commit', '-qm', 'fixture'],
  ]) mustPass(run('git', args, cwd), `git ${args[0]}`);
  return cwd;
}

async function createPassingReview(t) {
  const cwd = await createFixture(t);
  const packetRelative = '.agents/reviews/review-packet.json';
  const reportRelative = '.agents/reviews/review-report.json';
  mustPass(runNode('evidence-packet.mjs', [
    '--workspace', cwd,
    '--request', 'request.md',
    '--criteria', 'criteria.json',
    '--delivery', 'delivery.md',
    '--verification', 'verification.txt',
    '--artifact', 'artifact.txt',
    '--producer-family', 'openai',
    '--out', packetRelative,
  ], cwd), 'generate evidence packet');

  const packetPath = join(cwd, packetRelative);
  const reportPath = join(cwd, reportRelative);
  const packet = JSON.parse(await readFile(packetPath, 'utf8'));
  const report = {
    schemaVersion: '1.0',
    packetFingerprint: packet.packetFingerprint,
    reviewer: { provider: 'cursor', model: 'fable', family: 'anthropic' },
    deterministicChecks: [{ id: 'CHK-001', command: 'inspect artifact.txt', status: 'PASS', required: true, evidence: 'exact content observed' }],
    criteria: [{ id: 'REQ-001', status: 'MET', evidence: ['artifact.txt contains the required text'], findingIds: [] }],
    verificationGaps: [{ id: 'GAP-001', changedBehavior: 'artifact content', assertion: 'exact content check', status: 'COVERED', evidence: 'CHK-001' }],
    findings: [],
    blockers: [],
    verdict: 'PASS',
    summary: 'Criterion met with direct evidence.',
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(reportPath, 0o600);
  return { cwd, packetPath, reportPath };
}

test('accepts a current, traceable cross-family PASS report', async (t) => {
  const fixture = await createPassingReview(t);
  const result = runNode('validate-review-report.mjs', [fixture.packetPath, fixture.reportPath], fixture.cwd);
  mustPass(result, 'validate PASS report');
  assert.match(result.stdout, /PASS: PASS report is structurally consistent/);
});

test('rejects a packet whose frozen criteria were tampered with', async (t) => {
  const fixture = await createPassingReview(t);
  const packet = JSON.parse(await readFile(fixture.packetPath, 'utf8'));
  packet.criteria[0].text = 'tampered criterion';
  await writeFile(fixture.packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  const result = runNode('validate-review-report.mjs', [fixture.packetPath, fixture.reportPath], fixture.cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fingerprint does not match packet contents/);
  assert.match(result.stderr, /parsed criteria do not match captured criteria input/);
});

test('rejects a verdict after the reviewed workspace changes', async (t) => {
  const fixture = await createPassingReview(t);
  await writeFile(join(fixture.cwd, 'artifact.txt'), 'changed after review\n');
  const result = runNode('validate-review-report.mjs', [fixture.packetPath, fixture.reportPath], fixture.cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workspace fingerprint is stale/);
});
