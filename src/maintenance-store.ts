import { resolve } from 'node:path';

import { systemRuntime, type RuntimeSeams } from './runtime.js';
import { StateRepository, StateRepositoryError, type VersionedStateRecord } from './state-repository.js';

export interface MaintenanceRecord extends VersionedStateRecord {
  schemaVersion: 1;
  epoch: number;
  active: boolean;
  reasonCode?: string;
}

export class MaintenanceStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'MaintenanceStoreError'; this.code = code; }
}

function validateMaintenance(value: unknown): asserts value is MaintenanceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MaintenanceStoreError('STATE_SCHEMA_MISMATCH', 'Maintenance state is invalid.');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'revision', 'id', 'epoch', 'active', 'reasonCode', 'createdAt', 'updatedAt']);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new MaintenanceStoreError('STATE_SCHEMA_MISMATCH', 'Maintenance state contains unknown fields.');
  if (typeof record.schemaVersion === 'number' && record.schemaVersion > 1) throw new MaintenanceStoreError('UNSUPPORTED_STATE_VERSION', 'Maintenance state version is unsupported.');
  if (record.schemaVersion !== 1 || record.id !== 'root' || !Number.isSafeInteger(record.revision) || !Number.isSafeInteger(record.epoch) || typeof record.active !== 'boolean' || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
    throw new MaintenanceStoreError('STATE_SCHEMA_MISMATCH', 'Maintenance state is invalid.');
  }
  if (!Number.isFinite(Date.parse(record.createdAt as string)) || !Number.isFinite(Date.parse(record.updatedAt as string))) throw new MaintenanceStoreError('STATE_SCHEMA_MISMATCH', 'Maintenance timestamps are invalid.');
  if (record.reasonCode !== undefined && (typeof record.reasonCode !== 'string' || !/^[a-z0-9_]{1,64}$/.test(record.reasonCode))) throw new MaintenanceStoreError('STATE_SCHEMA_MISMATCH', 'Maintenance reason code is invalid.');
}

export class MaintenanceStore {
  private readonly repository: StateRepository<MaintenanceRecord>;
  private readonly runtime: RuntimeSeams;

  constructor(root: string, runtime: RuntimeSeams = systemRuntime) {
    this.runtime = runtime;
    this.repository = new StateRepository({ root: resolve(root), collection: 'maintenance', runtime, validate: validateMaintenance, maxRecordBytes: 16_384 });
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
    const now = this.runtime.now();
    try { await this.repository.create({ schemaVersion: 1, revision: 0, id: 'root', epoch: 0, active: false, createdAt: now, updatedAt: now }); }
    catch (error) { if (!(error instanceof StateRepositoryError && error.code === 'STATE_ID_COLLISION')) throw error; }
  }

  async current(): Promise<MaintenanceRecord> { await this.initialize(); return await this.repository.load('root'); }

  async withStableEpoch<R>(expectedEpoch: number | undefined, action: (maintenance: MaintenanceRecord) => Promise<R>): Promise<R> {
    await this.initialize();
    return await this.repository.withExclusiveRecord('root', async (maintenance) => {
      if (maintenance.active) throw new MaintenanceStoreError('MAINTENANCE_ACTIVE', 'State writes are paused for maintenance.');
      if (expectedEpoch !== undefined && maintenance.epoch !== expectedEpoch) throw new MaintenanceStoreError('STALE_MAINTENANCE_EPOCH', 'State write uses a stale root maintenance epoch.');
      return await action(maintenance);
    });
  }

  async enter(reasonCode: string): Promise<MaintenanceRecord> {
    const current = await this.current();
    if (current.active) throw new MaintenanceStoreError('MAINTENANCE_ACTIVE', 'Maintenance is already active.');
    return await this.repository.replace({ ...current, active: true, epoch: current.epoch + 1, reasonCode }, current.revision);
  }

  async exit(): Promise<MaintenanceRecord> {
    const current = await this.current();
    if (!current.active) return current;
    return await this.repository.replace({ ...current, active: false }, current.revision);
  }

  async abortEnter(enteredRevision: number, previousEpoch: number): Promise<MaintenanceRecord> {
    const current = await this.current();
    if (!current.active || current.revision !== enteredRevision || current.epoch !== previousEpoch + 1) throw new MaintenanceStoreError('STALE_MAINTENANCE_EPOCH', 'Maintenance entry can no longer be rolled back safely.');
    const { reasonCode: _reasonCode, ...withoutReason } = current;
    return await this.repository.replace({ ...withoutReason, active: false, epoch: previousEpoch }, current.revision);
  }
}
