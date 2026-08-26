import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { redactSecrets } from './redact.js';
import { systemRuntime, type RuntimeSeams } from './runtime.js';
import { stateDirectory } from './state-root.js';
import { StateRepository, StateRepositoryError, type StateListResult, type VersionedStateRecord } from './state-repository.js';
import { assertStateRecordId } from './state-policy.js';
import { normalizeCapabilityRequest, type CapabilityRoutingDecision, type SpecialistCapabilityRequest } from './specialists.js';

export const TASK_MESSAGE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_TASK_MESSAGE_MAX_BYTES = 64 * 1024;
export const DEFAULT_TASK_MESSAGE_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type TaskMessageStatus = 'queued' | 'claimed' | 'delivered';
export type TaskMessageDelivery = 'queued' | 'live';

export interface TaskMessageRecord extends VersionedStateRecord {
  schemaVersion: typeof TASK_MESSAGE_SCHEMA_VERSION;
  taskId: string;
  rootCorrelationId: string;
  content: string;
  status: TaskMessageStatus;
  delivery: TaskMessageDelivery;
  claimToken?: string;
  claimedAt?: string;
  claimLeaseExpiresAt?: string;
  deliveredAt?: string;
}

export interface TaskMessageStoreOptions {
  root?: string;
  runtime?: RuntimeSeams;
  maxMessageBytes?: number;
  claimLeaseMs?: number;
}

export class TaskMessageStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TaskMessageStoreError';
    this.code = code;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', 'Task message must be an object.');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 8_192): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', `${label} is invalid.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', `${label} is invalid.`);
  return result;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', `${label} is invalid.`);
  return value as number;
}

export function assertTaskMessage(value: unknown): asserts value is TaskMessageRecord {
  const message = object(value);
  const allowed = new Set([
    'schemaVersion', 'revision', 'id', 'createdAt', 'updatedAt', 'taskId', 'rootCorrelationId', 'content', 'status', 'delivery',
    'claimToken', 'claimedAt', 'claimLeaseExpiresAt', 'deliveredAt',
  ]);
  if (Object.keys(message).some((key) => !allowed.has(key))) throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', 'Task message contains unknown fields.');
  if (message.schemaVersion !== TASK_MESSAGE_SCHEMA_VERSION) throw new TaskMessageStoreError('UNSUPPORTED_STATE_VERSION', 'Task message schema version is unsupported.');
  integer(message.revision, 'message.revision');
  assertStateRecordId(text(message.id, 'message.id', 200));
  assertStateRecordId(text(message.taskId, 'message.taskId', 200));
  text(message.rootCorrelationId, 'message.rootCorrelationId', 200);
  const content = text(message.content, 'message.content', DEFAULT_TASK_MESSAGE_MAX_BYTES);
  if (Buffer.byteLength(content, 'utf8') > DEFAULT_TASK_MESSAGE_MAX_BYTES) throw new TaskMessageStoreError('TASK_MESSAGE_TOO_LARGE', 'Task message exceeds its byte budget.');
  if (!['queued', 'claimed', 'delivered'].includes(String(message.status))) throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', 'Task message status is invalid.');
  if (!['queued', 'live'].includes(String(message.delivery))) throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', 'Task message delivery is invalid.');
  timestamp(message.createdAt, 'message.createdAt');
  timestamp(message.updatedAt, 'message.updatedAt');
  if (message.claimToken !== undefined) text(message.claimToken, 'message.claimToken', 200);
  if (message.claimedAt !== undefined) timestamp(message.claimedAt, 'message.claimedAt');
  if (message.claimLeaseExpiresAt !== undefined) timestamp(message.claimLeaseExpiresAt, 'message.claimLeaseExpiresAt');
  if (message.deliveredAt !== undefined) timestamp(message.deliveredAt, 'message.deliveredAt');
  if (message.status === 'queued' && (message.claimToken !== undefined || message.claimedAt !== undefined || message.claimLeaseExpiresAt !== undefined || message.deliveredAt !== undefined)) {
    throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', 'Queued task message cannot carry delivery evidence.');
  }
  if (message.status === 'claimed' && (!message.claimToken || !message.claimedAt || !message.claimLeaseExpiresAt || message.deliveredAt !== undefined)) {
    throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', 'Claimed task message requires an active claim.');
  }
  if (message.status !== 'delivered' && message.delivery !== 'queued') throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', 'Only delivered task messages may use live delivery.');
  if (message.status === 'delivered' && (!message.deliveredAt || message.claimToken !== undefined || message.claimedAt !== undefined || message.claimLeaseExpiresAt !== undefined)) {
    throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', 'Delivered task message requires final delivery evidence.');
  }
  if (typeof message.claimedAt === 'string' && typeof message.claimLeaseExpiresAt === 'string' && Date.parse(message.claimLeaseExpiresAt) <= Date.parse(message.claimedAt)) {
    throw new TaskMessageStoreError('STATE_SCHEMA_MISMATCH', 'Task message claim lease is invalid.');
  }
}

function messageContent(content: string, maxBytes: number): string {
  const redacted = redactSecrets(content).trim();
  if (!redacted) throw new TaskMessageStoreError('EMPTY_TASK_MESSAGE', 'Follow-up message cannot be empty.');
  if (Buffer.byteLength(redacted, 'utf8') > maxBytes) throw new TaskMessageStoreError('TASK_MESSAGE_TOO_LARGE', `Follow-up message exceeds ${maxBytes} bytes.`);
  return redacted;
}

export class TaskMessageStore {
  private readonly runtime: RuntimeSeams;
  private readonly repository: StateRepository<TaskMessageRecord>;
  private readonly maxMessageBytes: number;
  private readonly claimLeaseMs: number;

  constructor(options: TaskMessageStoreOptions = {}) {
    this.runtime = options.runtime ?? systemRuntime;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_TASK_MESSAGE_MAX_BYTES;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_TASK_MESSAGE_CLAIM_LEASE_MS;
    if (!Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 1 || this.maxMessageBytes > DEFAULT_TASK_MESSAGE_MAX_BYTES) throw new TaskMessageStoreError('INVALID_MESSAGE_POLICY', 'Task message byte budget is invalid.');
    if (!Number.isSafeInteger(this.claimLeaseMs) || this.claimLeaseMs < 1_000 || this.claimLeaseMs > 3_600_000) throw new TaskMessageStoreError('INVALID_MESSAGE_POLICY', 'Task message claim lease is invalid.');
    this.repository = new StateRepository({
      root: resolve(options.root ?? stateDirectory()),
      collection: 'task-messages',
      runtime: this.runtime,
      validate: assertTaskMessage,
      maxRecordBytes: Math.max(128 * 1024, this.maxMessageBytes * 2),
    });
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
  }

  async enqueue(input: { taskId: string; rootCorrelationId: string; content: string }): Promise<TaskMessageRecord> {
    await this.initialize();
    assertStateRecordId(input.taskId);
    const content = messageContent(input.content, this.maxMessageBytes);
    const now = this.runtime.now();
    const record: TaskMessageRecord = {
      schemaVersion: TASK_MESSAGE_SCHEMA_VERSION,
      revision: 0,
      id: this.runtime.newId() || randomUUID(),
      createdAt: now,
      updatedAt: now,
      taskId: input.taskId,
      rootCorrelationId: text(input.rootCorrelationId, 'rootCorrelationId', 200),
      content,
      status: 'queued',
      delivery: 'queued',
    };
    return await this.repository.create(record);
  }

  async load(id: string): Promise<TaskMessageRecord> {
    return await this.repository.load(id);
  }

  async list(taskId?: string, status?: TaskMessageStatus): Promise<TaskMessageRecord[]> {
    const result = await this.listDetailed();
    return result.records
      .filter((message) => (taskId ? message.taskId === taskId : true) && (status ? message.status === status : true))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async listDetailed(): Promise<StateListResult<TaskMessageRecord>> {
    await this.initialize();
    return await this.repository.listDetailed();
  }

  async claimForExecution(taskId: string, claimToken = this.runtime.newId() || randomUUID(), limit = 32): Promise<TaskMessageRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new TaskMessageStoreError('INVALID_MESSAGE_LIMIT', 'Task message claim limit is invalid.');
    const claimed: TaskMessageRecord[] = [];
    for (const candidate of await this.list(taskId, 'queued')) {
      if (claimed.length >= limit) break;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const current = await this.repository.load(candidate.id);
          if (current.status !== 'queued') break;
          const claimedAt = this.runtime.now();
          const next: TaskMessageRecord = {
            ...current,
            status: 'claimed',
            claimToken,
            claimedAt,
            claimLeaseExpiresAt: new Date(this.runtime.nowMs() + this.claimLeaseMs).toISOString(),
          };
          claimed.push(await this.repository.replace(next, current.revision));
          break;
        } catch (error) {
          if (!(error instanceof StateRepositoryError && ['STALE_STATE_REVISION', 'STATE_RECORD_LOCKED'].includes(error.code))) throw error;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
        }
      }
    }
    return claimed;
  }

  async acknowledge(taskId: string, claimToken: string, delivery: TaskMessageDelivery = 'queued'): Promise<number> {
    return await this.mutateClaimed(taskId, claimToken, (current) => {
      const next: TaskMessageRecord = { ...current, status: 'delivered', delivery, deliveredAt: this.runtime.now() };
      delete next.claimToken;
      delete next.claimedAt;
      delete next.claimLeaseExpiresAt;
      return next;
    });
  }

  async release(taskId: string, claimToken: string): Promise<number> {
    return await this.mutateClaimed(taskId, claimToken, (current) => {
      const next: TaskMessageRecord = { ...current, status: 'queued', delivery: 'queued' };
      delete next.claimToken;
      delete next.claimedAt;
      delete next.claimLeaseExpiresAt;
      delete next.deliveredAt;
      return next;
    });
  }

  async renew(taskId: string, claimToken: string): Promise<number> {
    return await this.mutateClaimed(taskId, claimToken, (current) => ({
      ...current,
      claimedAt: this.runtime.now(),
      claimLeaseExpiresAt: new Date(this.runtime.nowMs() + this.claimLeaseMs).toISOString(),
    }));
  }

  async recoverExpiredClaims(taskId?: string): Promise<number> {
    let recovered = 0;
    for (const message of await this.list(taskId, 'claimed')) {
      if (!message.claimLeaseExpiresAt || Date.parse(message.claimLeaseExpiresAt) > this.runtime.nowMs()) continue;
      const token = message.claimToken;
      if (!token) continue;
      recovered += await this.release(message.taskId, token);
    }
    return recovered;
  }

  private async mutateClaimed(taskId: string, claimToken: string, mutate: (current: TaskMessageRecord) => TaskMessageRecord): Promise<number> {
    if (!claimToken) throw new TaskMessageStoreError('INVALID_MESSAGE_CLAIM', 'Task message claim token is required.');
    let changed = 0;
    for (const candidate of await this.list(taskId, 'claimed')) {
      if (candidate.claimToken !== claimToken) continue;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const current = await this.repository.load(candidate.id);
          if (current.status !== 'claimed' || current.claimToken !== claimToken) break;
          await this.repository.replace(mutate(current), current.revision);
          changed += 1;
          break;
        } catch (error) {
          if (!(error instanceof StateRepositoryError && ['STALE_STATE_REVISION', 'STATE_RECORD_LOCKED'].includes(error.code))) throw error;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
        }
      }
    }
    return changed;
  }
}

export const TASK_CAPABILITY_SCHEMA_VERSION = 1 as const;

export type TaskCapabilityStatus = 'pending' | 'invalid' | 'approved' | 'spawned' | 'failed';
export type TaskCapabilityCode = CapabilityRoutingDecision['code'];

export interface TaskCapabilityRecord extends VersionedStateRecord {
  schemaVersion: typeof TASK_CAPABILITY_SCHEMA_VERSION;
  taskId: string;
  rootCorrelationId: string;
  request?: SpecialistCapabilityRequest;
  raw?: string;
  status: TaskCapabilityStatus;
  code: TaskCapabilityCode;
  approvalToken?: string;
  siblingTaskId?: string;
  failure?: string;
}

export class TaskCapabilityStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TaskCapabilityStoreError';
    this.code = code;
  }
}

const MAX_CAPABILITY_RAW_BYTES = 16 * 1024;
const MAX_CAPABILITY_FAILURE_BYTES = 4 * 1024;
const CAPABILITY_CODES = new Set<TaskCapabilityCode>(['ROOT_REQUIRED', 'SIBLING_SPAWN_AVAILABLE', 'INVALID_CAPABILITY_REQUEST']);
const CAPABILITY_STATUSES = new Set<TaskCapabilityStatus>(['pending', 'invalid', 'approved', 'spawned', 'failed']);

function capabilityObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', 'Capability record must be an object.');
  return value as Record<string, unknown>;
}

function capabilityText(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', `${label} is invalid.`);
  return value;
}

function capabilityExact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', `${label} contains unknown fields.`);
}

export function assertTaskCapabilityRecord(value: unknown): asserts value is TaskCapabilityRecord {
  const record = capabilityObject(value);
  capabilityExact(record, ['schemaVersion', 'revision', 'id', 'taskId', 'rootCorrelationId', 'request', 'raw', 'status', 'code', 'approvalToken', 'siblingTaskId', 'failure', 'createdAt', 'updatedAt'], 'capability record');
  if (record.schemaVersion !== TASK_CAPABILITY_SCHEMA_VERSION) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', 'Capability record schemaVersion is invalid.');
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', 'Capability record revision is invalid.');
  const id = capabilityText(record.id, 'capability.id');
  assertStateRecordId(id);
  assertStateRecordId(capabilityText(record.taskId, 'capability.taskId'));
  capabilityText(record.rootCorrelationId, 'capability.rootCorrelationId');
  if (!CAPABILITY_STATUSES.has(record.status as TaskCapabilityStatus) || !CAPABILITY_CODES.has(record.code as TaskCapabilityCode)) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', 'Capability record status or code is invalid.');
  if (record.request !== undefined && !normalizeCapabilityRequest(record.request)) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', 'Capability record request is invalid.');
  if (record.raw !== undefined) capabilityText(record.raw, 'capability.raw', MAX_CAPABILITY_RAW_BYTES);
  if (record.approvalToken !== undefined) capabilityText(record.approvalToken, 'capability.approvalToken', 200);
  if (record.siblingTaskId !== undefined) assertStateRecordId(capabilityText(record.siblingTaskId, 'capability.siblingTaskId'));
  if (record.failure !== undefined) capabilityText(record.failure, 'capability.failure', MAX_CAPABILITY_FAILURE_BYTES);
  if (!Number.isFinite(Date.parse(capabilityText(record.createdAt, 'capability.createdAt', 64))) || !Number.isFinite(Date.parse(capabilityText(record.updatedAt, 'capability.updatedAt', 64)))) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', 'Capability record timestamps are invalid.');
  if (record.status === 'invalid' && (record.code !== 'INVALID_CAPABILITY_REQUEST' || record.request)) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', 'Invalid capability records require only INVALID_CAPABILITY_REQUEST and raw evidence.');
  if (record.status !== 'invalid' && !record.request) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', 'Actionable capability records require a typed request.');
  if (record.status !== 'invalid' && record.code === 'INVALID_CAPABILITY_REQUEST') throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', 'Actionable capability records cannot use INVALID_CAPABILITY_REQUEST.');
  if (record.status === 'spawned' && !record.siblingTaskId) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', 'Spawned capability records require a sibling task ID.');
  if (record.status === 'approved' && !record.approvalToken) throw new TaskCapabilityStoreError('STATE_SCHEMA_MISMATCH', 'Approved capability records require an approval token.');
}

export interface RecordCapabilityInput {
  taskId: string;
  rootCorrelationId: string;
  request?: SpecialistCapabilityRequest;
  raw?: string;
  code: TaskCapabilityCode;
}

export interface CapabilityApprovalClaim {
  record: TaskCapabilityRecord;
  claimed: boolean;
}

export class TaskCapabilityStore {
  private readonly runtime: RuntimeSeams;
  private readonly repository: StateRepository<TaskCapabilityRecord>;
  private lastDiagnostics: import('./state-repository.js').StateDiagnostic[] = [];

  constructor(options: { root?: string; runtime?: RuntimeSeams } = {}) {
    this.runtime = options.runtime ?? systemRuntime;
    this.repository = new StateRepository({
      root: resolve(options.root ?? stateDirectory()),
      collection: 'task-capabilities',
      runtime: this.runtime,
      validate: assertTaskCapabilityRecord,
      maxRecordBytes: 128 * 1024,
    });
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
  }

  async record(input: RecordCapabilityInput): Promise<TaskCapabilityRecord> {
    await this.initialize();
    const id = this.runtime.newId();
    assertStateRecordId(id);
    const now = this.runtime.now();
    const request = input.request ? normalizeCapabilityRequest(input.request) : undefined;
    if (input.request && !request) throw new TaskCapabilityStoreError('INVALID_CAPABILITY_REQUEST', 'Capability request failed validation before persistence.');
    const actionable = request && input.code !== 'INVALID_CAPABILITY_REQUEST' ? request : undefined;
    const record: TaskCapabilityRecord = {
      schemaVersion: TASK_CAPABILITY_SCHEMA_VERSION,
      revision: 0,
      id,
      taskId: capabilityText(input.taskId, 'taskId'),
      rootCorrelationId: capabilityText(input.rootCorrelationId, 'rootCorrelationId'),
      ...(actionable ? { request: actionable } : {}),
      ...(input.raw ? { raw: redactSecrets(input.raw).slice(0, MAX_CAPABILITY_RAW_BYTES) } : {}),
      status: actionable ? 'pending' : 'invalid',
      code: actionable ? input.code : 'INVALID_CAPABILITY_REQUEST',
      createdAt: now,
      updatedAt: now,
    };
    return await this.repository.create(record);
  }

  async load(idOrPrefix: string): Promise<TaskCapabilityRecord> {
    const result = await this.listDetailed();
    const exactMatch = result.records.find((record) => record.id === idOrPrefix);
    if (exactMatch) return exactMatch;
    const matches = result.records.filter((record) => record.id.startsWith(idOrPrefix));
    if (matches.length !== 1 || !matches[0]) throw new TaskCapabilityStoreError(matches.length > 1 ? 'CAPABILITY_PREFIX_AMBIGUOUS' : 'CAPABILITY_NOT_FOUND', matches.length > 1 ? 'Capability request prefix is ambiguous.' : 'Capability request was not found.');
    return matches[0];
  }

  async list(rootCorrelationId?: string): Promise<TaskCapabilityRecord[]> {
    const records = (await this.listDetailed()).records;
    return records.filter((record) => !rootCorrelationId || record.rootCorrelationId === rootCorrelationId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listDetailed(): Promise<StateListResult<TaskCapabilityRecord>> {
    await this.initialize();
    const result = await this.repository.listDetailed();
    this.lastDiagnostics = result.diagnostics;
    return result;
  }

  diagnostics(): import('./state-repository.js').StateDiagnostic[] {
    return structuredClone(this.lastDiagnostics);
  }

  async claimApproval(idOrPrefix: string): Promise<CapabilityApprovalClaim> {
    const current = await this.load(idOrPrefix);
    if (current.status === 'approved' || current.status === 'spawned') return { record: current, claimed: false };
    if (current.status !== 'pending' || !current.request) throw new TaskCapabilityStoreError('CAPABILITY_NOT_APPROVABLE', 'Only pending typed capability requests can be approved.');
    const approvalToken = this.runtime.newId();
    try {
      const record = await this.repository.replace({ ...current, status: 'approved', approvalToken }, current.revision);
      return { record, claimed: true };
    } catch (error) {
      if (!(error instanceof StateRepositoryError && error.code === 'STALE_STATE_REVISION')) throw error;
      const latest = await this.load(current.id);
      if (latest.status === 'approved' || latest.status === 'spawned') return { record: latest, claimed: false };
      throw error;
    }
  }

  async markSpawned(idOrPrefix: string, approvalToken: string, siblingTaskId: string): Promise<TaskCapabilityRecord> {
    const current = await this.load(idOrPrefix);
    if (current.status === 'spawned') return current;
    if (current.status !== 'approved' || current.approvalToken !== approvalToken) throw new TaskCapabilityStoreError('CAPABILITY_APPROVAL_STALE', 'Capability approval is stale or already consumed.');
    assertStateRecordId(siblingTaskId);
    return await this.repository.replace({ ...current, status: 'spawned', code: 'SIBLING_SPAWN_AVAILABLE', siblingTaskId }, current.revision);
  }

  async markFailed(idOrPrefix: string, approvalToken: string, failure: string): Promise<TaskCapabilityRecord> {
    const current = await this.load(idOrPrefix);
    if (current.status === 'failed') return current;
    if (current.status !== 'approved' || current.approvalToken !== approvalToken) throw new TaskCapabilityStoreError('CAPABILITY_APPROVAL_STALE', 'Capability approval is stale or already consumed.');
    return await this.repository.replace({ ...current, status: 'failed', failure: redactSecrets(failure).slice(0, MAX_CAPABILITY_FAILURE_BYTES) }, current.revision);
  }
}
