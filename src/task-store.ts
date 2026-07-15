import { lstat, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { redactSecrets } from './redact.js';
import { systemRuntime, type RuntimeSeams } from './runtime.js';
import { stateDirectory } from './session-store.js';
import { assertPrivateStateFile, assertStateRecordId, ensurePrivateStateDirectory, ensureStateContainerDirectory, UnsafeStateRootError, writePrivateStateFileAtomic } from './state-policy.js';
import type { PermissionMode, TaskRecord } from './types.js';

const MAX_DELEGATES = 3;
const STALE_LOCK_MS = 30 * 60 * 1000;

export interface TaskStoreOptions {
  root?: string;
  runtime?: RuntimeSeams;
}

export class TaskStore {
  private readonly root: string;
  private readonly tasksDir: string;
  private readonly runtimeDir: string;
  private readonly runtime: RuntimeSeams;

  constructor(options: TaskStoreOptions = {}) {
    const root = resolve(options.root ?? stateDirectory());
    this.root = root;
    this.runtime = options.runtime ?? systemRuntime;
    this.tasksDir = join(root, 'tasks');
    this.runtimeDir = join(root, 'runtime');
  }

  async initialize(): Promise<void> {
    await ensureStateContainerDirectory(this.root);
    await ensurePrivateStateDirectory(this.tasksDir, this.root);
    await ensurePrivateStateDirectory(this.runtimeDir, this.root);
  }

  async create(input: { parentSessionId?: string; modelId: string; prompt: string; cwd: string; mode: PermissionMode }): Promise<TaskRecord> {
    await this.initialize();
    const timestamp = this.runtime.now();
    const task: TaskRecord = {
      id: this.runtime.newId(),
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
    assertStateRecordId(task.id);
    task.updatedAt = this.runtime.now();
    const target = join(this.tasksDir, `${task.id}.json`);
    await writePrivateStateFileAtomic(target, `${redactSecrets(JSON.stringify(task, null, 2))}\n`);
  }

  async list(limit = 30): Promise<TaskRecord[]> {
    await this.initialize();
    const files = (await readdir(this.tasksDir)).filter((file) => file.endsWith('.json'));
    const tasks: TaskRecord[] = [];
    for (const file of files) {
      try {
        const path = join(this.tasksDir, file);
        await assertPrivateStateFile(path, this.tasksDir);
        tasks.push(JSON.parse(await readFile(path, 'utf8')) as TaskRecord);
      } catch (error) {
        if (error instanceof UnsafeStateRootError) throw error;
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
          await handle.writeFile(`${process.pid}\n${this.runtime.nowMs()}\n`);
          await handle.close();
          return async () => await rm(lockPath, { force: true });
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          if (code !== 'EEXIST') throw error;
          try {
            const metadata = await lstat(lockPath);
            if (metadata.isSymbolicLink() || !metadata.isFile()) throw new UnsafeStateRootError(`Delegate lock must be a regular non-symlink file: ${lockPath}`);
            if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw new UnsafeStateRootError(`Delegate lock must be owner-only (0600): ${lockPath}`);
            const info = await stat(lockPath);
            if (this.runtime.nowMs() - info.mtimeMs > STALE_LOCK_MS) await rm(lockPath, { force: true });
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
