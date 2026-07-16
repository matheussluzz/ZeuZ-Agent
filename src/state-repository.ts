import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { redactSecrets } from './redact.js';
import {
  UnsafeStateRootError,
  assertPrivateStateFile,
  assertStateRecordId,
  ensurePrivateStateDirectory,
  ensureStateContainerDirectory,
  readPrivateStateFile,
  writePrivateStateFileAtomic,
  writePrivateStateFileCreate,
} from './state-policy.js';

export interface VersionedStateRecord {
  schemaVersion: number;
  revision: number;
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationManifest {
  schemaVersion: 1;
  id: string;
  collection: string;
  sourceVersion: 0;
  targetVersion: number;
  sourceSha256: string;
  backup: string;
  createdAt: string;
}

export interface StateRepositoryRuntime {
  now(): string;
  nowMs(): number;
  newId(): string;
}

export interface StateDiagnostic {
  record: string;
  code: string;
  quarantined: boolean;
}

export interface StateListResult<T> {
  records: T[];
  diagnostics: StateDiagnostic[];
}

export interface StateRepositoryOptions<T extends VersionedStateRecord> {
  root: string;
  collection: string;
  runtime: StateRepositoryRuntime;
  validate(value: unknown): asserts value is T;
  importLegacy?(value: unknown): T;
  writeCreate?(target: string, content: string): Promise<void>;
  writeReplace?(target: string, content: string): Promise<void>;
  maxRecordBytes?: number;
  maxRootBytes?: number;
  lockLeaseMs?: number;
  hostId?: string;
  ownerProbe?(hostId: string, pid: number): 'alive' | 'dead' | 'potentially_alive' | 'unknown';
}

export class StateRepositoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StateRepositoryError';
    this.code = code;
  }
}

const DEFAULT_MAX_RECORD_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ROOT_BYTES = 512 * 1024 * 1024;
const QUARANTINE_CODES = new Set(['STATE_JSON_INVALID', 'STATE_SCHEMA_MISMATCH', 'STATE_ID_MISMATCH', 'LEGACY_STATE_INVALID']);

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'STATE_SCHEMA_MISMATCH';
}

function defaultOwnerProbe(hostId: string, pid: number): 'alive' | 'dead' | 'potentially_alive' | 'unknown' {
  if (hostId !== hostname()) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'dead';
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return 'potentially_alive';
    return 'unknown';
  }
}

export function assertMigrationManifest(value: unknown): asserts value is MigrationManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StateRepositoryError('STATE_SCHEMA_MISMATCH', 'Migration manifest is invalid.');
  const manifest = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'id', 'collection', 'sourceVersion', 'targetVersion', 'sourceSha256', 'backup', 'createdAt']);
  if (Object.keys(manifest).some((key) => !allowed.has(key)) || manifest.schemaVersion !== 1 || manifest.sourceVersion !== 0 || !Number.isSafeInteger(manifest.targetVersion) || typeof manifest.id !== 'string' || typeof manifest.collection !== 'string' || !/^[a-f0-9]{64}$/.test(String(manifest.sourceSha256)) || typeof manifest.backup !== 'string' || !/^[a-zA-Z0-9._-]+\.v0\.json$/.test(manifest.backup) || !Number.isFinite(Date.parse(String(manifest.createdAt)))) {
    throw new StateRepositoryError('STATE_SCHEMA_MISMATCH', 'Migration manifest is invalid.');
  }
}

export class StateRepository<T extends VersionedStateRecord> {
  private root?: string;
  private collectionDir?: string;
  private locksDir?: string;
  private backupsDir?: string;
  private quarantineDir?: string;
  private readonly options: StateRepositoryOptions<T>;
  private readonly lockLeaseMs: number;

  constructor(options: StateRepositoryOptions<T>) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.collection)) throw new StateRepositoryError('INVALID_STATE_COLLECTION', 'State collection name is invalid.');
    this.options = options;
    this.lockLeaseMs = options.lockLeaseMs ?? 120_000;
    if (!Number.isSafeInteger(this.lockLeaseMs) || this.lockLeaseMs < 1_000 || this.lockLeaseMs > 1_800_000) throw new StateRepositoryError('INVALID_LOCK_POLICY', 'State lock lease is invalid.');
  }

  async initialize(): Promise<void> {
    if (this.root) return;
    this.root = await ensureStateContainerDirectory(this.options.root);
    this.collectionDir = await ensurePrivateStateDirectory(join(this.root, this.options.collection), this.root);
    this.locksDir = await ensurePrivateStateDirectory(join(this.root, 'locks', this.options.collection), this.root);
    this.backupsDir = await ensurePrivateStateDirectory(join(this.root, 'backups', this.options.collection), this.root);
    this.quarantineDir = await ensurePrivateStateDirectory(join(this.root, 'quarantine', this.options.collection), this.root);
  }

  async create(record: T): Promise<T> {
    await this.initialize();
    this.options.validate(record);
    if (record.revision !== 0) throw new StateRepositoryError('INVALID_STATE_REVISION', 'New records must start at revision zero.');
    const content = this.serialize(record);
    await this.assertQuota(Buffer.byteLength(content));
    try {
      await (this.options.writeCreate ?? writePrivateStateFileCreate)(this.pathFor(record.id), content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StateRepositoryError('STATE_ID_COLLISION', 'State record already exists.');
      throw error;
    }
    return structuredClone(record);
  }

  async replace(record: T, expectedRevision: number): Promise<T> {
    await this.initialize();
    assertStateRecordId(record.id);
    for (let attempt = 0; attempt < 256; attempt += 1) {
      try {
        return await this.withLock(record.id, async () => {
          const current = await this.readCurrent(record.id);
          if (current.revision !== expectedRevision) throw new StateRepositoryError('STALE_STATE_REVISION', 'State revision is stale.');
          const next = { ...structuredClone(record), revision: expectedRevision + 1, updatedAt: this.options.runtime.now() } as T;
          this.options.validate(next);
          const content = this.serialize(next);
          await this.assertQuota(Math.max(0, Buffer.byteLength(content) - Buffer.byteLength(this.serialize(current))));
          await (this.options.writeReplace ?? writePrivateStateFileAtomic)(this.pathFor(record.id), content);
          return next;
        });
      } catch (error) {
        if (!(error instanceof StateRepositoryError && error.code === 'STATE_RECORD_LOCKED')) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
    }
    throw new StateRepositoryError('STATE_RECORD_LOCKED', 'State record remained locked after bounded contention retries.');
  }

  async load(id: string): Promise<T> {
    await this.initialize();
    return await this.readCurrent(id);
  }

  async listDetailed(options: { migrateLegacy?: boolean } = {}): Promise<StateListResult<T>> {
    await this.initialize();
    const records: T[] = [];
    const diagnostics: StateDiagnostic[] = [];
    const files = (await readdir(this.collection())).filter((file) => file.endsWith('.json')).sort();
    for (const file of files) {
      const id = file.slice(0, -5);
      try {
        const content = await readPrivateStateFile(join(this.collection(), file), this.collection(), this.maxRecordBytes());
        let value: unknown;
        try { value = JSON.parse(content) as unknown; }
        catch { throw new StateRepositoryError('STATE_JSON_INVALID', 'State record is not valid JSON.'); }
        try {
          this.options.validate(value);
          if (value.id !== id) throw new StateRepositoryError('STATE_ID_MISMATCH', 'State record ID does not match its filename.');
          records.push(value);
          continue;
        } catch (error) {
          if (errorCode(error) === 'UNSUPPORTED_STATE_VERSION') {
            diagnostics.push({ record: file, code: 'UNSUPPORTED_STATE_VERSION', quarantined: false });
            continue;
          }
          if (this.isLegacy(value) && this.options.importLegacy && options.migrateLegacy) {
            const migrated = await this.migrateLegacy(id, value, content);
            if (migrated.id !== id) throw new StateRepositoryError('STATE_ID_MISMATCH', 'Migrated state ID does not match its filename.');
            records.push(migrated);
            diagnostics.push({ record: file, code: 'LEGACY_STATE_MIGRATED', quarantined: false });
            continue;
          }
          if (this.isLegacy(value) && this.options.importLegacy) {
            const imported = this.options.importLegacy(value);
            if (imported.id !== id) throw new StateRepositoryError('STATE_ID_MISMATCH', 'Legacy state ID does not match its filename.');
            records.push(imported);
            diagnostics.push({ record: file, code: 'LEGACY_STATE_READ_ONLY', quarantined: false });
            continue;
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof UnsafeStateRootError) throw error;
        const code = errorCode(error);
        if (code === 'UNSUPPORTED_STATE_VERSION') {
          diagnostics.push({ record: file, code, quarantined: false });
          continue;
        }
        if (!QUARANTINE_CODES.has(code)) throw error;
        await this.quarantine(file, code);
        diagnostics.push({ record: file, code, quarantined: true });
      }
    }
    return { records, diagnostics };
  }

  async migrateAll(): Promise<StateListResult<T>> {
    return await this.listDetailed({ migrateLegacy: true });
  }

  async recoverTemporaryFiles(): Promise<number> {
    await this.initialize();
    let removed = 0;
    for (const file of await readdir(this.collection())) {
      if (!file.endsWith('.tmp')) continue;
      const path = join(this.collection(), file);
      await assertPrivateStateFile(path, this.collection());
      await rm(path);
      removed += 1;
    }
    return removed;
  }

  async withExclusiveRecord<R>(id: string, action: (current: T) => Promise<R>): Promise<R> {
    await this.initialize();
    assertStateRecordId(id);
    for (let attempt = 0; attempt < 256; attempt += 1) {
      try { return await this.withLock(id, async () => await action(await this.readCurrent(id))); }
      catch (error) {
        if (!(error instanceof StateRepositoryError && error.code === 'STATE_RECORD_LOCKED')) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
    }
    throw new StateRepositoryError('STATE_RECORD_LOCKED', 'State record remained locked after bounded contention retries.');
  }

  private async migrateLegacy(id: string, value: unknown, original: string): Promise<T> {
    const importer = this.options.importLegacy;
    if (!importer) throw new StateRepositoryError('LEGACY_IMPORT_UNAVAILABLE', 'Legacy importer is unavailable.');
    for (let attempt = 0; attempt < 256; attempt += 1) {
      try {
        return await this.withLock(id, async () => {
          const currentText = await readPrivateStateFile(this.pathFor(id), this.collection(), this.maxRecordBytes());
          if (currentText !== original) {
            try {
              const current = JSON.parse(currentText) as unknown;
              this.options.validate(current);
              return current;
            } catch {
              throw new StateRepositoryError('STALE_STATE_REVISION', 'Legacy state changed during migration.');
            }
          }
          const imported = importer(value);
          this.options.validate(imported);
          const hash = createHash('sha256').update(original).digest('hex');
          const backupName = `${id}.${hash}.v0.json`;
          const backupPath = join(this.backups(), backupName);
          try {
            await writePrivateStateFileCreate(backupPath, original);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            await assertPrivateStateFile(backupPath, this.backups());
            if (await readFile(backupPath, 'utf8') !== original) throw new StateRepositoryError('BACKUP_COLLISION', 'Legacy backup collision is inconsistent.');
          }
          const manifest: MigrationManifest = {
            schemaVersion: 1,
            id,
            collection: this.options.collection,
            sourceVersion: 0,
            targetVersion: imported.schemaVersion,
            sourceSha256: hash,
            backup: backupName,
            createdAt: this.options.runtime.now(),
          };
          assertMigrationManifest(manifest);
          await writePrivateStateFileCreate(join(this.backups(), `${id}.${hash}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
          await (this.options.writeReplace ?? writePrivateStateFileAtomic)(this.pathFor(id), this.serialize(imported));
          return imported;
        });
      } catch (error) {
        if (!(error instanceof StateRepositoryError && error.code === 'STATE_RECORD_LOCKED')) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
    }
    throw new StateRepositoryError('STATE_RECORD_LOCKED', 'Migration lock remained contended.');
  }

  private async quarantine(file: string, code: string): Promise<void> {
    const safeCode = /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'STATE_SCHEMA_MISMATCH';
    const token = this.options.runtime.newId().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
    const destination = `${basename(file, '.json')}.${token}.json`;
    await rename(join(this.collection(), file), join(this.quarantineRoot(), destination));
    const metadata = {
      schemaVersion: 1,
      record: file,
      reasonCode: safeCode,
      quarantinedAt: this.options.runtime.now(),
    };
    await writePrivateStateFileCreate(join(this.quarantineRoot(), `${destination}.meta.json`), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  private async readCurrent(id: string): Promise<T> {
    assertStateRecordId(id);
    const content = await readPrivateStateFile(this.pathFor(id), this.collection(), this.maxRecordBytes());
    let value: unknown;
    try { value = JSON.parse(content); } catch { throw new StateRepositoryError('STATE_JSON_INVALID', 'State record is not valid JSON.'); }
    this.options.validate(value);
    if (value.id !== id) throw new StateRepositoryError('STATE_ID_MISMATCH', 'State record ID does not match its filename.');
    return structuredClone(value);
  }

  private async withLock<R>(id: string, action: () => Promise<R>): Promise<R> {
    assertStateRecordId(id);
    const lockPath = join(this.locks(), `${id}.lock`);
    const ownerId = randomUUID();
    let handle;
    try {
      handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, id, ownerId, ownerPid: process.pid, hostId: this.options.hostId ?? hostname(), claimedAt: this.options.runtime.now(), expiresAt: new Date(this.options.runtime.nowMs() + this.lockLeaseMs).toISOString() })}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        await this.recoverExpiredLock(lockPath, id);
        throw new StateRepositoryError('STATE_RECORD_LOCKED', 'State record is locked for mutation.');
      }
      throw error;
    }
    try {
      return await action();
    } finally {
      await rm(lockPath, { force: true });
    }
  }

  private async recoverExpiredLock(lockPath: string, id: string): Promise<void> {
    let lock: Record<string, unknown>;
    try { lock = JSON.parse(await readPrivateStateFile(lockPath, this.locks(), 4_096)) as Record<string, unknown>; }
    catch { return; }
    if (lock.schemaVersion !== 1 || lock.id !== id || typeof lock.ownerId !== 'string' || !Number.isSafeInteger(lock.ownerPid) || typeof lock.hostId !== 'string' || !Number.isFinite(Date.parse(String(lock.expiresAt)))) return;
    if (Date.parse(String(lock.expiresAt)) > this.options.runtime.nowMs()) return;
    const probe = this.options.ownerProbe ?? defaultOwnerProbe;
    if (probe(String(lock.hostId), Number(lock.ownerPid)) !== 'dead') return;
    const reclaimed = `${lockPath}.${randomUUID()}.reclaimed`;
    try { await rename(lockPath, reclaimed); await rm(reclaimed, { force: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  private serialize(record: T): string {
    const content = `${redactSecrets(JSON.stringify(record, null, 2))}\n`;
    if (Buffer.byteLength(content) > this.maxRecordBytes()) throw new StateRepositoryError('STATE_QUOTA_EXCEEDED', 'State record exceeds its byte budget.');
    return content;
  }

  private isLegacy(value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'schemaVersion'));
  }

  private async assertQuota(additionalBytes: number): Promise<void> {
    const size = await directoryBytes(this.rootPath());
    if (size + additionalBytes > (this.options.maxRootBytes ?? DEFAULT_MAX_ROOT_BYTES)) throw new StateRepositoryError('STATE_QUOTA_EXCEEDED', 'State root exceeds its byte budget.');
  }

  private pathFor(id: string): string {
    assertStateRecordId(id);
    return join(this.collection(), `${id}.json`);
  }

  private maxRecordBytes(): number { return this.options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES; }
  private rootPath(): string { if (!this.root) throw new StateRepositoryError('STATE_NOT_INITIALIZED', 'State repository is not initialized.'); return this.root; }
  private collection(): string { if (!this.collectionDir) throw new StateRepositoryError('STATE_NOT_INITIALIZED', 'State repository is not initialized.'); return this.collectionDir; }
  private locks(): string { if (!this.locksDir) throw new StateRepositoryError('STATE_NOT_INITIALIZED', 'State repository is not initialized.'); return this.locksDir; }
  private backups(): string { if (!this.backupsDir) throw new StateRepositoryError('STATE_NOT_INITIALIZED', 'State repository is not initialized.'); return this.backupsDir; }
  private quarantineRoot(): string { if (!this.quarantineDir) throw new StateRepositoryError('STATE_NOT_INITIALIZED', 'State repository is not initialized.'); return this.quarantineDir; }
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === 'worktrees') continue;
      const path = resolve(directory, entry.name);
      const relation = relative(root, path);
      if (relation.startsWith('..') || isAbsolute(relation)) throw new UnsafeStateRootError('State quota traversal escaped its root.');
      let metadata;
      try { metadata = await lstat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (metadata.isSymbolicLink()) throw new UnsafeStateRootError('State quota traversal found a symlink.');
      if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile()) total += metadata.size;
      else throw new UnsafeStateRootError('State quota traversal found an unsupported entry.');
    }
  };
  await walk(root);
  return total;
}
