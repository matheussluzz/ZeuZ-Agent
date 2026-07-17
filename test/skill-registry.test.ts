import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { digestInventory, sha256Hex } from '../src/skill-registry/digest.js';
import { parseSkillMarkdown, validatePortableName } from '../src/skill-registry/parser.js';
import { normalizeSkillId } from '../src/skill-registry/identity.js';
import { buildCatalogIndex, indexMetadataBytes } from '../src/skill-registry/index.js';
import { resolveActivation } from '../src/skill-registry/resolver.js';
import type { CatalogIndex } from '../src/skill-registry/types.js';
import { validateCatalogIndex } from '../src/skill-registry/validator.js';
import { SkillRegistry } from '../src/skills.js';
import { runSkillCommand } from '../src/skill-registry/cli.js';

test('portable parser accepts minimal Agent Skills metadata', () => {
  const parsed = parseSkillMarkdown('---\nname: pdf-processing\ndescription: Handle PDF extraction tasks.\n---\n\n# Body\n', 'pdf-processing');
  assert.equal(parsed.portable.name, 'pdf-processing');
  assert.match(parsed.body, /# Body/);
});

test('portable parser rejects invalid names and directory mismatch', () => {
  assert.throws(() => validatePortableName('PDF-Processing', 'pdf-processing'));
  assert.throws(() => parseSkillMarkdown('---\nname: wrong\ndescription: x\n---\n', 'right'));
});

test('canonical ids are collision-safe and namespaced', () => {
  assert.equal(normalizeSkillId('zeuz/pantheon', 'medusa', '0.1.0'), 'zeuz/pantheon/medusa@0.1.0');
});

test('pantheon routing preserves Metis→Medusa and Atena→Prometeu+Clio without truncation', async () => {
  const index = await buildCatalogIndex();
  const metis = resolveActivation(index, 'Use Metis for deep research');
  assert.deepEqual(metis.ordered.map((skill) => skill.name).sort(), ['medusa', 'metis']);
  const atena = resolveActivation(index, 'Query AWS Athena for this dataset');
  assert.deepEqual(atena.ordered.map((skill) => skill.name).sort(), ['atena', 'clio', 'prometeu']);
});

test('budget exceed returns named error instead of silent truncation', () => {
  const index: CatalogIndex = {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    installRoot: '/tmp',
    bundles: [],
    skills: Array.from({ length: 5 }, (_, index) => ({
      schemaVersion: 1,
      id: `zeuz/pantheon/s${index}@0.1.0`,
      name: `s${index}`,
      description: `skill ${index}`,
      rootPath: `/tmp/s${index}`,
      skillMdPath: `/tmp/s${index}/SKILL.md`,
      source: { kind: 'pantheon' as const, namespace: 'zeuz/pantheon', canonicalUrl: 'local', revision: 'x' },
      portable: { name: `s${index}`, description: `skill ${index}` },
      zeuz: {
        namespace: 'zeuz/pantheon',
        version: '0.1.0',
        trust: 'enabled' as const,
        enablement: 'enabled' as const,
        networkPolicy: 'offline' as const,
        triggers: [`s${index}`],
        dependencies: [],
        conflicts: [],
        contextBudgetBytes: 40_000,
      },
      inventoryDigest: 'x',
      fileCount: 1,
      totalBytes: 1,
    })),
  };
  assert.throws(() => resolveActivation(index, 's0 s1 s2 s3 s4', 100_000), (error: unknown) => (error as { code?: string }).code === 'SKILL_CONTEXT_BUDGET_EXCEEDED');
});

test('catalog index metadata listing stays bounded and does not require SKILL.md bodies', async () => {
  const index = await buildCatalogIndex();
  const bytes = indexMetadataBytes(index);
  assert.ok(bytes <= 512 * 1024);
  const validation = validateCatalogIndex(index);
  assert.equal(validation.ok, true);
});

test('skill CLI list/status/validate respond for pantheon snapshot', async () => {
  const list = await runSkillCommand(['list']);
  assert.equal(list.exitCode, 0);
  assert.match(list.output, /medusa/);
  const status = await runSkillCommand(['status']);
  assert.equal(status.exitCode, 0);
  const validate = await runSkillCommand(['validate']);
  assert.equal(validate.exitCode, 0);
});

test('digest inventory is deterministic', () => {
  const files = [{ path: 'b', sha256: sha256Hex('b'), size: 1 }, { path: 'a', sha256: sha256Hex('a'), size: 2 }];
  assert.equal(digestInventory(files), digestInventory([...files].reverse()));
});

test('controller-compatible SkillRegistry still activates pantheon skills', async () => {
  const context = await new SkillRegistry().contextFor('Use Metis for deep research');
  assert.match(context ?? '', /<skill name="metis"/);
  assert.match(context ?? '', /<skill name="medusa"/);
});
