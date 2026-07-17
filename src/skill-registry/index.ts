import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { installRoot } from '../env.js';
import { digestInventory } from './digest.js';
import { SkillRegistryError } from './errors.js';
import { buildSkillInventory, skillDirectoryName } from './inventory.js';
import { normalizeSkillId, readZeuzManifest } from './identity.js';
import { readSkillMetadata } from './parser.js';
import type { BundleLockFile, BundleLockSummary, CatalogIndex, CatalogSkillRecord, SkillSourceRef } from './types.js';
import { MAX_INDEX_BYTES, SKILL_REGISTRY_SCHEMA_VERSION } from './types.js';

const PANTHEON_ROOT = 'skills';
const BUNDLE_ROOT = 'catalog/bundles';
const LOCK_ROOT = 'catalog/locks';
const INDEX_ROOT = 'catalog/index';

export function catalogPaths(root = installRoot()): {
  pantheonRoot: string;
  bundleRoot: string;
  lockRoot: string;
  indexPath: string;
} {
  return {
    pantheonRoot: resolve(root, PANTHEON_ROOT),
    bundleRoot: resolve(root, BUNDLE_ROOT),
    lockRoot: resolve(root, LOCK_ROOT),
    indexPath: resolve(root, INDEX_ROOT, 'catalog.index.json'),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function discoverSkillRoots(base: string): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(base, { withFileTypes: true });
    const roots: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillRoot = join(base, entry.name);
      if (await pathExists(join(skillRoot, 'SKILL.md'))) roots.push(skillRoot);
    }
    return roots.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function pantheonDefaults(skillName: string): Partial<import('./types.js').ZeuzSkillExtension> {
  return {
    namespace: 'zeuz/pantheon',
    version: '0.1.0',
    trust: 'enabled',
    enablement: 'enabled',
    networkPolicy: 'offline',
    dependencies: skillName === 'metis' ? ['medusa'] : skillName === 'atena' ? ['prometeu', 'clio'] : [],
    triggers: PANTHEON_TRIGGERS[skillName] ?? [],
    contextBudgetBytes: 64 * 1024,
  };
}

const PANTHEON_TRIGGERS: Record<string, string[]> = {
  medusa: ['(?:\\bmedusa\\b|adversarial|review|revis(?:ar|ão|ao))'],
  hermes: ['(?:\\bhermes\\b|linguagem simples|comercial|executiv|explic(?:ar|ação|acao))'],
  hefesto: ['(?:\\bhefesto\\b|dashboard|highcharts|gr[aá]fico)'],
  atena: ['(?:\\batena\\b|aws athena|amazon athena|glue catalog)'],
  clio: ['(?:\\bclio\\b|obsidian|vault|cofre|gloss[aá]rio|wikilink)'],
  prometeu: ['(?:\\bprometeu\\b|\\bsql\\b|\\bquery\\b|consulta.+(?:custo|scan)|bytes scanned)'],
  argos: ['(?:\\bargos\\b|machine learning|\\bml\\b|forecast|chronos|timegpt|patchtst|lightgbm|monte carlo|\\bvar\\b|vecm|rede neural)'],
  metis: ['(?:\\bmetis\\b|deep research|pesquisa profunda|checagem de fontes|verificar fontes|source ledger)'],
};

async function loadSkillRecord(skillRoot: string, source: SkillSourceRef): Promise<CatalogSkillRecord> {
  const directoryName = skillDirectoryName(skillRoot);
  const skillMdPath = join(skillRoot, 'SKILL.md');
  const inventory = await buildSkillInventory(skillRoot);
  let portable: import('./types.js').PortableSkillMetadata;
  let zeuz: import('./types.js').ZeuzSkillExtension;
  const validationErrors: string[] = [];
  try {
    portable = await readSkillMetadata(skillMdPath, directoryName);
    const manifestPath = join(skillRoot, 'zeuz.manifest.yaml');
    zeuz = await pathExists(manifestPath)
      ? await readZeuzManifest(manifestPath, pantheonDefaults(directoryName))
      : readZeuzManifestFromDefaults(directoryName, source);
  } catch (error) {
    portable = { name: directoryName, description: `Invalid imported skill (${directoryName})` };
    zeuz = {
      namespace: source.namespace,
      version: '0.0.0',
      trust: 'invalid',
      enablement: 'disabled',
      networkPolicy: source.kind === 'bundle' ? 'explicit-sync-only' : 'offline',
      triggers: [],
      dependencies: [],
      conflicts: [],
      capabilityTags: [],
      allowedTools: [],
    };
    validationErrors.push(error instanceof Error ? error.message : String(error));
  }
  const id = normalizeSkillId(zeuz.namespace, portable.name, zeuz.version);
  return {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    id,
    name: portable.name,
    description: portable.description,
    rootPath: skillRoot,
    skillMdPath,
    source,
    portable,
    zeuz,
    inventoryDigest: inventory.digest,
    fileCount: inventory.files.length,
    totalBytes: inventory.totalBytes,
    validation: { errors: validationErrors, warnings: [] },
  };
}

function readZeuzManifestFromDefaults(directoryName: string, source: SkillSourceRef): import('./types.js').ZeuzSkillExtension {
  const defaults = pantheonDefaults(directoryName);
  if (source.kind === 'bundle') {
    return {
      namespace: source.namespace,
      version: '0.0.0',
      trust: 'quarantined',
      enablement: 'disabled',
      networkPolicy: 'explicit-sync-only',
      triggers: [],
      dependencies: [],
      conflicts: [],
      capabilityTags: [],
      allowedTools: [],
      contextBudgetBytes: 32 * 1024,
    };
  }
  return {
    namespace: defaults.namespace!,
    version: defaults.version!,
    trust: defaults.trust!,
    enablement: defaults.enablement!,
    networkPolicy: defaults.networkPolicy!,
    triggers: defaults.triggers ?? [],
    dependencies: defaults.dependencies ?? [],
    conflicts: [],
    capabilityTags: [],
    allowedTools: [],
    ...(defaults.contextBudgetBytes !== undefined ? { contextBudgetBytes: defaults.contextBudgetBytes } : {}),
  };
}

async function readBundleLock(lockRoot: string, bundleId: string): Promise<BundleLockFile | undefined> {
  const lockPath = join(lockRoot, `${bundleId}.lock.json`);
  if (!(await pathExists(lockPath))) return undefined;
  return JSON.parse(await readFile(lockPath, 'utf8')) as BundleLockFile;
}

export async function buildCatalogIndex(root = installRoot(), now = new Date().toISOString()): Promise<CatalogIndex> {
  const paths = catalogPaths(root);
  const skills: CatalogSkillRecord[] = [];
  const bundles: BundleLockSummary[] = [];

  for (const skillRoot of await discoverSkillRoots(paths.pantheonRoot)) {
    skills.push(await loadSkillRecord(skillRoot, {
      kind: 'pantheon',
      namespace: 'zeuz/pantheon',
      canonicalUrl: 'local:pantheon',
      revision: 'reviewed-local',
    }));
  }

  for (const bundleId of ['bmad', 'nvidia']) {
    const bundleRoot = join(paths.bundleRoot, bundleId);
    const lock = await readBundleLock(paths.lockRoot, bundleId);
    if (lock) {
      bundles.push({
        bundleId,
        sourceUrl: lock.sourceUrl,
        revision: lock.revision,
        inventoryDigest: lock.inventoryDigest,
        skillCount: lock.importedSkillTotal,
        excludedCount: lock.excluded.length,
        trust: 'quarantined',
        enablement: 'disabled',
      });
    }
    if (!(await pathExists(bundleRoot))) continue;
    for (const skillRoot of await discoverSkillRoots(bundleRoot)) {
      skills.push(await loadSkillRecord(skillRoot, {
        kind: 'bundle',
        namespace: `import/${bundleId}`,
        canonicalUrl: lock?.sourceUrl ?? `bundle:${bundleId}`,
        revision: lock?.revision ?? 'unknown',
        bundleId,
      }));
    }
  }

  const index: CatalogIndex = {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    generatedAt: now,
    installRoot: root,
    skills: skills.sort((left, right) => left.id.localeCompare(right.id)),
    bundles,
  };
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_INDEX_BYTES) {
    throw new SkillRegistryError('INDEX_TOO_LARGE', `Catalog index exceeds ${MAX_INDEX_BYTES} bytes.`);
  }
  return index;
}

export async function writeCatalogIndex(index: CatalogIndex, root = installRoot()): Promise<string> {
  const { indexPath } = catalogPaths(root);
  await mkdir(dirname(indexPath), { recursive: true });
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  await writeFile(indexPath, serialized, 'utf8');
  return indexPath;
}

export async function loadCatalogIndex(root = installRoot()): Promise<CatalogIndex> {
  const { indexPath } = catalogPaths(root);
  if (!(await pathExists(indexPath))) return buildCatalogIndex(root);
  return JSON.parse(await readFile(indexPath, 'utf8')) as CatalogIndex;
}

export function indexMetadataBytes(index: CatalogIndex): number {
  return Buffer.byteLength(JSON.stringify(index.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    trust: skill.zeuz.trust,
    enablement: skill.zeuz.enablement,
  }))), 'utf8');
}

export function reconcileBundleLock(lock: BundleLockFile, discoveredSkillIds: string[]): string[] {
  const expected = [...lock.skills.map((skill) => skill.id)].sort();
  const actual = [...discoveredSkillIds].sort();
  const mismatches: string[] = [];
  if (expected.length !== actual.length) mismatches.push('skill-count');
  for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
    if (expected[index] !== actual[index]) mismatches.push(`skill-id:${actual[index] ?? expected[index]}`);
  }
  const digest = digestInventory(lock.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })));
  if (digest !== lock.inventoryDigest) mismatches.push('inventory-digest');
  return mismatches;
}
