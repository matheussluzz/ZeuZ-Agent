import type { PermissionMode, ProviderId } from './types.js';

export type FilesystemAuthority = 'read-only' | 'workspace-write' | 'unrestricted';

export interface PermissionCapability {
  provider: ProviderId;
  mode: PermissionMode;
  filesystem: FilesystemAuthority;
  approvalsBypassed: boolean;
  secretEnvironment: 'sanitized' | 'selected-route-only';
  nativeArguments: readonly string[];
  resume: 'supported' | 'unsupported';
}

export class UnsupportedCapabilityError extends Error {
  readonly code = 'UNSUPPORTED_CAPABILITY';

  constructor(provider: ProviderId, capability: string) {
    super(`${provider} cannot prove the required capability: ${capability}.`);
    this.name = 'UnsupportedCapabilityError';
  }
}

const NATIVE_ARGUMENTS: Record<ProviderId, Record<PermissionMode, readonly string[]>> = {
  codex: {
    plan: ['-s', 'read-only'],
    agent: ['-s', 'workspace-write'],
    yolo: ['--dangerously-bypass-approvals-and-sandbox'],
  },
  cursor: {
    plan: ['--mode', 'plan'],
    agent: ['--force', '--sandbox', 'enabled'],
    yolo: ['--yolo', '--sandbox', 'disabled'],
  },
  claude: {
    plan: ['--permission-mode', 'plan'],
    agent: ['--permission-mode', 'acceptEdits'],
    yolo: ['--dangerously-skip-permissions'],
  },
  copilot: {
    plan: ['--disable-builtin-mcps', '--disallow-temp-dir', '--plan', '--allow-all-tools'],
    agent: ['--disable-builtin-mcps', '--disallow-temp-dir', '--allow-all-tools'],
    yolo: ['--yolo'],
  },
  agy: {
    plan: ['--sandbox'],
    agent: ['--sandbox', '--dangerously-skip-permissions'],
    yolo: ['--dangerously-skip-permissions'],
  },
  nvidia: {
    plan: ['--disable-builtin-mcps', '--disallow-temp-dir', '--plan', '--allow-all-tools'],
    agent: ['--disable-builtin-mcps', '--disallow-temp-dir', '--allow-all-tools'],
    yolo: ['--yolo'],
  },
};

export function permissionCapability(provider: ProviderId, mode: PermissionMode): PermissionCapability {
  const nativeArguments = NATIVE_ARGUMENTS[provider]?.[mode];
  if (!nativeArguments) throw new UnsupportedCapabilityError(provider, `permission mode ${mode}`);
  return {
    provider,
    mode,
    filesystem: mode === 'plan' ? 'read-only' : mode === 'agent' ? 'workspace-write' : 'unrestricted',
    approvalsBypassed: mode === 'yolo',
    secretEnvironment: provider === 'nvidia' ? 'selected-route-only' : 'sanitized',
    nativeArguments,
    resume: provider === 'agy' ? 'unsupported' : 'supported',
  };
}

export function permissionArguments(provider: ProviderId, mode: PermissionMode, resumeId?: string): string[] {
  const capability = permissionCapability(provider, mode);
  if (resumeId && capability.resume !== 'supported') throw new UnsupportedCapabilityError(provider, 'native session resume');
  return [...capability.nativeArguments];
}
