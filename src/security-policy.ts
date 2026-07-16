import type { PermissionMode } from './types.js';

const CREDENTIAL_PATH = /(^|\/)(?:\.env(?:\.[^/]*)?|lamine(?:\.[^/]*)?\.ya?ml|\.npmrc|auth\.json|[^/]*(?:credentials?|secrets?)[^/]*)$/i;
const MEDUSA_SENSITIVE_PATH = /(^|\/)(\.env(?:\..*)?|lamine(?:\.[^/]*)?\.ya?ml|\.npmrc|auth\.json|[^/]*(?:credentials?|secrets?)[^/]*\.json|[^/]+\.(?:pem|key|p12|pfx|jks))$/i;
const PUBLIC_TRACKED_TEMPLATES = new Set([
  '.env.example',
  'lamine.example.yaml',
  'scripts/check-secrets.mjs',
  'templates/aws-athena-mcp/.env.example',
]);

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

export function isSensitiveWorkspacePath(path: string, options: { allowPublicTrackedPath?: boolean } = {}): boolean {
  const portable = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (options.allowPublicTrackedPath !== false && PUBLIC_TRACKED_TEMPLATES.has(portable)) return false;
  return isCredentialPath(portable) || MEDUSA_SENSITIVE_PATH.test(portable);
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
