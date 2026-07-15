#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { containsSecretShape, isPublicTrackedTemplate, isSensitivePath } from './trust-policy.mjs';

const REVIEW_EXCLUDE = ':(exclude).agents/reviews/**';

const [packetPath, reportPath] = process.argv.slice(2);
if (!packetPath || !reportPath || packetPath === '--help') {
  process.stdout.write('Usage: node validate-review-report.mjs <review-packet.json> <review-report.json>\n');
  process.exit(packetPath === '--help' ? 0 : 2);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const array = (value) => Array.isArray(value) ? value : [];

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 100_000_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.replace(/\r\n/g, '\n').trimEnd();
}

async function currentWorkspaceFingerprint(cwd) {
  const trackedSensitive = git(cwd, ['ls-files']).split('\n').filter(Boolean).filter(isSensitivePath);
  const denied = trackedSensitive.filter((path) => !isPublicTrackedTemplate(path));
  if (denied.length) throw new Error(`tracked credential paths present: ${denied.join(', ')}`);
  for (const template of trackedSensitive.filter(isPublicTrackedTemplate)) {
    if (containsSecretShape(await readFile(resolve(cwd, template), 'utf8'))) throw new Error(`tracked public template contains secret-shaped content: ${template}`);
  }
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const status = git(cwd, ['status', '--short', '--untracked-files=all', '--', '.', REVIEW_EXCLUDE]);
  const diff = git(cwd, ['diff', '--binary', 'HEAD', '--', '.', REVIEW_EXCLUDE]);
  const names = git(cwd, ['ls-files', '--others', '--exclude-standard', '--', '.', REVIEW_EXCLUDE]).split('\n').filter(Boolean).sort();
  const untracked = [];
  for (const name of names) {
    const path = resolve(cwd, name);
    const stat = await lstat(path);
    if (isSensitivePath(name)) untracked.push({ path: name, type: 'denied-sensitive', size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode });
    else if (stat.isSymbolicLink()) untracked.push({ path: name, type: 'symlink', sha256: sha256(await readlink(path)) });
    else if (stat.isFile()) untracked.push({ path: name, type: 'file', sha256: sha256(await readFile(path)) });
  }
  return sha256(JSON.stringify({ head, status, diffSha256: sha256(diff), untracked }));
}

const packetAbsolute = resolve(packetPath);
const reportAbsolute = resolve(reportPath);
const fileErrors = [];
for (const [label, path] of [['packet', packetAbsolute], ['report', reportAbsolute]]) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) fileErrors.push(`${label} must be a regular non-symlink file`);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fileErrors.push(`${label} must not be group/world-readable; use mode 0600`);
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) fileErrors.push(`${label} must be owned by the active OS user`);
  } catch (error) {
    fileErrors.push(`${label} cannot be inspected (${error.message})`);
  }
}
if (fileErrors.length) {
  process.stderr.write(`${fileErrors.join('\n')}\n`);
  process.exit(1);
}
const packet = JSON.parse(await readFile(packetAbsolute, 'utf8'));
const report = JSON.parse(await readFile(reportAbsolute, 'utf8'));
const errors = [];
const requireText = (object, field, label) => {
  if (!isText(object?.[field])) errors.push(`${label}: missing ${field}`);
};
const uniqueIds = (items, label) => {
  const seen = new Set();
  for (const [index, item] of array(items).entries()) {
    if (!isText(item?.id)) errors.push(`${label} ${index + 1}: missing id`);
    else if (seen.has(item.id)) errors.push(`${label}: duplicate id ${item.id}`);
    else seen.add(item.id);
  }
  return seen;
};

for (const [field, value] of [
  ['packet.blockers', packet.blockers],
  ['packet.criteria', packet.criteria],
  ['packet.artifacts', packet.artifacts],
  ['report.deterministicChecks', report.deterministicChecks],
  ['report.criteria', report.criteria],
  ['report.verificationGaps', report.verificationGaps],
  ['report.findings', report.findings],
  ['report.blockers', report.blockers],
]) {
  if (!Array.isArray(value)) errors.push(`${field}: must be an array`);
}

if (packet.schemaVersion !== '1.0') errors.push('packet: unsupported schemaVersion');
if (report.schemaVersion !== '1.0') errors.push('report: unsupported schemaVersion');
if (report.packetFingerprint !== packet.packetFingerprint) errors.push('report: packetFingerprint mismatch');
const { packetFingerprint: _packetFingerprint, ...unsignedPacket } = packet;
const expectedPacketFingerprint = sha256(JSON.stringify(unsignedPacket));
if (expectedPacketFingerprint !== packet.packetFingerprint) errors.push('packet: fingerprint does not match packet contents');
try {
  const workspaceReal = await realpath(packet.workspace?.cwd);
  const expectedPrefix = '.agents/reviews/';
  for (const [label, path] of [['packet', packetAbsolute], ['report', reportAbsolute]]) {
    const fileReal = await realpath(path);
    const rel = relative(workspaceReal, fileReal).replaceAll('\\', '/');
    if (!rel.startsWith(expectedPrefix) || rel.slice(expectedPrefix.length).includes('/')) errors.push(`${label}: must be a direct child of ${expectedPrefix}`);
  }
  for (const [label, path] of [['.agents', resolve(workspaceReal, '.agents')], ['.agents/reviews', resolve(workspaceReal, '.agents/reviews')]]) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) errors.push(`${label}: must be a real directory`);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) errors.push(`${label}: must use mode 0700`);
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) errors.push(`${label}: must be owned by the active OS user`);
  }
} catch (error) {
  errors.push(`review files: cannot verify private workspace location (${error.message})`);
}
requireText(report.reviewer, 'provider', 'reviewer');
requireText(report.reviewer, 'model', 'reviewer');
requireText(report.reviewer, 'family', 'reviewer');
requireText(packet.producer, 'provider', 'producer');
requireText(packet.producer, 'model', 'producer');
requireText(packet.producer, 'family', 'producer');
if (report.reviewer?.family === packet.producer?.family && report.verdict !== 'REVIEW_BLOCKED') errors.push('reviewer: family must differ from producer family');

const criterionIds = uniqueIds(packet.criteria, 'packet criterion');
const reportCriterionIds = uniqueIds(report.criteria, 'report criterion');
const findingIds = uniqueIds(report.findings, 'finding');
uniqueIds(report.deterministicChecks, 'check');
uniqueIds(report.verificationGaps, 'gap');

if (array(packet.blockers).some((blocker) => !isText(blocker))) errors.push('packet: blockers must be non-empty strings');
for (const criterion of array(packet.criteria)) {
  requireText(criterion, 'text', `packet criterion ${criterion.id}`);
  if (typeof criterion.required !== 'boolean') errors.push(`packet criterion ${criterion.id}: required must be boolean`);
  if (!['user', 'derived'].includes(criterion.source)) errors.push(`packet criterion ${criterion.id}: source must be user|derived`);
}
if (array(packet.artifacts).some((artifact) => !isText(artifact) || artifact.startsWith('..') || artifact === '.agents/reviews' || artifact.startsWith('.agents/reviews/'))) errors.push('packet: artifact paths must be non-empty workspace-relative non-review paths');

for (const id of criterionIds) if (!reportCriterionIds.has(id)) errors.push(`report: missing criterion ${id}`);
for (const criterion of array(report.criteria)) {
  if (!criterionIds.has(criterion.id)) errors.push(`criterion ${criterion.id}: not present in packet`);
  if (!['MET', 'NOT_MET', 'UNVERIFIED'].includes(criterion.status)) errors.push(`criterion ${criterion.id}: invalid status`);
  if (!Array.isArray(criterion.evidence) || array(criterion.evidence).length === 0 || array(criterion.evidence).some((item) => !isText(item))) errors.push(`criterion ${criterion.id}: evidence must be non-empty strings`);
  if (!Array.isArray(criterion.findingIds)) errors.push(`criterion ${criterion.id}: findingIds must be an array`);
  for (const findingId of array(criterion.findingIds)) if (!findingIds.has(findingId)) errors.push(`criterion ${criterion.id}: unknown finding ${findingId}`);
  if (criterion.status === 'NOT_MET' && array(criterion.findingIds).length === 0) errors.push(`criterion ${criterion.id}: NOT_MET needs a findingId`);
}
for (const check of array(report.deterministicChecks)) {
  requireText(check, 'command', `check ${check.id}`);
  requireText(check, 'evidence', `check ${check.id}`);
  if (!['PASS', 'FAIL', 'BLOCKED', 'NOT_APPLICABLE'].includes(check.status)) errors.push(`check ${check.id}: invalid status`);
  if (typeof check.required !== 'boolean') errors.push(`check ${check.id}: required must be boolean`);
}
for (const gap of array(report.verificationGaps)) {
  for (const field of ['changedBehavior', 'assertion', 'evidence']) requireText(gap, field, `gap ${gap.id}`);
  if (!['COVERED', 'GAP', 'NOT_APPLICABLE'].includes(gap.status)) errors.push(`gap ${gap.id}: invalid status`);
}
for (const finding of array(report.findings)) {
  for (const field of ['title', 'location', 'evidence', 'reproduction', 'expectedCorrection']) requireText(finding, field, `finding ${finding.id}`);
  if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(finding.severity)) errors.push(`finding ${finding.id}: invalid severity`);
  if (!Array.isArray(finding.criterionIds) || array(finding.criterionIds).length === 0) errors.push(`finding ${finding.id}: criterionIds required`);
  for (const id of array(finding.criterionIds)) if (!criterionIds.has(id)) errors.push(`finding ${finding.id}: unknown criterion ${id}`);
  for (const id of array(finding.criterionIds)) {
    const criterion = array(report.criteria).find((item) => item.id === id);
    if (!array(criterion?.findingIds).includes(finding.id)) errors.push(`finding ${finding.id}: criterion ${id} must reference the finding`);
    if (criterion?.status !== 'NOT_MET') errors.push(`finding ${finding.id}: criterion ${id} must be NOT_MET`);
  }
}

if (!['PASS', 'CHANGES_REQUIRED', 'REVIEW_BLOCKED'].includes(report.verdict)) errors.push('report: invalid verdict');
requireText(report, 'summary', 'report');
const blockers = [...array(packet.blockers), ...array(report.blockers)];
if (array(report.blockers).some((blocker) => !isText(blocker))) errors.push('report: blockers must be non-empty strings');
const requiredCriteria = array(packet.criteria).filter((criterion) => criterion.required).map((criterion) => report.criteria?.find((item) => item.id === criterion.id));
const requiredChecks = array(report.deterministicChecks).filter((check) => check.required);
const openGaps = array(report.verificationGaps).filter((gap) => gap.status === 'GAP');
if (report.verdict === 'PASS') {
  if (blockers.length) errors.push('verdict PASS: blockers remain');
  if (requiredCriteria.some((criterion) => criterion?.status !== 'MET')) errors.push('verdict PASS: required criterion is not MET');
  if (requiredChecks.some((check) => check.status !== 'PASS' && check.status !== 'NOT_APPLICABLE')) errors.push('verdict PASS: required check failed or blocked');
  if (array(report.deterministicChecks).some((check) => check.status === 'FAIL')) errors.push('verdict PASS: a deterministic check failed');
  if (array(report.findings).length) errors.push('verdict PASS: actionable findings remain');
  if (openGaps.length) errors.push('verdict PASS: verification gaps remain');
  if (array(report.deterministicChecks).length === 0) errors.push('verdict PASS: record at least one check or explicit NOT_APPLICABLE check');
  if (array(report.verificationGaps).length === 0) errors.push('verdict PASS: record at least one coverage trace or explicit NOT_APPLICABLE trace');
}
if (report.verdict === 'CHANGES_REQUIRED') {
  const defectEvidence = array(report.findings).length || requiredCriteria.some((criterion) => criterion?.status === 'NOT_MET') || requiredChecks.some((check) => check.status === 'FAIL') || openGaps.length;
  if (!defectEvidence) errors.push('verdict CHANGES_REQUIRED: no actionable defect evidence');
}
if (report.verdict === 'REVIEW_BLOCKED') {
  const blockedEvidence = blockers.length || requiredCriteria.some((criterion) => criterion?.status === 'UNVERIFIED') || requiredChecks.some((check) => check.status === 'BLOCKED');
  if (!blockedEvidence) errors.push('verdict REVIEW_BLOCKED: no blocker or unverified required evidence');
}

try {
  if (packet.workspace?.cwd && packet.workspace?.fingerprint) {
    const current = await currentWorkspaceFingerprint(packet.workspace.cwd);
    if (current !== packet.workspace.fingerprint) errors.push('packet: workspace fingerprint is stale');
  }
} catch (error) {
  errors.push(`packet: cannot verify workspace freshness (${error.message})`);
}

for (const label of ['request', 'criteria', 'delivery', 'verification']) {
  const input = packet.inputs?.[label];
  if (!input?.path || !input?.sha256 || !isText(input.content)) {
    if (report.verdict !== 'REVIEW_BLOCKED') errors.push(`packet: ${label} input is incomplete`);
    continue;
  }
  if (sha256(input.content) !== input.sha256) errors.push(`packet: embedded ${label} input hash mismatch`);
  try {
    const workspaceReal = await realpath(packet.workspace.cwd);
    const inputReal = await realpath(input.path);
    if (inputReal !== workspaceReal && relative(workspaceReal, inputReal).startsWith('..')) errors.push(`packet: ${label} input resolves outside workspace`);
    else if (sha256(await readFile(inputReal)) !== input.sha256) errors.push(`packet: ${label} input hash is stale`);
  } catch (error) {
    errors.push(`packet: cannot rehash ${label} input (${error.message})`);
  }
}
try {
  if (JSON.stringify(JSON.parse(packet.inputs?.criteria?.content ?? 'null')) !== JSON.stringify(packet.criteria)) errors.push('packet: parsed criteria do not match captured criteria input');
} catch (error) {
  errors.push(`packet: cannot parse captured criteria (${error.message})`);
}

if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}
const independence = report.verdict === 'REVIEW_BLOCKED' ? 'records a blocked independence/evidence gate' : 'is cross-family';
process.stdout.write(`PASS: ${report.verdict} report is structurally consistent, traceable, current, and ${independence}. Substantive correctness still requires human/model judgment.\n`);
