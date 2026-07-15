import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

export function isGitRepository(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
}

export function gitStatus(cwd: string): string {
  if (!isGitRepository(cwd)) return 'Not a Git repository.';
  return git(cwd, ['status', '--short', '--branch']).stdout.trim() || 'Working tree clean.';
}

export function currentBranch(cwd: string): string | undefined {
  if (!isGitRepository(cwd)) return undefined;
  return git(cwd, ['branch', '--show-current']).stdout.trim() || undefined;
}

export function listBranches(cwd: string): string {
  if (!isGitRepository(cwd)) return 'Not a Git repository.';
  return git(cwd, ['branch', '--format=%(if)%(HEAD)%(then)* %(else)  %(end)%(refname:short)']).stdout.trim();
}

export function switchBranch(cwd: string, name: string): string {
  if (!isGitRepository(cwd)) throw new Error('The current workspace is not a Git repository.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..') || name.endsWith('/')) throw new Error(`Invalid branch name: ${name}`);
  const exists = git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).ok;
  const result = git(cwd, exists ? ['switch', name] : ['switch', '-c', name]);
  if (!result.ok) throw new Error(result.stderr.trim() || `Unable to switch to ${name}.`);
  return exists ? `Switched to branch ${name}.` : `Created and switched to branch ${name}.`;
}

export function gitDiff(cwd: string): string {
  if (!isGitRepository(cwd)) return 'Diff is unavailable because the current workspace is not a Git repository.';
  const unstaged = git(cwd, ['diff', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']).stdout;
  const staged = git(cwd, ['diff', '--cached', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']).stdout;
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).stdout.trim();
  const sections = [
    staged ? `# Staged\n${staged}` : '',
    unstaged ? `# Unstaged\n${unstaged}` : '',
    untracked ? `# Untracked\n${untracked}` : '',
  ].filter(Boolean);
  return sections.join('\n') || 'Working tree clean.';
}

export function workspaceFingerprint(cwd: string): string | undefined {
  if (!isGitRepository(cwd)) return undefined;
  const hash = createHash('sha256');
  hash.update(git(cwd, ['status', '--porcelain=v1', '-z']).stdout);
  hash.update(git(cwd, ['diff', '--binary', 'HEAD']).stdout);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean);
  for (const relative of untracked) {
    const path = resolve(cwd, relative);
    hash.update(relative);
    try {
      const info = statSync(path);
      if (info.isFile() && info.size <= 5 * 1024 * 1024) hash.update(readFileSync(path));
      else hash.update(`${info.size}:${info.mtimeMs}`);
    } catch {
      hash.update('missing');
    }
  }
  return hash.digest('hex');
}
