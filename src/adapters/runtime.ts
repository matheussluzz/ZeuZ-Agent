import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { sanitizedChildEnvironment } from '../env.js';
import {
  findExecutable,
  resolveCodexExecutable,
  runProcess,
  type ProcessOptions,
  type ProcessResult,
} from '../process.js';

export interface SpawnSyncResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface AdapterRuntime {
  findExecutable(name: string): string | undefined;
  resolveCodexExecutable(): string;
  runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult>;
  spawnSync(
    executable: string,
    args: string[],
    options?: { encoding?: BufferEncoding; timeout?: number },
  ): SpawnSyncResult;
  now(): number;
  randomUUID(): string;
  sanitizedChildEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  envGet(name: string): string | undefined;
}

export function createDefaultAdapterRuntime(): AdapterRuntime {
  return {
    findExecutable,
    resolveCodexExecutable,
    runProcess,
    spawnSync(executable, args, options) {
      const result = spawnSync(executable, args, options);
      return {
        status: result.status,
        stdout: typeof result.stdout === 'string' ? result.stdout : (result.stdout?.toString() ?? ''),
        stderr: typeof result.stderr === 'string' ? result.stderr : (result.stderr?.toString() ?? ''),
      };
    },
    now: () => Date.now(),
    randomUUID: () => randomUUID(),
    sanitizedChildEnvironment,
    envGet: (name) => process.env[name],
  };
}

export const defaultAdapterRuntime = createDefaultAdapterRuntime();
