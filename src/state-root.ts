import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function stateDirectory(): string {
  return resolve(process.env.ZEUZ_STATE_DIR ?? join(homedir(), '.agents'));
}
