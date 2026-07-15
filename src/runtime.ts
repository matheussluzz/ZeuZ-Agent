import { randomUUID } from 'node:crypto';

import { workspaceFingerprint } from './git.js';
import { legacyFingerprintSnapshot, measureWorkspace, type WorkspaceSnapshot } from './workspace.js';

export interface RuntimeSeams {
  now(): string;
  nowMs(): number;
  newId(): string;
  fingerprint(cwd: string): string | undefined;
  measureWorkspace?(cwd: string): WorkspaceSnapshot;
}

export const systemRuntime: RuntimeSeams = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
  newId: () => randomUUID(),
  fingerprint: workspaceFingerprint,
  measureWorkspace,
};

export function measurablyUnchanged(before: string | undefined, after: string | undefined): boolean {
  return before !== undefined && after !== undefined && before === after;
}

export function runtimeWorkspaceSnapshot(runtime: RuntimeSeams, cwd: string): WorkspaceSnapshot {
  return runtime.measureWorkspace?.(cwd) ?? legacyFingerprintSnapshot(runtime.fingerprint(cwd));
}
