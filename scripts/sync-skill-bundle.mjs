#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
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

const FILE_EXCLUDE_PREFIXES = ['evals'];
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function walkFiles(root, prefix = '', excludePrefixes = []) {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (excludePrefixes.some((item) => rel === item || rel.startsWith(`${item}/`))) continue;
    const abs = join(root, rel);
    if (entry.isDirectory()) files.push(...await walkFiles(root, rel, excludePrefixes));
    else if (entry.isFile()) files.push({ rel, abs });
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

async function downloadArchive(sourceUrl, revision, destination) {
  const url = `${sourceUrl.replace(/\/$/, '')}/archive/${revision}.zip`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Archive fetch failed (${response.status}) for ${url}`);
  await pipeline(response.body, createWriteStream(destination));
}

async function extractZip(zipPath, destination) {
  execFileSync('unzip', ['-q', zipPath, '-d', destination], { stdio: 'inherit' });
}

function findExtractedRoot(extractDir, revision) {
  const entries = execFileSync('ls', [extractDir], { encoding: 'utf8' }).trim().split('\n');
  const match = entries.find((entry) => entry.includes(revision.slice(0, 12)));
  return join(extractDir, match ?? entries[0]);
}

function sanitizeImportedContent(content) {
  return content
    .replace(/(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET)\s*=\s*["']?(?!<|your-|example|replace|\$)[xX]{16,}["']?/gi, 'API_KEY=<redacted-placeholder>')
    .replace(/(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET)\s*=\s*["']?(?!<|your-|example|replace|\$)[A-Za-z0-9_./+=-]{18,}["']?/gi, (match) => match.includes('your-') || match.includes('example') ? match : 'API_KEY=<redacted-placeholder>');
}

async function copySkillTree(sourceSkillRoot, targetSkillRoot) {
  await mkdir(dirname(targetSkillRoot), { recursive: true });
  execFileSync('rsync', ['-a', '--exclude', 'evals', `${sourceSkillRoot}/`, `${targetSkillRoot}/`], { stdio: 'inherit' });
  const files = await walkFiles(targetSkillRoot, '', FILE_EXCLUDE_PREFIXES);
  for (const file of files) {
    const bytes = await readFile(file.abs);
    const text = bytes.toString('utf8');
    const sanitized = sanitizeImportedContent(text);
    if (sanitized !== text) await writeFile(file.abs, sanitized, 'utf8');
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
  const zipPath = join(staging, 'archive.zip');
  const extractDir = join(staging, 'extract');
  await mkdir(extractDir, { recursive: true });
  await downloadArchive(spec.sourceUrl, spec.revision, zipPath);
  await extractZip(zipPath, extractDir);
  const upstreamRoot = findExtractedRoot(extractDir, spec.revision);

  const discovered = [];
  const excluded = [];
  for (const rootRel of spec.skillRoots) {
    const root = join(upstreamRoot, rootRel);
    discovered.push(...await discoverSkillDirs(root, upstreamRoot, excluded, spec.excludePathPrefixes));
  }

  const unique = new Map();
  for (const skill of discovered) unique.set(skill.skillName, skill);
  const finalSkills = [...unique.values()].sort((a, b) => a.skillName.localeCompare(b.skillName));

  const bundleDir = join(repoRoot, 'catalog', 'bundles', bundleId);
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
    upstreamSkillTotal: finalSkills.length + excluded.length,
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

  if (mode === 'check') {
    process.stdout.write(`${JSON.stringify({ mode, diff, lockSummary: { bundleId, revision: spec.revision, importedSkillTotal: finalSkills.length, excluded: excluded.length, inventoryDigest } }, null, 2)}\n`);
    await rm(staging, { recursive: true, force: true });
    return;
  }

  await mkdir(join(repoRoot, 'catalog', 'bundles'), { recursive: true });
  await rm(bundleDir, { recursive: true, force: true });
  execFileSync('cp', ['-R', targetRoot, bundleDir], { stdio: 'inherit' });
  await mkdir(join(repoRoot, 'catalog', 'locks'), { recursive: true });
  await writeFile(join(repoRoot, 'catalog', 'locks', `${bundleId}.lock.json`), `${JSON.stringify(lock, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ mode, diff, bundleDir, lockPath: join('catalog', 'locks', `${bundleId}.lock.json`) }, null, 2)}\n`);
  await rm(staging, { recursive: true, force: true });
}

const [bundleId, mode = 'apply'] = process.argv.slice(2);
if (!bundleId || !['bmad', 'nvidia'].includes(bundleId)) {
  console.error('Usage: node scripts/sync-skill-bundle.mjs <bmad|nvidia> [check|apply]');
  process.exit(1);
}
buildBundle(bundleId, mode === 'check' ? 'check' : 'apply').catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
