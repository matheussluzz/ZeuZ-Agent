#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const [packetArgument, outputArgument] = process.argv.slice(2);
if (!packetArgument || packetArgument === '--help') {
  process.stdout.write('Usage: node init-review-report.mjs <review-packet.json> [review-report.json]\n');
  process.exit(packetArgument === '--help' ? 0 : 2);
}

try {
  const packetPath = resolve(packetArgument);
  const packetStat = await lstat(packetPath);
  if (packetStat.isSymbolicLink() || !packetStat.isFile()) throw new Error('Packet must be a regular non-symlink file.');
  if (process.platform !== 'win32' && (packetStat.mode & 0o077) !== 0) throw new Error('Packet must use mode 0600.');
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && packetStat.uid !== process.getuid()) throw new Error('Packet must be owned by the active OS user.');
  const packet = JSON.parse(await readFile(packetPath, 'utf8'));
  if (packet.schemaVersion !== '1.0' || !packet.packetFingerprint || !packet.workspace?.cwd || !packet.producer?.provider || !packet.producer?.model || !packet.producer?.family || !Array.isArray(packet.criteria)) throw new Error('Packet does not have the Medusa 1.0 shape.');

  const workspace = await realpath(packet.workspace.cwd);
  const reviewRoot = await realpath(resolve(workspace, '.agents/reviews'));
  const packetReal = await realpath(packetPath);
  const packetRelative = relative(workspace, packetReal).replaceAll('\\', '/');
  if (!packetRelative.startsWith('.agents/reviews/') || packetRelative.slice('.agents/reviews/'.length).includes('/')) throw new Error('Packet must be a direct child of workspace .agents/reviews/.');
  const output = resolve(workspace, outputArgument ?? '.agents/reviews/review-report.json');
  const outputParent = await realpath(dirname(output));
  if (outputParent !== reviewRoot) throw new Error('Output must be a direct child of workspace .agents/reviews/.');
  try {
    const existing = await lstat(output);
    if (existing) throw new Error('Output already exists; refusing to overwrite review evidence.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const report = {
    schemaVersion: '1.0',
    packetFingerprint: packet.packetFingerprint,
    reviewer: { provider: 'unassigned', model: 'unassigned', family: 'unassigned' },
    deterministicChecks: [{ id: 'CHK-001', command: 'not run', status: 'BLOCKED', required: true, evidence: 'Independent review has not started.' }],
    criteria: packet.criteria.map((criterion) => ({ id: criterion.id, status: 'UNVERIFIED', evidence: ['Independent reviewer has not evaluated this criterion.'], findingIds: [] })),
    verificationGaps: [{ id: 'GAP-001', changedBehavior: packet.artifacts?.join(', ') || 'artifact set', assertion: 'not evaluated', status: 'GAP', evidence: 'Independent verification-gap pass has not run.' }],
    findings: [],
    blockers: ['Independent cross-family review has not been completed.'],
    verdict: 'REVIEW_BLOCKED',
    summary: 'Initialized only; no review verdict is available yet.',
  };
  const handle = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  process.stdout.write(`WROTE ${output} with verdict REVIEW_BLOCKED\n`);
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exit(1);
}
