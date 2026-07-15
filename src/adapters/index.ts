import { AgyAdapter } from './agy.js';
import { CodexAdapter } from './codex.js';
import { ClaudeAdapter } from './claude.js';
import { CopilotAdapter } from './copilot.js';
import { CursorAdapter } from './cursor.js';
import { NvidiaAdapter } from './nvidia.js';
import type { AgentAdapter, ProviderId } from '../types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<ProviderId, AgentAdapter>();

  constructor() {
    this.adapters.set('codex', new CodexAdapter());
    this.adapters.set('cursor', new CursorAdapter());
    this.adapters.set('claude', new ClaudeAdapter());
    this.adapters.set('agy', new AgyAdapter());
    this.adapters.set('copilot', new CopilotAdapter());
    this.adapters.set('nvidia', new NvidiaAdapter());
  }

  get(provider: ProviderId): AgentAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`No adapter registered for ${provider}.`);
    return adapter;
  }

  all(): AgentAdapter[] {
    return [...this.adapters.values()];
  }
}
