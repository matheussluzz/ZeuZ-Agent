import { resolve } from 'node:path';

import type { RuntimeSeams } from './runtime.js';
import { StateRepository, StateRepositoryError, type VersionedStateRecord } from './state-repository.js';
import type { OwnerProbeState } from './task-policy.js';

interface WorkspaceLockRecord extends VersionedStateRecord {
  schemaVersion: 1;
  active: boolean;
  workspace: string;
  taskId: string;
  ownerId: string;
  ownerPid: number;
  hostId: string;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface WorkspaceLockOwner { ownerId: string; ownerPid: number; hostId: string }
export type WorkspaceLockAcquireResult =
  | { status: 'acquired'; handle: WorkspaceLockHandle }
  | { status: 'locked' }
  | { status: 'ambiguous' };

export class WorkspaceLockError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'WorkspaceLockError'; this.code = code; }
}

function timestamp(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function validate(value: unknown): asserts value is WorkspaceLockRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceLockError('STATE_SCHEMA_MISMATCH', 'Workspace lock state is invalid.');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'revision', 'id', 'active', 'workspace', 'taskId', 'ownerId', 'ownerPid', 'hostId', 'claimedAt', 'heartbeatAt', 'expiresAt', 'createdAt', 'updatedAt']);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new WorkspaceLockError('STATE_SCHEMA_MISMATCH', 'Workspace lock state contains unknown fields.');
  if (typeof record.schemaVersion === 'number' && record.schemaVersion > 1) throw new WorkspaceLockError('UNSUPPORTED_STATE_VERSION', 'Workspace lock state version is unsupported.');
  if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || !/^[a-f0-9]{64}$/.test(String(record.id)) || typeof record.active !== 'boolean'
    || typeof record.workspace !== 'string' || record.workspace.length === 0 || record.workspace.length > 8_192 || resolve(record.workspace) !== record.workspace
    || typeof record.taskId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(record.taskId)
    || typeof record.ownerId !== 'string' || record.ownerId.length === 0 || record.ownerId.length > 200
    || !Number.isSafeInteger(record.ownerPid) || Number(record.ownerPid) < 1 || typeof record.hostId !== 'string' || record.hostId.length === 0 || record.hostId.length > 1_000
    || !timestamp(record.claimedAt) || !timestamp(record.heartbeatAt) || !timestamp(record.expiresAt) || !timestamp(record.createdAt) || !timestamp(record.updatedAt)) {
    throw new WorkspaceLockError('STATE_SCHEMA_MISMATCH', 'Workspace lock state is invalid.');
  }
  if (Date.parse(String(record.heartbeatAt)) < Date.parse(String(record.claimedAt)) || Date.parse(String(record.expiresAt)) <= Date.parse(String(record.heartbeatAt))) throw new WorkspaceLockError('STATE_SCHEMA_MISMATCH', 'Workspace lock timestamps are invalid.');
}

export class WorkspaceLockHandle {
  constructor(
    private readonly store: WorkspaceLockStore,
    readonly id: string,
    private readonly taskId: string,
    private readonly ownerId: string,
  ) {}

  async heartbeat(leaseMs: number): Promise<void> { await this.store.heartbeat(this.id, this.taskId, this.ownerId, leaseMs); }
  async release(): Promise<void> { await this.store.release(this.id, this.taskId, this.ownerId); }
}

export class WorkspaceLockStore {
  private readonly repository: StateRepository<WorkspaceLockRecord>;

  constructor(
    root: string,
    private readonly runtime: RuntimeSeams,
    private readonly probe: (hostId: string, pid: number) => OwnerProbeState,
  ) {
    this.repository = new StateRepository({ root: resolve(root), collection: 'workspace-locks', runtime, validate, maxRecordBytes: 16_384 });
  }

  async acquire(id: string, workspace: string, taskId: string, owner: WorkspaceLockOwner, leaseMs: number): Promise<WorkspaceLockAcquireResult> {
    this.assertLease(leaseMs);
    await this.repository.initialize();
    const canonical = resolve(workspace);
    const now = this.runtime.now();
    const candidate = (revision: number, createdAt: string): WorkspaceLockRecord => ({
      schemaVersion: 1,
      revision,
      id,
      active: true,
      workspace: canonical,
      taskId,
      ownerId: owner.ownerId,
      ownerPid: owner.ownerPid,
      hostId: owner.hostId,
      claimedAt: now,
      heartbeatAt: now,
      expiresAt: new Date(this.runtime.nowMs() + leaseMs).toISOString(),
      createdAt,
      updatedAt: now,
    });
    try {
      await this.repository.create(candidate(0, now));
      return { status: 'acquired', handle: new WorkspaceLockHandle(this, id, taskId, owner.ownerId) };
    } catch (error) {
      if (!(error instanceof StateRepositoryError && error.code === 'STATE_ID_COLLISION')) throw error;
    }
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.repository.load(id);
      if (current.workspace !== canonical) throw new WorkspaceLockError('WORKSPACE_LOCK_ID_COLLISION', 'Workspace lock identity does not match its canonical path.');
      if (current.active && current.taskId === taskId && current.ownerId === owner.ownerId) return { status: 'acquired', handle: new WorkspaceLockHandle(this, id, taskId, owner.ownerId) };
      if (current.active && Date.parse(current.expiresAt) > this.runtime.nowMs()) return { status: 'locked' };
      if (current.active) {
        const state = this.probe(current.hostId, current.ownerPid);
        if (state === 'unknown') return { status: 'ambiguous' };
        if (state !== 'dead') return { status: 'locked' };
      }
      try {
        await this.repository.replace(candidate(current.revision, current.createdAt), current.revision);
        return { status: 'acquired', handle: new WorkspaceLockHandle(this, id, taskId, owner.ownerId) };
      } catch (error) {
        if (!(error instanceof StateRepositoryError && ['STALE_STATE_REVISION', 'STATE_RECORD_LOCKED'].includes(error.code))) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      }
    }
    throw new WorkspaceLockError('WORKSPACE_LOCK_CONTENTION', 'Workspace lock claim did not settle after bounded retries.');
  }

  async heartbeat(id: string, taskId: string, ownerId: string, leaseMs: number): Promise<void> {
    this.assertLease(leaseMs);
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.repository.load(id);
      if (!current.active || current.taskId !== taskId || current.ownerId !== ownerId) throw new WorkspaceLockError('STALE_WORKSPACE_LOCK_OWNER', 'Workspace lock owner is stale.');
      const now = this.runtime.now();
      try { await this.repository.replace({ ...current, heartbeatAt: now, expiresAt: new Date(this.runtime.nowMs() + leaseMs).toISOString() }, current.revision); return; }
      catch (error) {
        if (!(error instanceof StateRepositoryError && ['STALE_STATE_REVISION', 'STATE_RECORD_LOCKED'].includes(error.code))) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      }
    }
    throw new WorkspaceLockError('WORKSPACE_LOCK_CONTENTION', 'Workspace lock heartbeat did not settle.');
  }

  async release(id: string, taskId: string, ownerId: string): Promise<void> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.repository.load(id);
      if (!current.active || current.taskId !== taskId || current.ownerId !== ownerId) return;
      try { await this.repository.replace({ ...current, active: false }, current.revision); return; }
      catch (error) {
        if (!(error instanceof StateRepositoryError && ['STALE_STATE_REVISION', 'STATE_RECORD_LOCKED'].includes(error.code))) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      }
    }
    throw new WorkspaceLockError('WORKSPACE_LOCK_CONTENTION', 'Workspace lock release did not settle.');
  }

  private assertLease(leaseMs: number): void {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 1_800_000) throw new WorkspaceLockError('INVALID_WORKSPACE_LOCK_POLICY', 'Workspace lock lease is invalid.');
  }
}
