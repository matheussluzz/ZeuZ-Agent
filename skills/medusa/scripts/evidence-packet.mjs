#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readlink, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';

const REVIEW_DIRECTORY = '.agents/reviews';
const REVIEW_EXCLUDE = `:(exclude)${REVIEW_DIRECTORY}/**`;
const SENSITIVE_PATH = /(^|\/)(\.env(?:\..*)?|lamine(?:\.[^/]*)?\.ya?ml|\.npmrc|auth\.json|[^/]*(?:credentials?|secrets?)[^/]*\.json|[^/]+\.(?:pem|key|p12|pfx|jks))$/i;

const usage = `Usage: node evidence-packet.mjs --workspace <git-dir> --request <file> --criteria <json> --delivery <file> --verification <file> --artifact <path> [--artifact <path> ...] --producer-family <name> --out .agents/reviews/<file>.json\n`;

function parseArgs(argv) {
  const options = { artifacts: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help') return { help: true };
    const value = argv[++i];
    if (!token?.startsWith('--') || value === undefined) throw new Error(`Invalid argument: ${token ?? ''}`);
    if (token === '--artifact') options.artifacts.push(value);
    else options[token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
  }
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const portableRelative = (from, to) => relative(from, to).split(sep).join('/');
const isSensitivePath = (path) => SENSITIVE_PATH.test(path.split(sep).join('/'));

function git(cwd, args, { required = false } = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 100_000_000 });
  if (result.status !== 0) {
    if (required) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    return undefined;
  }
  return result.stdout.replace(/\r\n/g, '\n').trimEnd();
}

async function hashUntracked(cwd) {
  const output = git(cwd, ['ls-files', '--others', '--exclude-standard', '--', '.', REVIEW_EXCLUDE], { required: true }) ?? '';
  const entries = [];
  for (const name of output.split('\n').filter(Boolean).sort()) {
    const path = resolve(cwd, name);
    const stat = await lstat(path);
    if (isSensitivePath(name)) {
      entries.push({ path: name, type: 'denied-sensitive', size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode });
    } else if (stat.isSymbolicLink()) {
      entries.push({ path: name, type: 'symlink', sha256: sha256(await readlink(path)) });
    } else if (stat.isFile()) {
      entries.push({ path: name, type: 'file', sha256: sha256(await readFile(path)) });
    }
  }
  return entries;
}

async function workspaceState(cwd) {
  const trackedSensitive = (git(cwd, ['ls-files'], { required: true }) ?? '').split('\n').filter(Boolean).filter(isSensitivePath);
  if (trackedSensitive.length) throw new Error(`Refusing to packetize tracked sensitive paths: ${trackedSensitive.join(', ')}`);
  const head = git(cwd, ['rev-parse', 'HEAD'], { required: true });
  const branch = git(cwd, ['branch', '--show-current']) ?? '';
  const status = git(cwd, ['status', '--short', '--untracked-files=all', '--', '.', REVIEW_EXCLUDE], { required: true }) ?? '';
  const diff = git(cwd, ['diff', '--binary', 'HEAD', '--', '.', REVIEW_EXCLUDE], { required: true }) ?? '';
  const untracked = await hashUntracked(cwd);
  const fingerprint = sha256(JSON.stringify({ head, status, diffSha256: sha256(diff), untracked }));
  return {
    cwd,
    head,
    branch,
    fingerprint,
    status: status.split('\n').filter(Boolean),
    diffSha256: sha256(diff),
    untracked,
  };
}

async function capturedInput(cwd, path, label, blockers) {
  if (!path) {
    blockers.push(`Missing ${label} input.`);
    return null;
  }
  const absolute = resolve(cwd, path);
  if (isSensitivePath(absolute)) {
    blockers.push(`${label} input uses a denied credential/secret filename.`);
    return { path: absolute, error: 'denied sensitive filename' };
  }
  if (portableRelative(cwd, absolute).startsWith('..')) {
    blockers.push(`${label} input is outside the workspace.`);
    return { path: absolute, error: 'outside workspace' };
  }
  try {
    const workspaceReal = await realpath(cwd);
    const inputReal = await realpath(absolute);
    if (inputReal !== workspaceReal && portableRelative(workspaceReal, inputReal).startsWith('..')) {
      blockers.push(`${label} input resolves outside the workspace.`);
      return { path: absolute, error: 'resolves outside workspace' };
    }
    const content = await readFile(inputReal, 'utf8');
    const secretShape = /(?:nvapi-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
    if (secretShape.test(content)) {
      blockers.push(`${label} input contains a secret-shaped value; sanitize it before review.`);
      return { path: absolute, error: 'secret-shaped value detected' };
    }
    if (!content.trim()) blockers.push(`${label} input is empty.`);
    return { path: absolute, sha256: sha256(content), content };
  } catch (error) {
    blockers.push(`Cannot read ${label}: ${error.message}`);
    return { path: absolute, error: error.message };
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    process.exit(0);
  }
  const cwd = resolve(options.workspace ?? process.cwd());
  if (!options.out) throw new Error('--out is required so sensitive packet content is never printed to stdout.');
  const blockers = [];
  const request = await capturedInput(cwd, options.request, 'request', blockers);
  const delivery = await capturedInput(cwd, options.delivery, 'delivery', blockers);
  const verification = await capturedInput(cwd, options.verification, 'verification', blockers);
  const criteriaInput = await capturedInput(cwd, options.criteria, 'criteria', blockers);
  let criteria = [];
  if (criteriaInput?.content) {
    try {
      criteria = JSON.parse(criteriaInput.content);
      if (!Array.isArray(criteria) || criteria.length === 0) throw new Error('must be a non-empty array');
      const ids = new Set();
      for (const [index, criterion] of criteria.entries()) {
        if (!criterion || typeof criterion !== 'object') throw new Error(`entry ${index + 1} must be an object`);
        if (typeof criterion.id !== 'string' || !criterion.id.trim()) throw new Error(`entry ${index + 1} needs id`);
        if (ids.has(criterion.id)) throw new Error(`duplicate id ${criterion.id}`);
        ids.add(criterion.id);
        if (typeof criterion.text !== 'string' || !criterion.text.trim()) throw new Error(`${criterion.id} needs text`);
        if (typeof criterion.required !== 'boolean') throw new Error(`${criterion.id} needs boolean required`);
        if (!['user', 'derived'].includes(criterion.source)) throw new Error(`${criterion.id} needs source user|derived`);
      }
    } catch (error) {
      blockers.push(`Invalid criteria: ${error.message}`);
      criteria = [];
    }
  }
  if (!options.producerFamily) blockers.push('Missing producer family; independent review cannot be established.');

  const artifacts = [];
  const workspaceReal = await realpath(cwd);
  for (const item of options.artifacts) {
    const absolute = resolve(cwd, item);
    const rel = portableRelative(cwd, absolute);
    if (rel.startsWith('..')) blockers.push(`Artifact is outside workspace: ${item}`);
    else if (rel === REVIEW_DIRECTORY || rel.startsWith(`${REVIEW_DIRECTORY}/`)) blockers.push(`Artifact cannot use reserved review metadata path: ${item}`);
    else {
      try {
        const resolvedArtifact = await realpath(absolute);
        if (resolvedArtifact !== workspaceReal && portableRelative(workspaceReal, resolvedArtifact).startsWith('..')) blockers.push(`Artifact resolves outside workspace: ${item}`);
        else artifacts.push(rel || '.');
      } catch (error) {
        blockers.push(`Artifact is not inspectable (${item}): ${error.message}`);
      }
    }
  }
  if (artifacts.length === 0) blockers.push('No artifact path supplied.');

  const workspace = await workspaceState(cwd);
  const packet = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    producer: { family: options.producerFamily ?? null },
    workspace,
    packetFingerprint: sha256(JSON.stringify({
      workspaceFingerprint: workspace.fingerprint,
      request: request?.sha256,
      criteria: criteriaInput?.sha256,
      delivery: delivery?.sha256,
      verification: verification?.sha256,
      artifacts,
      producerFamily: options.producerFamily ?? null,
      criteriaSha256: sha256(JSON.stringify(criteria)),
      blockers,
      workspaceCwd: workspace.cwd,
      inputPaths: { request: request?.path, criteria: criteriaInput?.path, delivery: delivery?.path, verification: verification?.path },
    })),
    inputs: { request, criteria: criteriaInput, delivery, verification },
    criteria,
    artifacts,
    blockers,
    warning: `This local packet includes supplied request/delivery text. Keep ${REVIEW_DIRECTORY}/ private and ignored by Git.`,
  };
  const output = `${JSON.stringify(packet, null, 2)}\n`;
  if (options.out) {
    const out = resolve(cwd, options.out);
    const outRelative = portableRelative(cwd, out);
    if (!(outRelative.startsWith(`${REVIEW_DIRECTORY}/`) && dirname(outRelative) === REVIEW_DIRECTORY)) throw new Error(`Output must be a direct child of ${REVIEW_DIRECTORY}/ in the reviewed workspace.`);
    const localState = resolve(cwd, '.agents');
    try {
      const state = await lstat(localState);
      if (state.isSymbolicLink() || !state.isDirectory()) throw new Error('.agents must be a real directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(localState, { mode: 0o700 });
    }
    await chmod(localState, 0o700);
    const reviewRoot = resolve(cwd, REVIEW_DIRECTORY);
    try {
      const state = await lstat(reviewRoot);
      if (state.isSymbolicLink() || !state.isDirectory()) throw new Error(`${REVIEW_DIRECTORY} must be a real directory`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(reviewRoot, { mode: 0o700 });
    }
    await chmod(reviewRoot, 0o700);
    const realReviewRoot = await realpath(reviewRoot);
    const realOutputParent = await realpath(dirname(out));
    if (realOutputParent !== realReviewRoot && portableRelative(realReviewRoot, realOutputParent).startsWith('..')) throw new Error('Output parent resolves outside reserved review directory.');
    try {
      if ((await lstat(out)).isSymbolicLink()) throw new Error('Output file must not be a symlink.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const handle = await open(out, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(output, 'utf8');
    } finally {
      await handle.close();
    }
    process.stdout.write(`WROTE ${out} (${packet.packetFingerprint})\n`);
  }
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n${usage}`);
  process.exit(1);
}
