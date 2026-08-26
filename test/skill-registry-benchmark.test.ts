import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildCatalogIndex, loadCatalogIndex, writeCatalogIndex } from '../src/skill-registry/index.js';
import { indexMetadataBytes } from '../src/skill-registry/index.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skill-registry-mini');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('clean install rebuilds catalog index without absolute paths', async () => {
  const root = await mkdtemp(join(dirname(fixtureRoot), 'zeuz-clean-install-'));
  process.env.ZEUZ_INSTALL_DIR = root;
  try {
    const index = await buildCatalogIndex(root);
    await writeCatalogIndex(index, root);
    const raw = await readFile(join(root, 'catalog', 'index', 'catalog.index.json'), 'utf8');
    assert.doesNotMatch(raw, /\/Users\//);
    const loaded = await loadCatalogIndex(root);
    assert.equal(loaded.skills.length, index.skills.length);
  } finally {
    delete process.env.ZEUZ_INSTALL_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('discovery metadata benchmark stays within wave 05 ceiling', async () => {
  await buildCatalogIndex(fixtureRoot);
  const samples: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const start = performance.now();
    const index = await buildCatalogIndex(fixtureRoot);
    const bytes = indexMetadataBytes(index);
    samples.push(performance.now() - start);
    assert.equal(index.skills.length, 3);
    assert.ok(bytes <= 512 * 1024);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? samples[0] ?? 0;
  assert.ok(p95 <= 75, `discovery p95 ${p95}ms exceeds 75ms`);
});

test('real catalog integrity and discovery stay within the shipped-catalog ceiling', async () => {
  const samples: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const start = performance.now();
    const index = await buildCatalogIndex(repoRoot);
    samples.push(performance.now() - start);
    assert.ok(index.skills.length >= 280, `expected the shipped catalog scale, got ${index.skills.length} skills`);
    assert.ok(indexMetadataBytes(index) <= 512 * 1024);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? samples[0] ?? 0;
  assert.ok(p95 <= 4_000, `real catalog integrity/discovery p95 ${p95}ms exceeds 4000ms`);
});
