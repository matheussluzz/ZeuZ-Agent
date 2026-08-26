import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { SkillRegistryError } from './errors.js';
import type { CatalogIndex, CatalogSkillRecord } from './types.js';

export function assertPortableRelative(rel: string, label: string): string {
  const normalized = rel.split('\\').join('/');
  if (!normalized || normalized.startsWith('/') || isAbsolute(normalized)) {
    throw new SkillRegistryError('SKILL_PATH_INVALID', `${label} must be a portable relative path.`);
  }
  for (const segment of normalized.split('/')) {
    if (segment === '..') {
      throw new SkillRegistryError('SKILL_PATH_INVALID', `${label} must not contain .. segments.`);
    }
  }
  return normalized;
}

export function isInsideInstallRoot(root: string, absolutePath: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(absolutePath);
  const rel = relative(resolvedRoot, resolvedPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function assertPathComponentsNotSymlinks(root: string, absolutePath: string, options?: { allowMissingTail?: boolean }): Promise<void> {
  const resolvedRoot = resolve(root);
  const target = resolve(absolutePath);
  if (!isInsideInstallRoot(resolvedRoot, target)) {
    throw new SkillRegistryError('SKILL_PATH_INVALID', `Path escapes install root: ${absolutePath}`);
  }
  const rel = relative(resolvedRoot, target);
  if (!rel) return;
  let current = resolvedRoot;
  for (const segment of rel.split('/').filter(Boolean)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new SkillRegistryError('SYMLINK_REJECTED', `Symlink component rejected: ${segment}`);
      }
    } catch (error) {
      if (options?.allowMissingTail && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof SkillRegistryError) throw error;
      throw error;
    }
  }
}

export function toInstallRelative(root: string, absolutePath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(absolutePath);
  if (!isInsideInstallRoot(resolvedRoot, resolvedPath)) {
    throw new SkillRegistryError('SKILL_PATH_INVALID', `Path escapes install root: ${absolutePath}`);
  }
  return relative(resolvedRoot, resolvedPath).split('\\').join('/');
}

export function resolveSkillPaths(root: string, record: CatalogSkillRecord): { rootPath: string; skillMdPath: string } {
  const rootRel = assertPortableRelative(record.rootRel ?? legacyRootRel(root, record), 'rootRel');
  const skillMdRel = assertPortableRelative(record.skillMdRel ?? legacySkillMdRel(root, record), 'skillMdRel');
  const rootPath = resolve(root, rootRel);
  const skillMdPath = resolve(root, skillMdRel);
  if (!isInsideInstallRoot(root, rootPath) || !isInsideInstallRoot(root, skillMdPath)) {
    throw new SkillRegistryError('SKILL_PATH_INVALID', `Resolved skill path escapes install root for ${record.id}.`);
  }
  return { rootPath, skillMdPath };
}

export async function validateSkillPaths(root: string, record: CatalogSkillRecord): Promise<{ rootPath: string; skillMdPath: string }> {
  const paths = resolveSkillPaths(root, record);
  await assertPathComponentsNotSymlinks(root, paths.rootPath);
  await assertPathComponentsNotSymlinks(root, paths.skillMdPath);
  return paths;
}

function legacyRootRel(root: string, record: CatalogSkillRecord): string {
  const legacy = (record as { rootPath?: string }).rootPath;
  if (!legacy) throw new SkillRegistryError('SKILL_PATH_INVALID', `Skill record ${record.id} is missing rootRel.`);
  if (!isAbsolute(legacy)) return legacy.split('\\').join('/');
  return toInstallRelative(root, legacy);
}

function legacySkillMdRel(root: string, record: CatalogSkillRecord): string {
  const legacy = (record as { skillMdPath?: string }).skillMdPath;
  if (!legacy) throw new SkillRegistryError('SKILL_PATH_INVALID', `Skill record ${record.id} is missing skillMdRel.`);
  if (!isAbsolute(legacy)) return legacy.split('\\').join('/');
  return toInstallRelative(root, legacy);
}

export function serializeSkillRecord(root: string, record: CatalogSkillRecord): CatalogSkillRecord {
  const { rootPath, skillMdPath } = resolveSkillPaths(root, record);
  return {
    ...record,
    rootRel: toInstallRelative(root, rootPath),
    skillMdRel: toInstallRelative(root, skillMdPath),
  };
}

export function hydrateCatalogIndex(root: string, index: CatalogIndex): CatalogIndex {
  return {
    ...index,
    skills: index.skills.map((skill) => serializeSkillRecord(root, skill)),
  };
}

export function indexNeedsRebuild(index: CatalogIndex): boolean {
  return index.skills.some((skill) => {
    const legacyRoot = (skill as { rootPath?: string }).rootPath;
    const legacySkillMd = (skill as { skillMdPath?: string }).skillMdPath;
    return Boolean(legacyRoot?.startsWith('/') || legacySkillMd?.startsWith('/') || !skill.rootRel || !skill.skillMdRel);
  });
}
