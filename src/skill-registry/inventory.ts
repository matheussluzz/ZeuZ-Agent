import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import { digestInventory, sha256File } from './digest.js';
import { SkillRegistryError } from './errors.js';
import { rejectConfusablePath } from './identity.js';
import type { SkillFileRecord } from './types.js';
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_TREE_DEPTH, MAX_SKILL_TREE_FILES } from './types.js';

const RESERVED_NAMES = new Set(['con', 'prn', 'aux', 'nul']);

export interface InventoryOptions {
  root: string;
  maxFiles?: number;
  maxDepth?: number;
  maxFileBytes?: number;
}

export interface SkillInventory {
  root: string;
  files: SkillFileRecord[];
  digest: string;
  totalBytes: number;
}

async function walk(root: string, current: string, relativePrefix: string, depth: number, options: Required<InventoryOptions>, files: SkillFileRecord[]): Promise<void> {
  if (depth > options.maxDepth) throw new SkillRegistryError('INVENTORY_DEPTH_EXCEEDED', `Skill tree depth exceeds ${options.maxDepth}.`);
  if (files.length > options.maxFiles) throw new SkillRegistryError('INVENTORY_FILE_COUNT_EXCEEDED', `Skill tree exceeds ${options.maxFiles} files.`);
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    rejectConfusablePath(entry.name);
    if (RESERVED_NAMES.has(entry.name.toLowerCase())) throw new SkillRegistryError('PATH_RESERVED', `Reserved filename: ${entry.name}`);
    const absolute = join(current, entry.name);
    const relativePath = relativePrefix ? join(relativePrefix, entry.name) : entry.name;
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new SkillRegistryError('SYMLINK_REJECTED', `Symlinks are not allowed: ${relativePath}`);
    if (metadata.isFIFO() || metadata.isSocket() || metadata.isCharacterDevice() || metadata.isBlockDevice()) {
      throw new SkillRegistryError('SPECIAL_FILE_REJECTED', `Special files are not allowed: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      await walk(root, absolute, relativePath, depth + 1, options, files);
      continue;
    }
    if (!metadata.isFile()) throw new SkillRegistryError('INVENTORY_UNSUPPORTED_ENTRY', `Unsupported entry: ${relativePath}`);
    if (metadata.size > options.maxFileBytes) throw new SkillRegistryError('FILE_TOO_LARGE', `File exceeds size limit: ${relativePath}`);
    const normalized = relative(root, absolute).split('\\').join('/');
    if (normalized.startsWith('..') || resolve(absolute) !== resolve(root, normalized)) {
      throw new SkillRegistryError('PATH_TRAVERSAL', `Path escapes skill root: ${relativePath}`);
    }
    files.push({
      path: normalized,
      size: metadata.size,
      sha256: await sha256File(absolute),
    });
  }
}

export async function buildSkillInventory(root: string, options: Omit<InventoryOptions, 'root'> = {}): Promise<SkillInventory> {
  const resolvedRoot = resolve(root);
  const files: SkillFileRecord[] = [];
  const limits: Required<InventoryOptions> = {
    root: resolvedRoot,
    maxFiles: options.maxFiles ?? MAX_SKILL_TREE_FILES,
    maxDepth: options.maxDepth ?? MAX_SKILL_TREE_DEPTH,
    maxFileBytes: options.maxFileBytes ?? MAX_SKILL_FILE_BYTES,
  };
  await walk(resolvedRoot, resolvedRoot, '', 0, limits, files);
  const digest = digestInventory(files);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return { root: resolvedRoot, files, digest, totalBytes };
}

export async function readBoundedFile(path: string, maxBytes = MAX_SKILL_FILE_BYTES): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new SkillRegistryError('SYMLINK_REJECTED', 'Symlinks are not allowed.');
  if (!metadata.isFile()) throw new SkillRegistryError('FILE_NOT_FOUND', 'Expected a regular file.');
  if (metadata.size > maxBytes) throw new SkillRegistryError('FILE_TOO_LARGE', 'File exceeds read budget.');
  return readFile(path, 'utf8');
}

export function skillDirectoryName(skillRoot: string): string {
  return basename(skillRoot);
}
