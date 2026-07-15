import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

import { DEFAULT_MODEL_ID } from './catalog.js';
import { redactSecrets } from './redact.js';
import { systemRuntime, type RuntimeSeams } from './runtime.js';
import { assertPrivateStateFile, assertStateRecordId, ensurePrivateStateDirectory, ensureStateContainerDirectory, writePrivateStateFileAtomic } from './state-policy.js';
import type { PermissionMode, SessionMessage, ZeuzSession } from './types.js';

export function stateDirectory(): string {
  return resolve(process.env.ZEUZ_STATE_DIR ?? join(homedir(), '.agents'));
}

export interface SessionStoreOptions {
  root?: string;
  runtime?: RuntimeSeams;
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

export class SessionStore {
  private readonly root: string;
  private readonly sessionsDir: string;
  private readonly runtime: RuntimeSeams;

  constructor(options: SessionStoreOptions = {}) {
    this.runtime = options.runtime ?? systemRuntime;
    this.root = resolve(options.root ?? stateDirectory());
    this.sessionsDir = join(this.root, 'sessions');
  }

  async initialize(): Promise<void> {
    await ensureStateContainerDirectory(this.root);
    await ensurePrivateStateDirectory(this.sessionsDir, this.root);
  }

  async create(cwd: string, options: { title?: string; modelId?: string; mode?: PermissionMode; parentId?: string; summary?: string; messages?: SessionMessage[]; userSlug?: string } = {}): Promise<ZeuzSession> {
    await this.initialize();
    const timestamp = this.runtime.now();
    const session: ZeuzSession = {
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
    await this.save(session);
    return session;
  }

  async save(session: ZeuzSession): Promise<void> {
    await this.initialize();
    assertStateRecordId(session.id);
    session.updatedAt = this.runtime.now();
    const target = this.pathFor(session.id);
    const serialized = redactSecrets(JSON.stringify(session, null, 2));
    await writePrivateStateFileAtomic(target, `${serialized}\n`);
  }

  async load(idOrPrefix: string): Promise<ZeuzSession> {
    const sessions = await this.list();
    const exact = sessions.find((session) => session.id === idOrPrefix || session.title.toLowerCase() === idOrPrefix.toLowerCase());
    if (exact) return exact;
    const prefixMatches = sessions.filter((session) => session.id.startsWith(idOrPrefix));
    if (prefixMatches.length === 1 && prefixMatches[0]) return prefixMatches[0];
    throw new Error(prefixMatches.length > 1 ? `Session prefix is ambiguous: ${idOrPrefix}` : `Session not found: ${idOrPrefix}`);
  }

  async list(): Promise<ZeuzSession[]> {
    await this.initialize();
    const files = (await readdir(this.sessionsDir)).filter((file) => file.endsWith('.json'));
    const sessions: ZeuzSession[] = [];
    for (const file of files) {
      try {
        const path = join(this.sessionsDir, file);
        await assertPrivateStateFile(path, this.sessionsDir);
        sessions.push(JSON.parse(await readFile(path, 'utf8')) as ZeuzSession);
      } catch (error) {
        if (error instanceof Error && error.name === 'UnsafeStateRootError') throw error;
        // A corrupt session should not prevent access to healthy sessions.
      }
    }
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

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

  private pathFor(id: string): string {
    assertStateRecordId(id);
    return join(this.sessionsDir, `${id}.json`);
  }
}
