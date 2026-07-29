import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { SkillRegistryError } from './errors.js';

export interface LeaseLockRecord {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
  ticket?: number;
}

export type ProcessLiveness = 'alive' | 'dead' | 'unknown';

const MAX_ACTIVE_CLAIMS = 4_096;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export function probeProcessLiveness(pid: number): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

export function leaseLockIsReclaimable(lock: LeaseLockRecord, localHost = hostname()): boolean {
  if (lock.host !== localHost) return false;
  if (Date.now() < Date.parse(lock.expiresAt)) return false;
  return probeProcessLiveness(lock.pid) === 'dead';
}

export function parseLeaseLock(raw: string): LeaseLockRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<LeaseLockRecord>;
    if (
      !parsed
      || !Number.isInteger(parsed.pid)
      || typeof parsed.host !== 'string'
      || !TOKEN_PATTERN.test(parsed.token ?? '')
      || typeof parsed.acquiredAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.acquiredAt))
      || typeof parsed.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.expiresAt))
      || (parsed.ticket !== undefined && (!Number.isSafeInteger(parsed.ticket) || parsed.ticket < 0))
    ) return undefined;
    return parsed as LeaseLockRecord;
  } catch {
    return undefined;
  }
}

export function createLeaseLock(leaseMs: number): LeaseLockRecord {
  return {
    pid: process.pid,
    host: hostname(),
    token: randomBytes(16).toString('hex'),
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + leaseMs).toISOString(),
  };
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new SkillRegistryError('INSTALL_LOCK_CORRUPT', 'Lease claims root must be a real directory.');
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new SkillRegistryError('INSTALL_STATE_PERMISSIONS', 'Lease claims root must be owned by the current user.');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new SkillRegistryError('INSTALL_STATE_PERMISSIONS', 'Lease claims root must not be group/world accessible.');
  }
}

async function legacyLockBlocks(lockPath: string): Promise<boolean> {
  try {
    const existing = parseLeaseLock(await readFile(lockPath, 'utf8'));
    if (!existing) throw new SkillRegistryError('INSTALL_LOCK_CORRUPT', 'Legacy lease lock is malformed.');
    if (!leaseLockIsReclaimable(existing)) return true;
    // New code never creates this legacy path, so deleting a proven-dead legacy
    // record cannot race with a successor created by this implementation.
    await unlink(lockPath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (error instanceof SkillRegistryError) throw error;
    throw error;
  }
}

async function inspectActiveClaims(claimsRoot: string): Promise<{ owner?: string; maxTicket: number; choosing: boolean }> {
  const entries = await readdir(claimsRoot, { withFileTypes: true });
  const claimEntries = entries.filter((entry) => entry.name !== 'queue');
  if (claimEntries.length > MAX_ACTIVE_CLAIMS) {
    throw new SkillRegistryError('INSTALL_LOCK_CORRUPT', `Lease claims exceed ${MAX_ACTIVE_CLAIMS} active entries.`);
  }
  const active: LeaseLockRecord[] = [];
  let choosing = false;
  let maxTicket = 0;
  for (const entry of claimEntries) {
    const suffix = entry.name.endsWith('.json') ? '.json' : entry.name.endsWith('.choosing') ? '.choosing' : '';
    const token = suffix ? entry.name.slice(0, -suffix.length) : '';
    if (!entry.isFile() || !TOKEN_PATTERN.test(token)) {
      throw new SkillRegistryError('INSTALL_LOCK_CORRUPT', `Lease claims root contains an invalid entry: ${entry.name}`);
    }
    const claimPath = join(claimsRoot, entry.name);
    let claim: LeaseLockRecord | undefined;
    try {
      claim = parseLeaseLock(await readFile(claimPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!claim || claim.token !== token) {
      throw new SkillRegistryError('INSTALL_LOCK_CORRUPT', `Lease claim ${token} is malformed.`);
    }
    if (leaseLockIsReclaimable(claim)) {
      await unlink(claimPath).catch(() => undefined);
      continue;
    }
    if (suffix === '.choosing') {
      choosing = true;
      continue;
    }
    if (!Number.isSafeInteger(claim.ticket) || claim.ticket! <= 0) {
      throw new SkillRegistryError('INSTALL_LOCK_CORRUPT', `Lease claim ${token} has no valid ticket.`);
    }
    maxTicket = Math.max(maxTicket, claim.ticket!);
    active.push(claim);
  }
  active.sort((left, right) => left.ticket! - right.ticket! || left.token.localeCompare(right.token));
  return active[0]
    ? { owner: active[0].token, maxTicket, choosing }
    : { maxTicket, choosing };
}

export class LeaseLockHandle {
  readonly token: string;
  readonly claimPath: string;

  constructor(token: string, claimPath: string) {
    this.token = token;
    this.claimPath = claimPath;
  }

  async release(): Promise<void> {
    // Claims are immutable and uniquely named, so a stale handle can remove only
    // its own claim and never a successor's ownership record.
    await unlink(this.claimPath).catch(() => undefined);
  }
}

export async function acquireLeaseLock(lockPath: string, leaseMs: number, deadlineMs = 5_000): Promise<LeaseLockHandle> {
  const claimsRoot = `${lockPath}.claims`;
  await mkdir(claimsRoot, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(claimsRoot);
  const claim = createLeaseLock(leaseMs);
  const choosingPath = join(claimsRoot, `${claim.token}.choosing`);
  const claimPath = join(claimsRoot, `${claim.token}.json`);
  await writeFile(choosingPath, `${JSON.stringify({ ...claim, ticket: 0 })}\n`, { flag: 'wx', mode: 0o600 });
  try {
    const snapshot = await inspectActiveClaims(claimsRoot);
    const ticket = snapshot.maxTicket + 1;
    if (!Number.isSafeInteger(ticket)) throw new SkillRegistryError('INSTALL_LOCK_CORRUPT', 'Lease claim ticket space is exhausted.');
    await writeFile(claimPath, `${JSON.stringify({ ...claim, ticket })}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await unlink(choosingPath).catch(() => undefined);
    throw error;
  }
  await unlink(choosingPath);

  const deadline = Date.now() + deadlineMs;
  try {
    while (Date.now() < deadline) {
      if (!(await legacyLockBlocks(lockPath))) {
        const snapshot = await inspectActiveClaims(claimsRoot);
        if (!snapshot.choosing && snapshot.owner === claim.token) return new LeaseLockHandle(claim.token, claimPath);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`Timed out waiting for lease lock: ${lockPath}`);
  } catch (error) {
    await unlink(choosingPath).catch(() => undefined);
    await unlink(claimPath).catch(() => undefined);
    throw error;
  }
}
