import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCatalogIndex, indexMetadataBytes } from '../src/skill-registry/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('npm pack core stays within wave 05 file-count ceiling', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  const manifest = JSON.parse(output)[0];
  const paths = manifest.files.map((file: string | { path: string }) => (typeof file === 'string' ? file : file.path));
  assert.ok(paths.length <= 350, `expected <= 350 packed files, got ${paths.length}`);
  assert.ok(!paths.some((file: string) => file.startsWith('catalog/bundles/')));
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
  assert.ok(lock.files.some((file: { path: string }) => file.path === 'LICENSE'));
});
