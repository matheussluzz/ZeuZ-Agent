import type { Stats } from 'node:fs';
import { lstat as lstatAsync, mkdir as mkdirAsync } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { SkillRegistryError } from './errors.js';
import { assertPathComponentsNotSymlinks } from './paths.js';

function assertOwnedPrivate(metadata: Stats, label: string, expected: 'file' | 'directory'): void {
  const correctType = expected === 'file' ? metadata.isFile() : metadata.isDirectory();
  if (!correctType) {
    throw new SkillRegistryError('INSTALL_STATE_PERMISSIONS', `${label} must be a regular ${expected}.`);
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new SkillRegistryError('INSTALL_STATE_PERMISSIONS', `${label} must be owned by the current user.`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new SkillRegistryError('INSTALL_STATE_PERMISSIONS', `${label} must not be group/world accessible.`);
  }
}

async function validateInstallRoot(installRoot: string): Promise<string> {
  const root = resolve(installRoot);
  try {
    const metadata = await lstatAsync(root);
    if (metadata.isSymbolicLink()) throw new SkillRegistryError('SYMLINK_REJECTED', 'Install root symlink rejected.');
    if (!metadata.isDirectory()) throw new SkillRegistryError('INSTALL_STATE_PERMISSIONS', 'Install root must be a directory.');
  } catch (error) {
    if (error instanceof SkillRegistryError) throw error;
    throw error;
  }
  return root;
}

export async function secureCatalogStateRoot(installRoot: string): Promise<string> {
  const root = await validateInstallRoot(installRoot);
  const catalogRoot = join(root, 'catalog');
  const stateRoot = join(catalogRoot, 'state');
  await assertPathComponentsNotSymlinks(root, catalogRoot, { allowMissingTail: true });
  await assertPathComponentsNotSymlinks(root, stateRoot, { allowMissingTail: true });
  try {
    assertOwnedPrivate(await lstatAsync(stateRoot), 'Catalog state root', 'directory');
  } catch (error) {
    if (error instanceof SkillRegistryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return stateRoot;
}

export async function secureCatalogStatePath(installRoot: string, fileName: string): Promise<string> {
  const stateRoot = await secureCatalogStateRoot(installRoot);
  const filePath = join(stateRoot, fileName);
  await assertPathComponentsNotSymlinks(resolve(installRoot), filePath, { allowMissingTail: true });
  try {
    const metadata = await lstatAsync(filePath);
    if (metadata.isSymbolicLink()) {
      throw new SkillRegistryError('SYMLINK_REJECTED', `State file symlink rejected: ${fileName}`);
    }
    assertOwnedPrivate(metadata, `State file ${fileName}`, 'file');
  } catch (error) {
    if (error instanceof SkillRegistryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SkillRegistryError('INSTALL_STATE_CORRUPT', `State file is unreadable: ${fileName}`);
    }
  }
  return filePath;
}

export async function mkdirSecureCatalogState(installRoot: string): Promise<string> {
  const stateRoot = await secureCatalogStateRoot(installRoot);
  await mkdirAsync(stateRoot, { recursive: true, mode: 0o700 });
  assertOwnedPrivate(await lstatAsync(stateRoot), 'Catalog state root', 'directory');
  return stateRoot;
}
