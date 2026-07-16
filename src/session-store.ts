import { basename, resolve } from 'node:path';

import { DEFAULT_MODEL_ID } from './catalog.js';
import { MaintenanceStore } from './maintenance-store.js';
import { redactSecrets } from './redact.js';
import { systemRuntime, type RuntimeSeams } from './runtime.js';
import { stateDirectory } from './state-root.js';
import { StateRepository, type StateDiagnostic, type StateListResult } from './state-repository.js';
import { assertStateRecordId } from './state-policy.js';
import type { PermissionMode, SessionMessage, ZeuzSession } from './types.js';

export { stateDirectory } from './state-root.js';

export interface SessionStoreOptions {
  root?: string;
  runtime?: RuntimeSeams;
}

export class SessionStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'SessionStoreError'; this.code = code; }
}

export function makeMessage(role: SessionMessage['role'], content: string, modelId?: string, runtime: RuntimeSeams = systemRuntime): SessionMessage {
  return {
    id: runtime.newId(),
    role,
    content: redactSecrets(content),
    createdAt: runtime.now(),
    ...(modelId ? { modelId } : {}),
  };
}

function text(value: unknown, label: string, maximum = 1_000_000): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new SessionStoreError('STATE_SCHEMA_MISMATCH', `${label} is invalid.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) throw new SessionStoreError('STATE_SCHEMA_MISMATCH', `${label} is invalid.`);
  return result;
}

function assertSession(value: unknown): asserts value is ZeuzSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionStoreError('STATE_SCHEMA_MISMATCH', 'Session state is invalid.');
  const session = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'revision', 'id', 'title', 'cwd', 'activeModelId', 'permissionMode', 'messages', 'providerSessions', 'createdAt', 'updatedAt', 'parentId', 'summary', 'summaryUpdatedAt', 'lastUsedModelId', 'userSlug']);
  if (Object.keys(session).some((key) => !allowed.has(key))) throw new SessionStoreError('STATE_SCHEMA_MISMATCH', 'Session contains unknown fields.');
  if (typeof session.schemaVersion === 'number' && session.schemaVersion > 1) throw new SessionStoreError('UNSUPPORTED_STATE_VERSION', 'Session state version is unsupported.');
  if (session.schemaVersion !== 1 || !Number.isSafeInteger(session.revision)) throw new SessionStoreError('STATE_SCHEMA_MISMATCH', 'Session version or revision is invalid.');
  assertStateRecordId(text(session.id, 'session.id', 200));
  text(session.title, 'session.title', 1_000);
  text(session.cwd, 'session.cwd', 8_192);
  text(session.activeModelId, 'session.activeModelId', 500);
  if (!['plan', 'agent', 'yolo'].includes(String(session.permissionMode))) throw new SessionStoreError('STATE_SCHEMA_MISMATCH', 'Session permission mode is invalid.');
  if (!Array.isArray(session.messages) || !session.providerSessions || typeof session.providerSessions !== 'object' || Array.isArray(session.providerSessions)) throw new SessionStoreError('STATE_SCHEMA_MISMATCH', 'Session messages or provider state is invalid.');
  if (session.messages.length > 20_000) throw new SessionStoreError('STATE_QUOTA_EXCEEDED', 'Session message count exceeds its budget.');
  for (const messageValue of session.messages) {
    if (!messageValue || typeof messageValue !== 'object' || Array.isArray(messageValue)) throw new SessionStoreError('STATE_SCHEMA_MISMATCH', 'Session message is invalid.');
    const message = messageValue as Record<string, unknown>;
    const messageAllowed = new Set(['id', 'role', 'content', 'createdAt', 'modelId']);
    if (Object.keys(message).some((key) => !messageAllowed.has(key))) throw new SessionStoreError('STATE_SCHEMA_MISMATCH', 'Session message contains unknown fields.');
    assertStateRecordId(text(message.id, 'session.message.id', 200));
    if (!['user', 'assistant', 'system', 'reviewer'].includes(String(message.role))) throw new SessionStoreError('STATE_SCHEMA_MISMATCH', 'Session message role is invalid.');
    if (typeof message.content !== 'string' || Buffer.byteLength(message.content) > 2 * 1024 * 1024) throw new SessionStoreError('STATE_QUOTA_EXCEEDED', 'Session message exceeds its budget.');
    timestamp(message.createdAt, 'session.message.createdAt');
    if (message.modelId !== undefined) text(message.modelId, 'session.message.modelId', 500);
  }
  for (const [model, nativeId] of Object.entries(session.providerSessions as Record<string, unknown>)) {
    if (!model || typeof nativeId !== 'string' || nativeId.length === 0 || nativeId.length > 8_192) throw new SessionStoreError('STATE_SCHEMA_MISMATCH', 'Session provider state is invalid.');
  }
  timestamp(session.createdAt, 'session.createdAt');
  timestamp(session.updatedAt, 'session.updatedAt');
  if (session.parentId !== undefined) text(session.parentId, 'session.parentId', 200);
  if (session.summary !== undefined && (typeof session.summary !== 'string' || Buffer.byteLength(session.summary) > 2 * 1024 * 1024)) throw new SessionStoreError('STATE_QUOTA_EXCEEDED', 'Session summary exceeds its budget.');
  if (session.summaryUpdatedAt !== undefined) timestamp(session.summaryUpdatedAt, 'session.summaryUpdatedAt');
  if (session.lastUsedModelId !== undefined) text(session.lastUsedModelId, 'session.lastUsedModelId', 500);
  if (session.userSlug !== undefined) text(session.userSlug, 'session.userSlug', 200);
}

function importLegacySession(value: unknown): ZeuzSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionStoreError('LEGACY_STATE_INVALID', 'Legacy session is invalid.');
  const legacy = value as Record<string, unknown>;
  const mode = legacy.permissionMode;
  if (!['plan', 'agent', 'yolo'].includes(String(mode))) throw new SessionStoreError('LEGACY_STATE_INVALID', 'Legacy session permission mode is invalid.');
  const messages = Array.isArray(legacy.messages) ? legacy.messages : undefined;
  const providerSessions = legacy.providerSessions && typeof legacy.providerSessions === 'object' && !Array.isArray(legacy.providerSessions) ? legacy.providerSessions as Record<string, string> : undefined;
  if (!messages || !providerSessions) throw new SessionStoreError('LEGACY_STATE_INVALID', 'Legacy session collections are invalid.');
  const session: ZeuzSession = {
    schemaVersion: 1,
    revision: 0,
    id: text(legacy.id, 'legacy session.id', 200),
    title: text(legacy.title, 'legacy session.title', 1_000),
    cwd: text(legacy.cwd, 'legacy session.cwd', 8_192),
    activeModelId: text(legacy.activeModelId, 'legacy session.activeModelId', 500),
    permissionMode: mode as PermissionMode,
    createdAt: text(legacy.createdAt, 'legacy session.createdAt', 64),
    updatedAt: text(legacy.updatedAt, 'legacy session.updatedAt', 64),
    messages: messages as SessionMessage[],
    providerSessions,
    ...(typeof legacy.parentId === 'string' ? { parentId: legacy.parentId } : {}),
    ...(typeof legacy.summary === 'string' ? { summary: legacy.summary } : {}),
    ...(typeof legacy.summaryUpdatedAt === 'string' ? { summaryUpdatedAt: legacy.summaryUpdatedAt } : {}),
    ...(typeof legacy.lastUsedModelId === 'string' ? { lastUsedModelId: legacy.lastUsedModelId } : {}),
    ...(typeof legacy.userSlug === 'string' ? { userSlug: legacy.userSlug } : {}),
  };
  assertSession(session);
  return session;
}

export class SessionStore {
  private readonly repository: StateRepository<ZeuzSession>;
  private readonly maintenance: MaintenanceStore;
  private readonly runtime: RuntimeSeams;
  private lastDiagnostics: StateDiagnostic[] = [];

  constructor(options: SessionStoreOptions = {}) {
    this.runtime = options.runtime ?? systemRuntime;
    const root = resolve(options.root ?? stateDirectory());
    this.repository = new StateRepository({ root, collection: 'sessions', runtime: this.runtime, validate: assertSession, importLegacy: importLegacySession });
    this.maintenance = new MaintenanceStore(root, this.runtime);
  }

  async initialize(): Promise<void> { await this.repository.initialize(); }

  async create(cwd: string, options: { title?: string; modelId?: string; mode?: PermissionMode; parentId?: string; summary?: string; messages?: SessionMessage[]; userSlug?: string } = {}): Promise<ZeuzSession> {
    await this.initialize();
    return await this.maintenance.withStableEpoch(undefined, async () => {
    const timestamp = this.runtime.now();
    const session: ZeuzSession = {
      schemaVersion: 1,
      revision: 0,
      id: this.runtime.newId(),
      title: options.title ?? (basename(cwd) || 'ZeuZ session'),
      cwd,
      activeModelId: options.modelId ?? DEFAULT_MODEL_ID,
      permissionMode: options.mode ?? 'agent',
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: options.messages ?? [],
      providerSessions: {},
      ...(options.userSlug ? { userSlug: options.userSlug } : {}),
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.summary ? { summary: options.summary, summaryUpdatedAt: timestamp } : {}),
    };
    return await this.repository.create(session);
    });
  }

  async save(session: ZeuzSession): Promise<void> {
    const saved = await this.maintenance.withStableEpoch(undefined, async () => await this.repository.replace(session, session.revision));
    Object.assign(session, saved);
  }

  async load(idOrPrefix: string): Promise<ZeuzSession> {
    const sessions = await this.list();
    const exact = sessions.find((session) => session.id === idOrPrefix || session.title.toLowerCase() === idOrPrefix.toLowerCase());
    if (exact) return exact;
    const matches = sessions.filter((session) => session.id.startsWith(idOrPrefix));
    if (matches.length !== 1 || !matches[0]) throw new SessionStoreError(matches.length > 1 ? 'SESSION_PREFIX_AMBIGUOUS' : 'SESSION_NOT_FOUND', matches.length > 1 ? 'Session prefix is ambiguous.' : 'Session was not found.');
    return matches[0];
  }

  async list(): Promise<ZeuzSession[]> {
    const result = await this.listDetailed();
    return result.records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listDetailed(): Promise<StateListResult<ZeuzSession>> {
    const result = await this.repository.listDetailed();
    this.lastDiagnostics = result.diagnostics;
    return result;
  }

  async migrateRecordsInMaintenance(): Promise<StateListResult<ZeuzSession>> {
    const maintenance = await this.maintenance.current();
    if (!maintenance.active) throw new SessionStoreError('MAINTENANCE_REQUIRED', 'Session migration requires the root maintenance fence.');
    const result = await this.repository.migrateAll();
    this.lastDiagnostics = result.diagnostics;
    return result;
  }

  diagnostics(): StateDiagnostic[] { return structuredClone(this.lastDiagnostics); }

  async fork(session: ZeuzSession, title?: string): Promise<ZeuzSession> {
    return await this.create(session.cwd, {
      title: title ?? `${session.title} (fork)`,
      modelId: session.activeModelId,
      mode: session.permissionMode,
      parentId: session.id,
      ...(session.summary ? { summary: session.summary } : {}),
      messages: session.messages.map((message) => ({ ...message, id: this.runtime.newId() })),
      ...(session.userSlug ? { userSlug: session.userSlug } : {}),
    });
  }
}
