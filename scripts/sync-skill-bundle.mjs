#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, access, rename, unlink, lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

const BUNDLES = {
  bmad: {
    sourceUrl: 'https://github.com/bmad-code-org/BMAD-METHOD',
    revision: '717479bc3f50f38119fd958b9e577a8bde2e0184',
    license: { spdx: 'MIT', files: ['LICENSE'], noticeFiles: [], trademarkFiles: ['TRADEMARK.md'] },
    skillRoots: ['src/core-skills', 'src/bmm-skills', 'web-bundles'],
    excludePathPrefixes: ['test/', '.github/', 'tools/', 'docs/', 'node_modules/', '.git/'],
  },
  nvidia: {
    sourceUrl: 'https://github.com/NVIDIA/skills',
    revision: '8543c134fe6d7fe8e05ea967a0403afe0e191795',
    license: { spdx: 'Apache-2.0', files: ['LICENSE'], noticeFiles: [], trademarkFiles: [] },
    skillRoots: ['skills', 'plugins/nvidia-skills/skills'],
    excludePathPrefixes: ['.github/', 'node_modules/', '.git/'],
  },
};

const FILE_EXCLUDE_PREFIXES = ['evals', '__pycache__'];
const FILE_EXCLUDE_NAMES = new Set(['.env.example', '.env']);
const LOCK_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const MAX_ACTIVE_LOCK_CLAIMS = 4_096;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkComponents(boundaryRoot, targetPath, allowMissingTail = false) {
  const boundary = resolve(boundaryRoot);
  const target = resolve(targetPath);
  const rel = relative(boundary, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes sync root: ${targetPath}`);
  const boundaryMetadata = await lstat(boundary);
  if (boundaryMetadata.isSymbolicLink() || !boundaryMetadata.isDirectory()) throw new Error('Sync root must be a real directory.');
  let current = boundary;
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error(`Symlink component rejected: ${segment}`);
    } catch (error) {
      if (allowMissingTail && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function parseSyncLock(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || !Number.isInteger(parsed.pid)
      || typeof parsed.host !== 'string'
      || !LOCK_TOKEN_PATTERN.test(parsed.token ?? '')
      || typeof parsed.acquiredAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.acquiredAt))
      || typeof parsed.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.expiresAt))
      || (parsed.ticket !== undefined && (!Number.isSafeInteger(parsed.ticket) || parsed.ticket < 0))
    ) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function syncLockIsReclaimable(lock) {
  if (lock.host !== hostname()) return false;
  if (Date.now() < Date.parse(lock.expiresAt)) return false;
  return isProcessAlive(lock.pid) === 'dead';
}

async function assertPrivateDirectory(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} must be a real directory.`);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user.`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must not be group/world accessible.`);
}

async function legacySyncLockBlocks(lockPath) {
  try {
    const existing = parseSyncLock(await readFile(lockPath, 'utf8'));
    if (!existing) throw new Error('Legacy sync lock is malformed.');
    if (!syncLockIsReclaimable(existing)) return true;
    await unlink(lockPath);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function inspectActiveSyncClaims(claimsRoot) {
  const entries = await readdir(claimsRoot, { withFileTypes: true });
  const claimEntries = entries.filter((entry) => entry.name !== 'queue');
  if (claimEntries.length > MAX_ACTIVE_LOCK_CLAIMS) throw new Error(`Sync lock claims exceed ${MAX_ACTIVE_LOCK_CLAIMS} active entries.`);
  const active = [];
  let choosing = false;
  let maxTicket = 0;
  for (const entry of claimEntries) {
    const suffix = entry.name.endsWith('.json') ? '.json' : entry.name.endsWith('.choosing') ? '.choosing' : '';
    const token = suffix ? entry.name.slice(0, -suffix.length) : '';
    if (!entry.isFile() || !LOCK_TOKEN_PATTERN.test(token)) throw new Error(`Sync lock claims root contains an invalid entry: ${entry.name}`);
    const claimPath = join(claimsRoot, entry.name);
    let claim;
    try {
      claim = parseSyncLock(await readFile(claimPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!claim || claim.token !== token) throw new Error(`Sync lock claim ${token} is malformed.`);
    if (syncLockIsReclaimable(claim)) {
      await unlink(claimPath).catch(() => undefined);
      continue;
    }
    if (suffix === '.choosing') {
      choosing = true;
      continue;
    }
    if (!Number.isSafeInteger(claim.ticket) || claim.ticket <= 0) throw new Error(`Sync lock claim ${token} has no valid ticket.`);
    maxTicket = Math.max(maxTicket, claim.ticket);
    active.push(claim);
  }
  active.sort((left, right) => left.ticket - right.ticket || left.token.localeCompare(right.token));
  return { owner: active[0]?.token, maxTicket, choosing };
}

export async function acquireSyncLock(bundleId, root = repoRoot, deadlineMs = 5_000) {
  const lockRoot = join(root, 'catalog', '.sync');
  await assertNoSymlinkComponents(root, lockRoot, true);
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(root, lockRoot);
  await assertPrivateDirectory(lockRoot, 'Sync lock root');
  const lockPath = join(lockRoot, `${bundleId}.lock`);
  const claimsRoot = `${lockPath}.claims`;
  await mkdir(claimsRoot, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(claimsRoot, 'Sync lock claims root');
  const lock = {
    pid: process.pid,
    host: hostname(),
    token: randomBytes(16).toString('hex'),
    bundleId,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  const choosingPath = join(claimsRoot, `${lock.token}.choosing`);
  const claimPath = join(claimsRoot, `${lock.token}.json`);
  await writeFile(choosingPath, `${JSON.stringify({ ...lock, ticket: 0 })}\n`, { flag: 'wx', mode: 0o600 });
  try {
    const snapshot = await inspectActiveSyncClaims(claimsRoot);
    const ticket = snapshot.maxTicket + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error('Sync lock claim ticket space is exhausted.');
    await writeFile(claimPath, `${JSON.stringify({ ...lock, ticket })}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await unlink(choosingPath).catch(() => undefined);
    throw error;
  }
  await unlink(choosingPath);
  const deadline = Date.now() + deadlineMs;
  try {
    while (Date.now() < deadline) {
      if (!(await legacySyncLockBlocks(lockPath))) {
        const snapshot = await inspectActiveSyncClaims(claimsRoot);
        if (!snapshot.choosing && snapshot.owner === lock.token) return { claimPath, token: lock.token };
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`Timed out waiting for sync lock: ${bundleId}`);
  } catch (error) {
    await unlink(choosingPath).catch(() => undefined);
    await unlink(claimPath).catch(() => undefined);
    throw error;
  }
}

export async function releaseSyncLock(lock) {
  await unlink(lock.claimPath).catch(() => undefined);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function walkFiles(root, prefix = '', excludePrefixes = []) {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (excludePrefixes.some((item) => rel === item || rel.startsWith(`${item}/`))) continue;
    if (FILE_EXCLUDE_NAMES.has(entry.name)) continue;
    const abs = join(root, rel);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in synchronized bundles: ${rel}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, rel, excludePrefixes));
    else if (entry.isFile()) {
      if (entry.name.endsWith('.pyc')) continue;
      files.push({ rel, abs });
    } else throw new Error(`Unsupported entry in synchronized bundle: ${rel}`);
  }
  return files;
}

function shouldExclude(rel, prefixes) {
  return prefixes.some((prefix) => rel.startsWith(prefix));
}

async function discoverSkillDirs(root, upstreamRoot, excluded, prefixes) {
  const discovered = [];
  async function walk(current, rel) {
    const skillMd = join(current, 'SKILL.md');
    try {
      await readFile(skillMd, 'utf8');
      discovered.push({ upstreamPath: rel, skillRoot: current, skillName: basename(current) });
      return;
    } catch {
      // continue into children
    }
    let entries = [];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    const subdirs = entries.filter((entry) => entry.isDirectory());
    if (subdirs.length === 0 && rel) excluded.push({ path: rel, reasonCode: 'MISSING_SKILL_MD' });
    for (const entry of subdirs) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (shouldExclude(nextRel, prefixes)) {
        excluded.push({ path: nextRel, reasonCode: 'EXCLUDED_PREFIX' });
        continue;
      }
      await walk(join(current, entry.name), nextRel);
    }
  }
  await walk(root, relative(upstreamRoot, root));
  return discovered;
}

export async function downloadArchive(sourceUrl, revision, destination) {
  const url = `${sourceUrl.replace(/\/$/, '')}/archive/${revision}.zip`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Archive fetch failed (${response.status}) for ${url}`);
  const resolved = new URL(response.url || url);
  if (resolved.protocol !== 'https:' || !['github.com', 'codeload.github.com'].includes(resolved.hostname)) {
    throw new Error(`Archive redirect host is not allowed: ${resolved.hostname}`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Archive exceeds ${MAX_ARCHIVE_BYTES} downloaded bytes.`);
  }
  if (!response.body) throw new Error('Archive response has no body.');
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_ARCHIVE_BYTES) callback(new Error(`Archive exceeds ${MAX_ARCHIVE_BYTES} downloaded bytes.`));
      else callback(null, chunk);
    },
  });
  await pipeline(response.body, limiter, createWriteStream(destination, { mode: 0o600 }));
}

function archivePathIntersects(relativePath, reachablePaths) {
  if (!relativePath) return true;
  return reachablePaths.some((candidate) => {
    const normalized = candidate.split('/').filter(Boolean).join('/');
    return relativePath === normalized
      || relativePath.startsWith(`${normalized}/`)
      || normalized.startsWith(`${relativePath}/`);
  });
}

export function inspectZipArchive(zipPath, revision, reachablePaths = []) {
  const namesOutput = execFileSync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const names = namesOutput.split('\n').filter(Boolean);
  if (names.length === 0 || names.length > MAX_ARCHIVE_ENTRIES) throw new Error(`Archive entry count is outside 1..${MAX_ARCHIVE_ENTRIES}.`);
  const seen = new Set();
  const seenFolded = new Set();
  const topLevels = new Set();
  for (const name of names) {
    if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      throw new Error(`Unsafe archive path: ${name}`);
    }
    const segments = name.split('/').filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) throw new Error(`Unsafe archive path: ${name}`);
    const normalized = segments.join('/');
    const folded = normalized.toLocaleLowerCase('en-US');
    if (seen.has(normalized) || seenFolded.has(folded)) throw new Error(`Duplicate archive path: ${name}`);
    seen.add(normalized);
    seenFolded.add(folded);
    topLevels.add(segments[0]);
  }
  if (topLevels.size !== 1 || ![...topLevels][0].includes(revision.slice(0, 12))) {
    throw new Error('Archive must contain exactly one revision-bound top-level directory.');
  }

  const listing = execFileSync('unzip', ['-Z', '-l', zipPath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const attributeLines = listing.split('\n').filter((line) => /^[bcdlps-][rwxStTs-]{6,9}\s/.test(line));
  if (attributeLines.length !== names.length) throw new Error('Archive attribute listing does not match its path listing.');
  const topLevel = [...topLevels][0];
  const excludedEntries = [];
  for (const [index, line] of attributeLines.entries()) {
    if (['-', 'd'].includes(line[0])) continue;
    const name = names[index];
    const segments = name.split('/').filter(Boolean);
    const relativePath = segments.slice(1).join('/');
    if (archivePathIntersects(relativePath, reachablePaths)) {
      throw new Error(`Archive symlink or special-file entry intersects imported content: ${name}`);
    }
    excludedEntries.push(name);
  }
  const totals = listing.match(/(\d+) files?, ([\d,]+) bytes uncompressed/);
  if (!totals || Number(totals[1]) !== names.length) throw new Error('Archive totals are missing or inconsistent.');
  const uncompressedBytes = Number(totals[2].replaceAll(',', ''));
  if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
    throw new Error(`Archive exceeds ${MAX_ARCHIVE_UNCOMPRESSED_BYTES} uncompressed bytes.`);
  }
  return { entryCount: names.length, uncompressedBytes, topLevel, excludedEntries };
}

export async function extractZip(zipPath, destination, revision, reachablePaths = []) {
  const inspection = inspectZipArchive(zipPath, revision, reachablePaths);
  const args = ['-q', zipPath, '-d', destination];
  if (inspection.excludedEntries.length > 0) args.push('-x', ...inspection.excludedEntries);
  execFileSync('unzip', args, { stdio: 'inherit' });
}

async function findExtractedRoot(extractDir, revision) {
  const entries = await readdir(extractDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  if (directories.length !== 1 || !directories[0].name.includes(revision.slice(0, 12))) {
    throw new Error('Extracted archive root does not match the pinned revision.');
  }
  return join(extractDir, directories[0].name);
}

export function sanitizeImportedContent(content) {
  return content
    .replace(/(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET)\s*=\s*["']?(?!<|your-|example|replace|\$)[xX]{16,}["']?/gi, 'API_KEY=<redacted-placeholder>')
    .replace(/(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET)\s*=\s*["']?(?!<|your-|example|replace|\$)[A-Za-z0-9_./+=-]{18,}["']?/gi, (match) => match.includes('your-') || match.includes('example') ? match : 'API_KEY=<redacted-placeholder>');
}

async function copySkillTree(sourceSkillRoot, targetSkillRoot) {
  await mkdir(dirname(targetSkillRoot), { recursive: true });
  execFileSync('rsync', ['-a', '--exclude', 'evals', '--exclude', '__pycache__', '--exclude', '*.pyc', '--exclude', '.env.example', '--exclude', '.env', `${sourceSkillRoot}/`, `${targetSkillRoot}/`], { stdio: 'inherit' });
  const files = await walkFiles(targetSkillRoot, '', FILE_EXCLUDE_PREFIXES);
  for (const file of files) {
    const bytes = await readFile(file.abs);
    const text = bytes.toString('utf8');
    const sanitized = sanitizeImportedContent(text);
    if (sanitized !== text) await writeFile(file.abs, sanitized, 'utf8');
  }
}

export async function promoteBundleSnapshot({
  bundleId,
  targetRoot,
  bundleDir,
  lockPath,
  lockBody,
  transactionParent,
  boundaryRoot = repoRoot,
  hooks = {},
}) {
  await assertNoSymlinkComponents(boundaryRoot, transactionParent, true);
  await assertNoSymlinkComponents(boundaryRoot, bundleDir, true);
  await assertNoSymlinkComponents(boundaryRoot, lockPath, true);
  await mkdir(transactionParent, { recursive: true, mode: 0o700 });
  await mkdir(dirname(bundleDir), { recursive: true });
  await mkdir(dirname(lockPath), { recursive: true });
  await assertNoSymlinkComponents(boundaryRoot, transactionParent);
  await assertNoSymlinkComponents(boundaryRoot, bundleDir, true);
  await assertNoSymlinkComponents(boundaryRoot, lockPath, true);
  await assertPrivateDirectory(transactionParent, 'Sync transaction root');
  const transactionRoot = await mkdtemp(join(transactionParent, `${bundleId}-`));
  const promoteDir = join(transactionRoot, 'promote');
  const backupDir = join(transactionRoot, 'backup');
  const failedNewDir = join(transactionRoot, 'failed-new');
  await mkdir(promoteDir, { mode: 0o700 });
  execFileSync('cp', ['-R', `${targetRoot}/.`, promoteDir], { stdio: 'inherit' });

  const priorLockBody = await pathExists(lockPath) ? await readFile(lockPath, 'utf8') : null;
  const lockTemp = `${lockPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  await writeFile(lockTemp, lockBody, { mode: 0o600 });
  let backupTaken = false;
  let promoted = false;
  let lockCommitted = false;

  try {
    if (await pathExists(bundleDir)) {
      // backupDir intentionally does not exist; this is portable across platforms
      // whose rename cannot replace an existing empty directory.
      await rename(bundleDir, backupDir);
      backupTaken = true;
    }
    await rename(promoteDir, bundleDir);
    promoted = true;
    await rename(lockTemp, lockPath);
    lockCommitted = true;
    await hooks.afterLockCommit?.();
    if (backupTaken) await rm(backupDir, { recursive: true, force: true });
    await rm(transactionRoot, { recursive: true, force: true });
  } catch (error) {
    const rollbackErrors = [];
    let bundleRestored = true;

    if (promoted) {
      try {
        await rename(bundleDir, failedNewDir);
      } catch (rollbackError) {
        bundleRestored = false;
        rollbackErrors.push(`preserve new bundle: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (bundleRestored && backupTaken) {
      try {
        await rename(backupDir, bundleDir);
      } catch (rollbackError) {
        bundleRestored = false;
        rollbackErrors.push(`restore prior bundle: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        if (promoted && await pathExists(failedNewDir) && !(await pathExists(bundleDir))) {
          await rename(failedNewDir, bundleDir).catch((restoreNewError) => {
            rollbackErrors.push(`restore new bundle: ${restoreNewError instanceof Error ? restoreNewError.message : String(restoreNewError)}`);
          });
        }
      }
    }

    if (bundleRestored && lockCommitted) {
      try {
        if (priorLockBody === null) {
          await unlink(lockPath);
        } else {
          const restoreTemp = join(transactionRoot, 'prior-lock.restore');
          await writeFile(restoreTemp, priorLockBody, { mode: 0o600 });
          await rename(restoreTemp, lockPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`restore prior lock: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }

    await rm(lockTemp, { force: true }).catch(() => undefined);
    if (rollbackErrors.length === 0) {
      await rm(transactionRoot, { recursive: true, force: true });
      throw error;
    }
    throw new Error(`Bundle rollback incomplete; recovery preserved at ${transactionRoot}: ${rollbackErrors.join('; ')}`, { cause: error });
  }
}

function writeZeuzManifest(targetSkillRoot, bundleId) {
  const yaml = [
    `namespace: import/${bundleId}`,
    'version: "0.0.0"',
    'trust: quarantined',
    'enablement: disabled',
    'networkPolicy: explicit-sync-only',
    'contextBudgetBytes: 32768',
    'triggers: []',
    'dependencies: []',
    '',
  ].join('\n');
  return writeFile(join(targetSkillRoot, 'zeuz.manifest.yaml'), yaml);
}

async function buildBundle(bundleId, mode = 'apply') {
  const spec = BUNDLES[bundleId];
  if (!spec) throw new Error(`Unknown bundle: ${bundleId}`);
  const staging = await mkdtemp(join(tmpdir(), `zeuz-skill-sync-${bundleId}-`));
  try {
  const zipPath = join(staging, 'archive.zip');
  const extractDir = join(staging, 'extract');
  await mkdir(extractDir, { recursive: true });
  await downloadArchive(spec.sourceUrl, spec.revision, zipPath);
  const reachableArchivePaths = [
    ...spec.skillRoots,
    ...spec.license.files,
    ...spec.license.noticeFiles,
    ...spec.license.trademarkFiles,
  ];
  await extractZip(zipPath, extractDir, spec.revision, reachableArchivePaths);
  const upstreamRoot = await findExtractedRoot(extractDir, spec.revision);

  const discovered = [];
  const excluded = [];
  for (const rootRel of spec.skillRoots) {
    const root = join(upstreamRoot, rootRel);
    discovered.push(...await discoverSkillDirs(root, upstreamRoot, excluded, spec.excludePathPrefixes));
  }

  const upstreamDiscoveredTotal = discovered.length;
  const seen = new Map();
  const finalSkills = [];
  for (const skill of discovered.sort((a, b) => a.skillName.localeCompare(b.skillName))) {
    const prior = seen.get(skill.skillName);
    if (prior) {
      excluded.push({
        path: skill.upstreamPath,
        reasonCode: 'DUPLICATE_SKILL_NAME',
        detail: `collides with ${prior.upstreamPath}`,
      });
      continue;
    }
    seen.set(skill.skillName, skill);
    finalSkills.push(skill);
  }

  const targetRoot = join(staging, 'bundle');
  await mkdir(targetRoot, { recursive: true });

  const bundleFiles = [];
  const skills = [];
  for (const skill of finalSkills) {
    const targetSkillRoot = join(targetRoot, skill.skillName);
    await copySkillTree(skill.skillRoot, targetSkillRoot);
    await writeZeuzManifest(targetSkillRoot, bundleId);
    const files = await walkFiles(targetSkillRoot, '', FILE_EXCLUDE_PREFIXES);
    const perSkillFiles = [];
    for (const file of files) {
      const bytes = await readFile(file.abs);
      const path = `${skill.skillName}/${file.rel}`.replace(/\/+/g, '/');
      const record = {
        path,
        size: bytes.length,
        sha256: sha256Hex(bytes),
        upstreamPath: `${skill.upstreamPath}/${file.rel}`,
      };
      bundleFiles.push(record);
      perSkillFiles.push(record);
    }
    skills.push({
      id: `import/${bundleId}/${skill.skillName}@0.0.0`,
      rootPath: skill.skillName,
      inventoryDigest: sha256Hex(perSkillFiles.map((file) => `${file.path}\t${file.size}\t${file.sha256}`).join('\n')),
    });
  }

  for (const licenseFile of spec.license.files) {
    const source = join(upstreamRoot, licenseFile);
    const bytes = await readFile(source);
    const rel = basename(licenseFile);
    await writeFile(join(targetRoot, rel), bytes);
    bundleFiles.push({ path: rel, size: bytes.length, sha256: sha256Hex(bytes), upstreamPath: licenseFile });
  }
  for (const noticeFile of spec.license.noticeFiles) {
    const source = join(upstreamRoot, noticeFile);
    const bytes = await readFile(source);
    await writeFile(join(targetRoot, basename(noticeFile)), bytes);
    bundleFiles.push({ path: basename(noticeFile), size: bytes.length, sha256: sha256Hex(bytes), upstreamPath: noticeFile });
  }
  for (const trademarkFile of spec.license.trademarkFiles) {
    const source = join(upstreamRoot, trademarkFile);
    const bytes = await readFile(source);
    await writeFile(join(targetRoot, basename(trademarkFile)), bytes);
    bundleFiles.push({ path: basename(trademarkFile), size: bytes.length, sha256: sha256Hex(bytes), upstreamPath: trademarkFile });
  }

  bundleFiles.sort((a, b) => a.path.localeCompare(b.path));
  const inventoryDigest = sha256Hex(bundleFiles.map((file) => `${file.path}\t${file.size}\t${file.sha256}`).join('\n'));
  const lock = {
    schemaVersion: 1,
    bundleId,
    sourceUrl: spec.sourceUrl,
    revision: spec.revision,
    resolvedAt: new Date().toISOString(),
    license: spec.license,
    inventoryDigest,
    upstreamDiscoveredTotal,
    upstreamSkillTotal: upstreamDiscoveredTotal,
    importedSkillTotal: finalSkills.length,
    excluded,
    files: bundleFiles,
    skills,
  };

  const diff = {
    bundleId,
    previousRevision: null,
    nextRevision: spec.revision,
    inventoryDigest,
    importedSkillTotal: finalSkills.length,
    excluded,
  };

  const bundleDir = join(repoRoot, 'catalog', 'bundles', bundleId);
  const lockPath = join(repoRoot, 'catalog', 'locks', `${bundleId}.lock.json`);
  const lockBody = `${JSON.stringify(lock, null, 2)}\n`;

  if (mode === 'check') {
    process.stdout.write(`${JSON.stringify({ mode, diff, lockSummary: { bundleId, revision: spec.revision, upstreamDiscoveredTotal, importedSkillTotal: finalSkills.length, excluded: excluded.length, inventoryDigest } }, null, 2)}\n`);
    return;
  }

  const syncLock = await acquireSyncLock(bundleId);
  try {
    await promoteBundleSnapshot({
      bundleId,
      targetRoot,
      bundleDir,
      lockPath,
      lockBody,
      transactionParent: join(repoRoot, 'catalog', '.promote'),
    });
    process.stdout.write(`${JSON.stringify({ mode, diff, bundleDir, lockPath: join('catalog', 'locks', `${bundleId}.lock.json`) }, null, 2)}\n`);
  } finally {
    await releaseSyncLock(syncLock);
  }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [bundleId, mode = 'apply'] = process.argv.slice(2);
  if (!bundleId || !['bmad', 'nvidia'].includes(bundleId)) {
    console.error('Usage: node scripts/sync-skill-bundle.mjs <bmad|nvidia> [check|apply]');
    process.exit(1);
  }
  buildBundle(bundleId, mode === 'check' ? 'check' : 'apply').catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
