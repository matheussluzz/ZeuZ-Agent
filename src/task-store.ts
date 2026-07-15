import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { redactSecrets } from './redact.js';
import { stateDirectory } from './session-store.js';
import type { PermissionMode, TaskRecord } from './types.js';

const MAX_DELEGATES = 3;
const STALE_LOCK_MS = 30 * 60 * 1000;

export class TaskStore {
  private readonly tasksDir = join(stateDirectory(), 'tasks');
  private readonly runtimeDir = join(stateDirectory(), 'runtime');

  async initialize(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
  }

  async create(input: { parentSessionId?: string; modelId: string; prompt: string; cwd: string; mode: PermissionMode }): Promise<TaskRecord> {
    await this.initialize();
    const timestamp = new Date().toISOString();
    const task: TaskRecord = {
      id: randomUUID(),
      modelId: input.modelId,
      prompt: redactSecrets(input.prompt),
      cwd: input.cwd,
      mode: input.mode,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    };
    await this.save(task);
    return task;
  }

  async save(task: TaskRecord): Promise<void> {
    await this.initialize();
    task.updatedAt = new Date().toISOString();
    const target = join(this.tasksDir, `${task.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${redactSecrets(JSON.stringify(task, null, 2))}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  async list(limit = 30): Promise<TaskRecord[]> {
    await this.initialize();
    const files = (await readdir(this.tasksDir)).filter((file) => file.endsWith('.json'));
    const tasks: TaskRecord[] = [];
    for (const file of files) {
      try {
        tasks.push(JSON.parse(await readFile(join(this.tasksDir, file), 'utf8')) as TaskRecord);
      } catch {
        // Ignore incomplete task records.
      }
    }
    return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit);
  }

  async acquireSlot(): Promise<() => Promise<void>> {
    await this.initialize();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      for (let slot = 0; slot < MAX_DELEGATES; slot += 1) {
        const lockPath = join(this.runtimeDir, `delegate-${slot}.lock`);
        try {
          const handle = await open(lockPath, 'wx', 0o600);
          await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
          await handle.close();
          return async () => await rm(lockPath, { force: true });
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          if (code !== 'EEXIST') throw error;
          try {
            const info = await stat(lockPath);
            if (Date.now() - info.mtimeMs > STALE_LOCK_MS) await rm(lockPath, { force: true });
          } catch {
            // Another process may have released the slot.
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`All ${MAX_DELEGATES} subagent slots are busy.`);
  }
}
