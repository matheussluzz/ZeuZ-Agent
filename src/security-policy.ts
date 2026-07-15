import type { PermissionMode } from './types.js';

const CREDENTIAL_PATH = /(^|\/)(?:\.env(?:\.[^/]*)?|lamine(?:\.[^/]*)?\.ya?ml|\.npmrc|auth\.json|[^/]*(?:credentials?|secrets?)[^/]*)$/i;

export class ShellPolicyViolationError extends Error {
  readonly code = 'SHELL_POLICY_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'ShellPolicyViolationError';
  }
}

export function isCredentialPath(path: string): boolean {
  return CREDENTIAL_PATH.test(path.replaceAll('\\', '/'));
}

export function assertDirectShellPolicy(command: string, mode: PermissionMode): void {
  if (!command.trim()) throw new ShellPolicyViolationError('Command is required.');
  if (/(?:^|\s)(?:sudo|git\s+push|git\s+reset\s+--hard|rm\s+-rf\s+\/)(?:\s|$)/i.test(command)) {
    throw new ShellPolicyViolationError('Destructive or remote-mutating command denied.');
  }
  if (/(?:^|[\s'"`=])(?:\.env(?:\.[^\s'"`;&|<>]*)?|lamine(?:\.[^\s'"`;&|<>]*)?\.ya?ml|\.npmrc|auth\.json|[^\s/'"`;&|<>]*(?:credentials?|secrets?)[^\s/'"`;&|<>]*)\b/i.test(command)) {
    throw new ShellPolicyViolationError('Commands cannot reference credential-bearing filenames.');
  }
  if (mode === 'plan' && /(?:\r|\n|;|&&|\|\||(?<!\|)\|(?!\|)|`|\$\(|[<>])/.test(command)) {
    throw new ShellPolicyViolationError('Shell chaining, substitution, pipes, and redirects are denied in plan mode.');
  }
}
