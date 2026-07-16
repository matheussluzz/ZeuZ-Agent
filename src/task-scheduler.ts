import { hostname } from 'node:os';
import { resolve } from 'node:path';

import { StateRepository, StateRepositoryError, type VersionedStateRecord } from './state-repository.js';
import type { OwnerProbeState } from './task-policy.js';

interface SchedulerSlot {
  taskId: string;
  ownerId: string;
  ownerPid: number;
  hostId: string;
  expiresAt: string;
}

interface SchedulerRecord extends VersionedStateRecord {
  schemaVersion: 1;
  slots: SchedulerSlot[];
}

export interface SchedulerRuntime { now(): string; nowMs(): number; newId(): string }
export interface SchedulerIdentity { ownerPid: number; hostId: string }
export interface SchedulerRecovery { released: string[]; ambiguous: string[] }

export class TaskSchedulerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'TaskSchedulerError'; this.code = code; }
}

function validate(value: unknown): asserts value is SchedulerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskSchedulerError('STATE_SCHEMA_MISMATCH', 'Scheduler state is invalid.');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'revision', 'id', 'slots', 'createdAt', 'updatedAt']);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new TaskSchedulerError('STATE_SCHEMA_MISMATCH', 'Scheduler state contains unknown fields.');
  if (typeof record.schemaVersion === 'number' && record.schemaVersion > 1) throw new TaskSchedulerError('UNSUPPORTED_STATE_VERSION', 'Scheduler state version is unsupported.');
  if (record.schemaVersion !== 1 || record.id !== 'global' || !Number.isSafeInteger(record.revision) || !Array.isArray(record.slots) || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
    throw new TaskSchedulerError('STATE_SCHEMA_MISMATCH', 'Scheduler state is invalid.');
  }
  if (record.slots.length > 3) throw new TaskSchedulerError('STATE_SCHEMA_MISMATCH', 'Scheduler exceeds the global worker limit.');
  const taskIds = new Set<string>();
  for (const slot of record.slots) {
    if (!slot || typeof slot !== 'object' || typeof slot.taskId !== 'string' || typeof slot.ownerId !== 'string' || !Number.isSafeInteger(slot.ownerPid) || typeof slot.hostId !== 'string' || !Number.isFinite(Date.parse(String(slot.expiresAt)))) {
      throw new TaskSchedulerError('STATE_SCHEMA_MISMATCH', 'Scheduler slot is invalid.');
    }
    if (Object.keys(slot).some((key) => !['taskId', 'ownerId', 'ownerPid', 'hostId', 'expiresAt'].includes(key))) throw new TaskSchedulerError('STATE_SCHEMA_MISMATCH', 'Scheduler slot contains unknown fields.');
    if (taskIds.has(slot.taskId)) throw new TaskSchedulerError('STATE_SCHEMA_MISMATCH', 'Scheduler contains a duplicate task slot.');
    taskIds.add(slot.taskId);
  }
}

export class TaskScheduler {
  private readonly repository: StateRepository<SchedulerRecord>;
  private readonly runtime: SchedulerRuntime;
  private readonly maxWorkers: number;
  private readonly identity: () => SchedulerIdentity;

  constructor(root: string, runtime: SchedulerRuntime, maxWorkers = 3, identity: () => SchedulerIdentity = () => ({ ownerPid: process.pid, hostId: hostname() })) {
    if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 3) throw new TaskSchedulerError('INVALID_SCHEDULER_POLICY', 'Scheduler worker limit is invalid.');
    this.runtime = runtime;
    this.maxWorkers = maxWorkers;
    this.identity = identity;
    this.repository = new StateRepository({ root: resolve(root), collection: 'scheduler', runtime, validate, maxRecordBytes: 64 * 1024 });
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
    const now = this.runtime.now();
    try { await this.repository.create({ schemaVersion: 1, revision: 0, id: 'global', slots: [], createdAt: now, updatedAt: now }); }
    catch (error) { if (!(error instanceof StateRepositoryError && error.code === 'STATE_ID_COLLISION')) throw error; }
  }

  async acquire(taskId: string, ownerId: string, leaseMs: number): Promise<boolean> {
    await this.initialize();
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.repository.load('global');
      const existing = current.slots.find((slot) => slot.taskId === taskId);
      if (existing) return existing.ownerId === ownerId;
      if (current.slots.length >= this.maxWorkers) return false;
      const identity = this.identity();
      const slot: SchedulerSlot = { taskId, ownerId, ownerPid: identity.ownerPid, hostId: identity.hostId, expiresAt: new Date(this.runtime.nowMs() + leaseMs).toISOString() };
      try { await this.repository.replace({ ...current, slots: [...current.slots, slot] }, current.revision); return true; }
      catch (error) {
        if (!(error instanceof StateRepositoryError && ['STALE_STATE_REVISION', 'STATE_RECORD_LOCKED'].includes(error.code))) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      }
    }
    throw new TaskSchedulerError('SCHEDULER_CONTENTION', 'Scheduler could not settle a slot claim.');
  }

  async heartbeat(taskId: string, ownerId: string, leaseMs: number): Promise<void> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.repository.load('global');
      const slot = current.slots.find((item) => item.taskId === taskId && item.ownerId === ownerId);
      if (!slot) throw new TaskSchedulerError('STALE_SCHEDULER_OWNER', 'Scheduler slot owner is stale.');
      const slots = current.slots.map((item) => item === slot ? { ...item, expiresAt: new Date(this.runtime.nowMs() + leaseMs).toISOString() } : item);
      try { await this.repository.replace({ ...current, slots }, current.revision); return; }
      catch (error) {
        if (!(error instanceof StateRepositoryError && ['STALE_STATE_REVISION', 'STATE_RECORD_LOCKED'].includes(error.code))) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      }
    }
    throw new TaskSchedulerError('SCHEDULER_CONTENTION', 'Scheduler heartbeat could not settle.');
  }

  async release(taskId: string, ownerId: string): Promise<void> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.repository.load('global');
      const slots = current.slots.filter((slot) => !(slot.taskId === taskId && slot.ownerId === ownerId));
      if (slots.length === current.slots.length) return;
      try { await this.repository.replace({ ...current, slots }, current.revision); return; }
      catch (error) {
        if (!(error instanceof StateRepositoryError && ['STALE_STATE_REVISION', 'STATE_RECORD_LOCKED'].includes(error.code))) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      }
    }
    throw new TaskSchedulerError('SCHEDULER_CONTENTION', 'Scheduler release could not settle.');
  }

  async releaseTask(taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.repository.load('global');
      const slots = current.slots.filter((slot) => slot.taskId !== taskId);
      if (slots.length === current.slots.length) return;
      try { await this.repository.replace({ ...current, slots }, current.revision); return; }
      catch (error) {
        if (!(error instanceof StateRepositoryError && ['STALE_STATE_REVISION', 'STATE_RECORD_LOCKED'].includes(error.code))) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      }
    }
    throw new TaskSchedulerError('SCHEDULER_CONTENTION', 'Scheduler task release could not settle.');
  }

  async recoverExpired(probe: (hostId: string, pid: number) => OwnerProbeState): Promise<SchedulerRecovery> {
    await this.initialize();
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.repository.load('global');
      const released: string[] = [];
      const ambiguous: string[] = [];
      const slots = current.slots.filter((slot) => {
        if (Date.parse(slot.expiresAt) > this.runtime.nowMs()) return true;
        const state = probe(slot.hostId, slot.ownerPid);
        if (state === 'dead') { released.push(slot.taskId); return false; }
        if (state === 'unknown') ambiguous.push(slot.taskId);
        return true;
      });
      if (slots.length === current.slots.length) return { released, ambiguous };
      try { await this.repository.replace({ ...current, slots }, current.revision); return { released, ambiguous }; }
      catch (error) {
        if (!(error instanceof StateRepositoryError && ['STALE_STATE_REVISION', 'STATE_RECORD_LOCKED'].includes(error.code))) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      }
    }
    throw new TaskSchedulerError('SCHEDULER_CONTENTION', 'Scheduler recovery could not settle.');
  }

  async count(): Promise<number> { await this.initialize(); return (await this.repository.load('global')).slots.length; }
}
