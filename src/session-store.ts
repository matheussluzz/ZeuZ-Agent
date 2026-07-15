import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';

import { DEFAULT_MODEL_ID } from './catalog.js';
import { redactSecrets } from './redact.js';
import type { PermissionMode, SessionMessage, ZeuzSession } from './types.js';

export function stateDirectory(): string {
  return process.env.ZEUZ_STATE_DIR ?? join(homedir(), '.agents');
}

function now(): string {
  return new Date().toISOString();
}

export function makeMessage(role: SessionMessage['role'], content: string, modelId?: string): SessionMessage {
  return {
    id: randomUUID(),
    role,
    content: redactSecrets(content),
    createdAt: now(),
    ...(modelId ? { modelId } : {}),
  };
}

export class SessionStore {
  private readonly sessionsDir = join(stateDirectory(), 'sessions');

  async initialize(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
  }

  async create(cwd: string, options: { title?: string; modelId?: string; mode?: PermissionMode; parentId?: string; summary?: string; messages?: SessionMessage[]; userSlug?: string } = {}): Promise<ZeuzSession> {
    await this.initialize();
    const timestamp = now();
    const session: ZeuzSession = {
      id: randomUUID(),
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
    session.updatedAt = now();
    const target = this.pathFor(session.id);
    const temporary = `${target}.${process.pid}.tmp`;
    const serialized = redactSecrets(JSON.stringify(session, null, 2));
    await writeFile(temporary, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
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
        sessions.push(JSON.parse(await readFile(join(this.sessionsDir, file), 'utf8')) as ZeuzSession);
      } catch {
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
      messages: session.messages.map((message) => ({ ...message, id: randomUUID() })),
      ...(session.userSlug ? { userSlug: session.userSlug } : {}),
    });
  }

  private pathFor(id: string): string {
    return join(this.sessionsDir, `${id}.json`);
  }
}
