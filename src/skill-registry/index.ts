import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { installRoot } from '../env.js';
import { digestInventory, sha256Hex } from './digest.js';
import { SkillRegistryError } from './errors.js';
import { buildSkillInventory, skillDirectoryName, type SkillInventory } from './inventory.js';
import { normalizeSkillId, readZeuzManifest } from './identity.js';
import { readSkillMetadata } from './parser.js';
import { assertPathComponentsNotSymlinks, assertPortableRelative, hydrateCatalogIndex, serializeSkillRecord, toInstallRelative } from './paths.js';
import type { BundleLockFile, BundleLockSummary, CatalogIndex, CatalogSkillRecord, SkillSourceRef } from './types.js';
import { MAX_INDEX_BYTES, SKILL_REGISTRY_SCHEMA_VERSION } from './types.js';

const PANTHEON_ROOT = 'skills';
const BUNDLE_ROOT = 'catalog/bundles';
const LOCK_ROOT = 'catalog/locks';
const INDEX_ROOT = 'catalog/index';
const MAX_BUNDLE_INVENTORY_FILES = 10_000;
const MAX_BUNDLE_INVENTORY_DEPTH = 32;
const AIHERO_SOURCE: SkillSourceRef = {
  kind: 'pantheon',
  namespace: 'zeuz/aihero',
  canonicalUrl: 'https://github.com/mattpocock/skills',
  revision: '6654f6b60cd9d5be8b54c6fafe44346dabeb3b76',
};

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function catalogPaths(root = installRoot()): {
  pantheonRoot: string;
  bundleRoot: string;
  lockRoot: string;
  indexPath: string;
  stateRoot: string;
} {
  return {
    pantheonRoot: resolve(root, PANTHEON_ROOT),
    bundleRoot: resolve(root, BUNDLE_ROOT),
    lockRoot: resolve(root, LOCK_ROOT),
    indexPath: resolve(root, INDEX_ROOT, 'catalog.index.json'),
    stateRoot: resolve(root, 'catalog', 'state'),
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

function pantheonManifestDefaults(): Partial<import('./types.js').ZeuzSkillExtension> {
  return {
    namespace: 'zeuz/pantheon',
    version: '0.1.0',
    trust: 'enabled',
    enablement: 'enabled',
    networkPolicy: 'offline',
    contextBudgetBytes: 64 * 1024,
  };
}

async function loadSkillRecord(root: string, skillRoot: string, source: SkillSourceRef, verifiedInventory?: SkillInventory): Promise<CatalogSkillRecord> {
  const directoryName = skillDirectoryName(skillRoot);
  const skillMdPath = join(skillRoot, 'SKILL.md');
  const inventory = verifiedInventory ?? await buildSkillInventory(skillRoot);
  let portable: import('./types.js').PortableSkillMetadata;
  let zeuz: import('./types.js').ZeuzSkillExtension;
  const validationErrors: string[] = [];
  try {
    portable = await readSkillMetadata(skillMdPath, directoryName);
    const manifestPath = join(skillRoot, 'zeuz.manifest.yaml');
    if (!(await pathExists(manifestPath)) && source.kind === 'pantheon') {
      throw new SkillRegistryError('ZEUZ_MANIFEST_MISSING', `Pantheon skill ${directoryName} is missing zeuz.manifest.yaml.`);
    }
    zeuz = await pathExists(manifestPath)
      ? await readZeuzManifest(manifestPath, source.kind === 'pantheon' ? pantheonManifestDefaults() : undefined)
      : readBundleDefaults(source);
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
  const record: CatalogSkillRecord = {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    id,
    name: portable.name,
    description: portable.description,
    rootRel: toInstallRelative(root, skillRoot),
    skillMdRel: toInstallRelative(root, skillMdPath),
    source,
    portable,
    zeuz,
    inventoryDigest: inventory.digest,
    fileCount: inventory.files.length,
    totalBytes: inventory.totalBytes,
    validation: { errors: validationErrors, warnings: [] },
  };
  return serializeSkillRecord(root, record);
}

async function sourceForPantheonSkill(skillRoot: string): Promise<SkillSourceRef> {
  try {
    const manifest = await readZeuzManifest(join(skillRoot, 'zeuz.manifest.yaml'));
    if (manifest.namespace === AIHERO_SOURCE.namespace) return AIHERO_SOURCE;
  } catch {
    // loadSkillRecord reports malformed or missing manifests as invalid records.
  }
  return {
    kind: 'pantheon',
    namespace: 'zeuz/pantheon',
    canonicalUrl: 'local:pantheon',
    revision: 'reviewed-local',
  };
}

async function readAiHeroDigests(root: string, skillNames: string[]): Promise<Map<string, string>> {
  const sourcePath = resolve(root, 'third_party', 'aihero', 'SOURCE.json');
  try {
    await assertPathComponentsNotSymlinks(root, sourcePath);
    const parsed = objectRecord(JSON.parse(await readFile(sourcePath, 'utf8')));
    const digestsValue = objectRecord(parsed?.skillDigests);
    if (parsed?.source !== AIHERO_SOURCE.canonicalUrl || parsed.revision !== AIHERO_SOURCE.revision || !digestsValue) {
      throw new Error('SOURCE.json does not match the pinned AIHero source.');
    }
    const expectedNames = [...skillNames].sort();
    const recordedNames = Object.keys(digestsValue).sort();
    if (JSON.stringify(expectedNames) !== JSON.stringify(recordedNames)) {
      throw new Error('SOURCE.json skill scope does not match discovered AIHero skills.');
    }
    const digests = new Map<string, string>();
    for (const name of expectedNames) {
      const digest = digestsValue[name];
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/i.test(digest)) {
        throw new Error(`SOURCE.json has an invalid inventory digest for ${name}.`);
      }
      digests.set(name, digest);
    }
    return digests;
  } catch (error) {
    if (error instanceof SkillRegistryError) throw error;
    throw new SkillRegistryError('AIHERO_INTEGRITY_MISMATCH', error instanceof Error ? error.message : String(error));
  }
}

function readBundleDefaults(source: SkillSourceRef): import('./types.js').ZeuzSkillExtension {
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

async function readBundleLock(root: string, lockRoot: string, bundleId: string): Promise<BundleLockFile | undefined> {
  const lockPath = join(lockRoot, `${bundleId}.lock.json`);
  if (!(await pathExists(lockPath))) return undefined;
  await assertPathComponentsNotSymlinks(root, lockPath);
  return JSON.parse(await readFile(lockPath, 'utf8')) as BundleLockFile;
}

function skillInventoryFromVerifiedBundle(bundleInventory: SkillInventory, skillRoot: string): SkillInventory {
  const prefix = `${skillDirectoryName(skillRoot)}/`;
  const files = bundleInventory.files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
  return {
    root: resolve(skillRoot),
    files,
    digest: digestInventory(files),
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

export async function buildCatalogIndex(root = installRoot(), generatedAt?: string): Promise<CatalogIndex> {
  const verifiedBundleInventories = await assertInstalledBundlesVerified(root);
  const paths = catalogPaths(root);
  await assertPathComponentsNotSymlinks(root, paths.pantheonRoot, { allowMissingTail: true });
  const skills: CatalogSkillRecord[] = [];
  const bundles: BundleLockSummary[] = [];

  const pantheonRoots = await discoverSkillRoots(paths.pantheonRoot);
  const pantheonSources = new Map<string, SkillSourceRef>();
  for (const skillRoot of pantheonRoots) pantheonSources.set(skillRoot, await sourceForPantheonSkill(skillRoot));
  const aiheroRoots = pantheonRoots.filter((skillRoot) => pantheonSources.get(skillRoot)?.namespace === AIHERO_SOURCE.namespace);
  const aiheroDigests = aiheroRoots.length > 0
    ? await readAiHeroDigests(root, aiheroRoots.map((skillRoot) => skillDirectoryName(skillRoot)))
    : undefined;
  for (const skillRoot of pantheonRoots) {
    const source = pantheonSources.get(skillRoot)!;
    const record = await loadSkillRecord(root, skillRoot, source);
    if (source.namespace === AIHERO_SOURCE.namespace) {
      const expectedDigest = aiheroDigests?.get(record.name);
      if (!expectedDigest || expectedDigest !== record.inventoryDigest) {
        throw new SkillRegistryError('AIHERO_INTEGRITY_MISMATCH', `Inventory digest mismatch for ${record.name}.`);
      }
    }
    skills.push(record);
  }

  for (const bundleId of ['bmad', 'nvidia']) {
    const bundleRoot = join(paths.bundleRoot, bundleId);
    const lock = await readBundleLock(root, paths.lockRoot, bundleId);
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
      skills.push(await loadSkillRecord(root, skillRoot, {
        kind: 'bundle',
        namespace: `import/${bundleId}`,
        canonicalUrl: lock?.sourceUrl ?? `bundle:${bundleId}`,
        revision: lock?.revision ?? 'unknown',
        bundleId,
      }, verifiedBundleInventories.has(bundleId)
        ? skillInventoryFromVerifiedBundle(verifiedBundleInventories.get(bundleId)!, skillRoot)
        : undefined));
    }
  }

  const index: CatalogIndex = {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    generatedAt: generatedAt ?? new Date().toISOString(),
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
  await assertPathComponentsNotSymlinks(root, indexPath, { allowMissingTail: true });
  await mkdir(dirname(indexPath), { recursive: true });
  await assertPathComponentsNotSymlinks(root, indexPath, { allowMissingTail: true });
  const hydrated = hydrateCatalogIndex(root, index);
  const serialized = `${JSON.stringify(hydrated, null, 2)}\n`;
  const temp = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, indexPath);
  return indexPath;
}

export async function loadCatalogIndex(root = installRoot()): Promise<CatalogIndex> {
  // The generated index is an inspectable cache/output, never a trust root. Rebuild
  // runtime state from the manifests and bundle locks so a writable cache cannot
  // change routing, trust, identity, or paths.
  return buildCatalogIndex(root);
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
  return mismatches;
}

async function inspectInstalledBundleBytes(root: string, bundleId: string, lock: BundleLockFile): Promise<{ mismatches: string[]; inventory?: SkillInventory }> {
  const bundleRoot = join(catalogPaths(root).bundleRoot, bundleId);
  const mismatches: string[] = [];
  let current: Awaited<ReturnType<typeof buildSkillInventory>>;
  try {
    current = await buildSkillInventory(bundleRoot, {
      maxFiles: MAX_BUNDLE_INVENTORY_FILES,
      maxDepth: MAX_BUNDLE_INVENTORY_DEPTH,
    });
  } catch (error) {
    const code = error instanceof SkillRegistryError ? error.code : 'INVENTORY_READ_FAILED';
    return { mismatches: [`inventory:${code}`] };
  }

  const expected = new Map<string, { path: string; size: number; sha256: string }>();
  for (const file of lock.files) {
    try {
      const path = assertPortableRelative(file.path, 'bundle lock file path');
      if (expected.has(path)) mismatches.push(`duplicate:${path}`);
      else expected.set(path, { ...file, path });
    } catch {
      mismatches.push(`invalid-path:${file.path}`);
    }
  }

  const actual = new Map(current.files.map((file) => [file.path, file] as const));
  for (const [path, file] of expected) {
    const observed = actual.get(path);
    if (!observed) {
      mismatches.push(`missing:${path}`);
      continue;
    }
    if (observed.size !== file.size) mismatches.push(`size:${path}`);
    if (observed.sha256 !== file.sha256) mismatches.push(`sha256:${path}`);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) mismatches.push(`unexpected:${path}`);
  }
  if (current.digest !== lock.inventoryDigest) mismatches.push('inventory-digest');
  return { mismatches, inventory: current };
}

export async function verifyInstalledBundleBytes(root: string, bundleId: string, lock: BundleLockFile): Promise<string[]> {
  return (await inspectInstalledBundleBytes(root, bundleId, lock)).mismatches;
}

async function inspectInstalledBundles(root = installRoot()): Promise<{ mismatches: string[]; inventories: Map<string, SkillInventory> }> {
  const paths = catalogPaths(root);
  await assertPathComponentsNotSymlinks(root, paths.lockRoot, { allowMissingTail: true });
  await assertPathComponentsNotSymlinks(root, paths.bundleRoot, { allowMissingTail: true });
  const mismatches: string[] = [];
  const inventories = new Map<string, SkillInventory>();
  for (const bundleId of ['bmad', 'nvidia'] as const) {
    const lock = await readBundleLock(root, paths.lockRoot, bundleId);
    if (!lock) continue;
    const bundleRoot = join(paths.bundleRoot, bundleId);
    if (!(await pathExists(bundleRoot))) {
      if (lock.importedSkillTotal > 0) mismatches.push(`${bundleId}:bundle-missing`);
      continue;
    }
    const inspection = await inspectInstalledBundleBytes(root, bundleId, lock);
    mismatches.push(...inspection.mismatches.map((item) => `${bundleId}:${item}`));
    if (inspection.inventory) inventories.set(bundleId, inspection.inventory);
    const discovered: string[] = [];
    for (const skillRoot of await discoverSkillRoots(bundleRoot)) {
      discovered.push(`import/${bundleId}/${skillDirectoryName(skillRoot)}@0.0.0`);
    }
    mismatches.push(...reconcileBundleLock(lock, discovered).map((item) => `${bundleId}:${item}`));
  }
  return { mismatches, inventories };
}

export async function collectBundleIntegrityMismatches(root = installRoot()): Promise<string[]> {
  return (await inspectInstalledBundles(root)).mismatches;
}

export async function assertInstalledBundlesVerified(root = installRoot()): Promise<Map<string, SkillInventory>> {
  const { mismatches, inventories } = await inspectInstalledBundles(root);
  if (mismatches.length > 0) {
    throw new SkillRegistryError('BUNDLE_INTEGRITY_MISMATCH', mismatches.join(', '));
  }
  return inventories;
}
