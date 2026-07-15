import { randomUUID } from 'node:crypto';

import { workspaceFingerprint } from './git.js';

export interface RuntimeSeams {
  now(): string;
  nowMs(): number;
  newId(): string;
  fingerprint(cwd: string): string | undefined;
}

export const systemRuntime: RuntimeSeams = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
  newId: () => randomUUID(),
  fingerprint: workspaceFingerprint,
};

export function measurablyUnchanged(before: string | undefined, after: string | undefined): boolean {
  return before !== undefined && after !== undefined && before === after;
}
