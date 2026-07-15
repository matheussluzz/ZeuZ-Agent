import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export class UnsafeStateRootError extends Error {
  readonly code = 'UNSAFE_STATE_ROOT';

  constructor(message: string) {
    super(message);
    this.name = 'UnsafeStateRootError';
  }
}

function assertOwnerOnly(mode: number, label: string, expected: 'directory' | 'file'): void {
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new UnsafeStateRootError(`${label} must be owner-only (${expected === 'directory' ? '0700' : '0600'}).`);
  }
}

function assertOwner(uid: number, label: string): void {
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && uid !== process.getuid()) {
    throw new UnsafeStateRootError(`${label} must be owned by the active OS user.`);
  }
}

export async function ensurePrivateStateDirectory(path: string, boundary?: string): Promise<string> {
  const absolute = resolve(path);
  if (boundary) {
    const base = resolve(boundary);
    const relation = relative(base, absolute);
    if (relation.startsWith('..') || isAbsolute(relation)) throw new UnsafeStateRootError(`State directory escapes its root boundary: ${absolute}`);
  }
  try {
    const existing = await lstat(absolute);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new UnsafeStateRootError(`State directory must be a real non-symlink directory: ${absolute}`);
    assertOwnerOnly(existing.mode, absolute, 'directory');
    assertOwner(existing.uid, absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const created = await lstat(absolute);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new UnsafeStateRootError(`State directory creation did not produce a real directory: ${absolute}`);
    assertOwnerOnly(created.mode, absolute, 'directory');
    assertOwner(created.uid, absolute);
  }
  return await realpath(absolute);
}

export async function ensureStateContainerDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    const existing = await lstat(absolute);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new UnsafeStateRootError(`State container must be a real non-symlink directory: ${absolute}`);
    if (process.platform !== 'win32' && (existing.mode & 0o022) !== 0) throw new UnsafeStateRootError(`${absolute} must not be group/world-writable.`);
    assertOwner(existing.uid, absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(absolute, { recursive: true, mode: 0o700 });
  }
  return await realpath(absolute);
}

export async function assertPrivateStateFile(path: string, root: string): Promise<void> {
  const rootReal = resolve(root);
  const absolute = resolve(path);
  const relation = relative(rootReal, absolute);
  if (relation.startsWith('..') || isAbsolute(relation)) throw new UnsafeStateRootError(`State file escapes its root boundary: ${absolute}`);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new UnsafeStateRootError(`State file must be a regular non-symlink file: ${absolute}`);
  assertOwnerOnly(metadata.mode, absolute, 'file');
  assertOwner(metadata.uid, absolute);
}

export function assertStateRecordId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id)) throw new UnsafeStateRootError(`Unsafe state record id: ${JSON.stringify(id)}.`);
}

export async function writePrivateStateFileAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf8');
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
