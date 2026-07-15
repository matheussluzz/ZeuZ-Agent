import { AgyAdapter } from './agy.js';
import { CodexAdapter } from './codex.js';
import { ClaudeAdapter } from './claude.js';
import { CopilotAdapter } from './copilot.js';
import { CursorAdapter } from './cursor.js';
import { NvidiaAdapter } from './nvidia.js';
import { defaultAdapterRuntime, type AdapterRuntime } from './runtime.js';
import type { AgentAdapter, ProviderId } from '../types.js';

const PROVIDERS: ProviderId[] = ['codex', 'cursor', 'claude', 'agy', 'copilot', 'nvidia'];

export interface AdapterRegistryOptions {
  runtime?: AdapterRuntime;
  adapters?: Partial<Record<ProviderId, AgentAdapter>>;
  factory?: (provider: ProviderId, runtime: AdapterRuntime) => AgentAdapter;
}

function createDefaultAdapter(provider: ProviderId, runtime: AdapterRuntime): AgentAdapter {
  switch (provider) {
    case 'codex':
      return new CodexAdapter(runtime);
    case 'cursor':
      return new CursorAdapter(runtime);
    case 'claude':
      return new ClaudeAdapter(runtime);
    case 'agy':
      return new AgyAdapter(runtime);
    case 'copilot':
      return new CopilotAdapter({ runtime });
    case 'nvidia':
      return new NvidiaAdapter({ runtime });
  }
}

export class AdapterRegistry {
  private readonly adapters = new Map<ProviderId, AgentAdapter>();

  constructor(options?: AdapterRegistryOptions) {
    const runtime = options?.runtime ?? defaultAdapterRuntime;
    for (const provider of PROVIDERS) {
      const adapter = options?.adapters?.[provider]
        ?? (options?.factory ? options.factory(provider, runtime) : createDefaultAdapter(provider, runtime));
      this.adapters.set(provider, adapter);
    }
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
