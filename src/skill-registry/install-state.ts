import { readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';

import { SkillRegistryError } from './errors.js';
import { acquireLeaseLock, type LeaseLockHandle } from './lease-lock.js';
import { mkdirSecureCatalogState, secureCatalogStatePath } from './state-security.js';
import type { CatalogIndex, CatalogSkillRecord, EnablementState, TrustState } from './types.js';

export interface InstallRecord {
  skillId: string;
  revision: string;
  installedAt: string;
  trust: TrustState;
  enablement: EnablementState;
}

export interface InstallStateFile {
  schemaVersion: 1;
  revision: number;
  installs: Record<string, InstallRecord>;
}

const EMPTY_STATE: InstallStateFile = { schemaVersion: 1, revision: 0, installs: {} };
const LOCK_LEASE_MS = 30_000;
const TRUST_STATES = new Set<TrustState>(['quarantined', 'invalid', 'validated', 'disabled', 'enabled']);
const ENABLEMENT_STATES = new Set<EnablementState>(['disabled', 'enabled']);

function parseInstallState(raw: string): InstallStateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillRegistryError('INSTALL_STATE_CORRUPT', 'Install state JSON is malformed.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SkillRegistryError('INSTALL_STATE_CORRUPT', 'Install state must be an object.');
  }
  const candidate = parsed as Partial<InstallStateFile>;
  if (candidate.schemaVersion !== 1) {
    throw new SkillRegistryError('INSTALL_STATE_CORRUPT', 'Install state schemaVersion must be 1.');
  }
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision! < 0) {
    throw new SkillRegistryError('INSTALL_STATE_CORRUPT', 'Install state revision must be a non-negative safe integer.');
  }
  if (!candidate.installs || typeof candidate.installs !== 'object' || Array.isArray(candidate.installs)) {
    throw new SkillRegistryError('INSTALL_STATE_CORRUPT', 'Install state installs map is missing.');
  }
  for (const [skillId, record] of Object.entries(candidate.installs)) {
    if (!record || typeof record !== 'object') {
      throw new SkillRegistryError('INSTALL_STATE_CORRUPT', `Install record ${skillId} is invalid.`);
    }
    const install = record as Partial<InstallRecord>;
    if (
      install.skillId !== skillId
      || typeof install.revision !== 'string'
      || install.revision.length === 0
      || typeof install.installedAt !== 'string'
      || !Number.isFinite(Date.parse(install.installedAt))
      || !TRUST_STATES.has(install.trust as TrustState)
      || !ENABLEMENT_STATES.has(install.enablement as EnablementState)
    ) {
      throw new SkillRegistryError('INSTALL_STATE_CORRUPT', `Install record ${skillId} has invalid fields.`);
    }
  }
  return {
    schemaVersion: 1,
    revision: candidate.revision!,
    installs: candidate.installs as Record<string, InstallRecord>,
  };
}

export async function readInstallState(root: string): Promise<InstallStateFile> {
  try {
    const path = await secureCatalogStatePath(root, 'installs.json');
    return parseInstallState(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SkillRegistryError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ...EMPTY_STATE, installs: {} };
    throw new SkillRegistryError('INSTALL_STATE_CORRUPT', `Install state is unreadable (${code ?? 'unknown'}).`);
  }
}

async function writeInstallState(root: string, state: InstallStateFile): Promise<void> {
  await mkdirSecureCatalogState(root);
  const path = await secureCatalogStatePath(root, 'installs.json');
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

async function withInstallLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await mkdirSecureCatalogState(root);
  const lockPath = await secureCatalogStatePath(root, 'installs.lock');
  let handle: LeaseLockHandle | undefined;
  try {
    try {
      handle = await acquireLeaseLock(lockPath, LOCK_LEASE_MS);
    } catch (error) {
      if (error instanceof SkillRegistryError) throw error;
      if (error instanceof Error && error.message.includes('Timed out waiting for lease lock')) {
        throw new SkillRegistryError('INSTALL_LOCK_TIMEOUT', 'Timed out waiting for install-state lock.');
      }
      throw error;
    }
    return await operation();
  } finally {
    if (handle) await handle.release();
  }
}

export async function mutateInstallState(
  root: string,
  mutator: (state: InstallStateFile) => InstallStateFile | Promise<InstallStateFile>,
): Promise<InstallStateFile> {
  return withInstallLock(root, async () => {
    const current = await readInstallState(root);
    const next = await mutator(current);
    if (next === current) return current;
    const persisted: InstallStateFile = {
      schemaVersion: 1,
      revision: current.revision + 1,
      installs: next.installs,
    };
    await writeInstallState(root, persisted);
    return persisted;
  });
}

export function applyInstallOverlay(index: CatalogIndex, state: InstallStateFile): CatalogIndex {
  return {
    ...index,
    skills: index.skills.map((skill) => overlaySkillInstallState(skill, state.installs[skill.id])),
  };
}

export function overlaySkillInstallState(skill: CatalogSkillRecord, install?: InstallRecord): CatalogSkillRecord {
  if (!install) {
    if (skill.source.kind === 'bundle') {
      return { ...skill, zeuz: { ...skill.zeuz, enablement: 'disabled' } };
    }
    return skill;
  }
  if (install.revision !== skill.source.revision) {
    if (skill.source.kind === 'bundle') {
      return { ...skill, zeuz: { ...skill.zeuz, enablement: 'disabled' } };
    }
    return skill;
  }
  if (skill.zeuz.trust === 'invalid' || skill.zeuz.trust === 'quarantined') {
    return { ...skill, zeuz: { ...skill.zeuz, enablement: 'disabled' } };
  }
  const enablement: EnablementState = install.enablement === 'enabled' && skill.zeuz.trust === 'enabled'
    ? 'enabled'
    : 'disabled';
  return { ...skill, zeuz: { ...skill.zeuz, enablement } };
}

export async function resetInstallState(root: string): Promise<void> {
  await mkdirSecureCatalogState(root);
  const lockPath = await secureCatalogStatePath(root, 'installs.lock');
  await withInstallLock(root, async () => {
    await unlink(await secureCatalogStatePath(root, 'installs.json')).catch(() => undefined);
    // Queue files were written by the pre-claim-directory implementation. Once
    // this owner holds the lock, no current implementation reads or appends it.
    await unlink(`${lockPath}.claims/queue`).catch(() => undefined);
  });
  // Remove the now-empty claim directory only when no successor has claimed it.
  // ENOTEMPTY is an expected concurrent-successor outcome and must not delete
  // that successor's immutable ownership record.
  await rmdir(`${lockPath}.claims`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
  });
  await unlink(lockPath).catch(() => undefined);
}
