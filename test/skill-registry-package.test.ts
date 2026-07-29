import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCatalogIndex, indexMetadataBytes } from '../src/skill-registry/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function packedCorePaths(): string[] {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  const jsonStart = output.lastIndexOf('\n[');
  const manifest = JSON.parse(jsonStart >= 0 ? output.slice(jsonStart + 1) : output)[0];
  return manifest.files.map((file: string | { path: string }) => (typeof file === 'string' ? file : file.path));
}

test('npm pack core stays within wave 05 file-count ceiling', () => {
  const paths = packedCorePaths();
  assert.ok(paths.length <= 350, `expected <= 350 packed files, got ${paths.length}`);
  assert.ok(!paths.some((file: string) => file.startsWith('catalog/bundles/')));
  assert.ok(!paths.some((file: string) => file.includes('__pycache__') || file.endsWith('.pyc')));
  assert.ok(!paths.some((file: string) => file.endsWith('.map')));
  assert.ok(paths.includes('dist/src/skill-registry/lease-lock.js'));
  assert.ok(paths.includes('dist/src/skill-registry/state-security.js'));
});

test('catalog index metadata remains bounded with bundles installed', async () => {
  const index = await buildCatalogIndex(repoRoot);
  const bytes = indexMetadataBytes(index);
  assert.ok(bytes <= 512 * 1024, `index metadata bytes ${bytes} exceed 512KiB`);
});

test('bmad lock reconciles when bundle is present', () => {
  const lockPath = join(repoRoot, 'catalog', 'locks', 'bmad.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const nvidiaLock = JSON.parse(readFileSync(join(repoRoot, 'catalog', 'locks', 'nvidia.lock.json'), 'utf8'));
  assert.equal(lock.revision, '717479bc3f50f38119fd958b9e577a8bde2e0184');
  assert.ok(lock.importedSkillTotal >= 50);
  assert.equal(nvidiaLock.importedSkillTotal, 230);
  assert.equal(nvidiaLock.upstreamDiscoveredTotal, 242);
  assert.ok(nvidiaLock.excluded.some((entry: { reasonCode: string }) => entry.reasonCode === 'DUPLICATE_SKILL_NAME'));
  assert.ok(lock.files.some((file: { path: string }) => file.path === 'LICENSE'));
});
