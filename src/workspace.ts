import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { isSensitiveWorkspacePath } from './security-policy.js';

export const WORKSPACE_MEASUREMENT_POLICY = 'wave-03-v1';
export const DEFAULT_NON_GIT_MAX_FILES = 512;
export const DEFAULT_NON_GIT_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_GIT_UNTRACKED_MAX_BYTES = 5 * 1024 * 1024;

export type WorkspaceChangeState = 'changed' | 'unchanged' | 'unmeasurable';
export type WorkspaceKind = 'git' | 'non_git' | 'unknown';

export interface WorkspaceSnapshot {
  policy: typeof WORKSPACE_MEASUREMENT_POLICY;
  kind: WorkspaceKind;
  measurable: boolean;
  fingerprint?: string;
  reason?: WorkspaceMeasurementReason;
  filesMeasured?: number;
  bytesHashed?: number;
}

export type WorkspaceMeasurementReason =
  | 'git_command_failed'
  | 'repository_changed_during_measurement'
  | 'sensitive_path'
  | 'unsafe_symlink'
  | 'entry_too_large'
  | 'scan_budget_exceeded'
  | 'permission_denied'
  | 'concurrent_mutation'
  | 'workspace_unavailable'
  | 'policy_mismatch';

export interface WorkspaceChangeEvidence {
  state: WorkspaceChangeState;
  before: WorkspaceSnapshot;
  after: WorkspaceSnapshot;
}

interface GitCommandResult {
  ok: boolean;
  stdout: string;
}

export interface WorkspaceMeasurementOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxUntrackedBytes?: number;
  git?: (cwd: string, args: string[]) => GitCommandResult;
}

const REVIEW_PREFIX = '.agents/reviews/';

function defaultGit(cwd: string, args: string[]): GitCommandResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 40 * 1024 * 1024,
  });
  return { ok: result.status === 0, stdout: result.stdout };
}

function failed(kind: WorkspaceKind, reason: WorkspaceMeasurementReason): WorkspaceSnapshot {
  return { policy: WORKSPACE_MEASUREMENT_POLICY, kind, measurable: false, reason };
}

function portable(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isReviewArtifact(path: string): boolean {
  const normalized = portable(path);
  return normalized === '.agents/reviews' || normalized.startsWith(REVIEW_PREFIX);
}

function isStableNonGitExclusion(path: string, directory: boolean): boolean {
  const normalized = portable(path);
  const parts = normalized.split('/');
  const name = parts.at(-1) ?? '';
  if (normalized === 'handoff.md' || normalized.startsWith('users/') || normalized.startsWith('vault/')) return true;
  if (isReviewArtifact(normalized)) return true;
  if (parts.some((part) => ['.git', 'node_modules', 'dist', 'coverage', '.idea', '.vscode'].includes(part))) return true;
  if (name === '.DS_Store' || name.endsWith('.tsbuildinfo') || name.endsWith('.swp') || name.endsWith('~')) return true;
  return directory && normalized === '.agents/reviews';
}

function internalSymlink(root: string, path: string): { ok: true; target: string } | { ok: false } {
  try {
    const targetText = readlinkSync(path);
    const target = resolve(path, '..', targetText);
    const rootReal = realpathSync(root);
    const targetReal = realpathSync(target);
    const relation = relative(rootReal, targetReal);
    if (relation.startsWith('..') || isAbsolute(relation)) return { ok: false };
    return { ok: true, target: targetText };
  } catch {
    return { ok: false };
  }
}

function stableFileBytes(path: string): Buffer | undefined {
  const before = statSync(path);
  const content = readFileSync(path);
  const after = statSync(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || content.length !== after.size) return undefined;
  return content;
}

function measureGit(cwd: string, options: WorkspaceMeasurementOptions): WorkspaceSnapshot {
  const git = options.git ?? defaultGit;
  const headBefore = git(cwd, ['rev-parse', 'HEAD']);
  const branchBefore = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const diff = git(cwd, ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).agents/reviews/**']);
  const tracked = git(cwd, ['ls-files', '-z']);
  const trackedStages = git(cwd, ['ls-files', '-s', '-z']);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (![headBefore, status, diff, tracked, trackedStages, untracked].every((result) => result.ok)) {
    return failed('git', 'git_command_failed');
  }

  const trackedPaths = tracked.stdout.split('\0').filter(Boolean).filter((path) => !isReviewArtifact(path));
  const untrackedPaths = untracked.stdout.split('\0').filter(Boolean).filter((path) => !isReviewArtifact(path));
  if ([...trackedPaths, ...untrackedPaths].some(isSensitiveWorkspacePath)) return failed('git', 'sensitive_path');

  const symlinks = trackedStages.stdout.split('\0').filter(Boolean).flatMap((entry) => {
    const match = entry.match(/^120000 [0-9a-f]+ \d+\t(.+)$/);
    return match?.[1] && !isReviewArtifact(match[1]) ? [match[1]] : [];
  });

  const hash = createHash('sha256');
  hash.update(WORKSPACE_MEASUREMENT_POLICY);
  hash.update(headBefore.stdout.trim());
  hash.update(branchBefore.ok ? branchBefore.stdout.trim() : '(detached)');
  hash.update(diff.stdout);
  let filesMeasured = 0;
  let bytesHashed = Buffer.byteLength(diff.stdout);

  try {
    for (const path of symlinks) {
      const link = internalSymlink(cwd, resolve(cwd, path));
      if (!link.ok) return failed('git', 'unsafe_symlink');
      hash.update(path);
      hash.update(link.target);
    }
    for (const path of untrackedPaths.sort()) {
      const absolute = resolve(cwd, path);
      const info = lstatSync(absolute);
      filesMeasured += 1;
      hash.update(path);
      if (info.isSymbolicLink()) {
        const link = internalSymlink(cwd, absolute);
        if (!link.ok) return failed('git', 'unsafe_symlink');
        hash.update(link.target);
        continue;
      }
      if (!info.isFile()) return failed('git', 'concurrent_mutation');
      if (info.size > (options.maxUntrackedBytes ?? DEFAULT_GIT_UNTRACKED_MAX_BYTES)) {
        return failed('git', 'entry_too_large');
      }
      const content = stableFileBytes(absolute);
      if (!content) return failed('git', 'concurrent_mutation');
      bytesHashed += content.length;
      hash.update(content);
    }
  } catch (error) {
    return failed('git', (error as NodeJS.ErrnoException).code === 'EACCES' ? 'permission_denied' : 'concurrent_mutation');
  }

  const headAfter = git(cwd, ['rev-parse', 'HEAD']);
  const branchAfter = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!headAfter.ok || headAfter.stdout !== headBefore.stdout || branchAfter.ok !== branchBefore.ok || branchAfter.stdout !== branchBefore.stdout) {
    return failed('git', 'repository_changed_during_measurement');
  }

  const relevantStatus = status.stdout.split('\0').filter(Boolean).filter((entry) => {
    const path = entry.length > 3 ? entry.slice(3) : entry;
    return !isReviewArtifact(path);
  });
  hash.update(relevantStatus.join('\0'));
  return {
    policy: WORKSPACE_MEASUREMENT_POLICY,
    kind: 'git',
    measurable: true,
    fingerprint: hash.digest('hex'),
    filesMeasured,
    bytesHashed,
  };
}

function measureNonGit(cwd: string, options: WorkspaceMeasurementOptions): WorkspaceSnapshot {
  const maxFiles = options.maxFiles ?? DEFAULT_NON_GIT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_NON_GIT_MAX_BYTES;
  const hash = createHash('sha256');
  hash.update(WORKSPACE_MEASUREMENT_POLICY);
  let filesMeasured = 0;
  let bytesHashed = 0;

  const walk = (directory: string): WorkspaceSnapshot | undefined => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      return failed('non_git', (error as NodeJS.ErrnoException).code === 'EACCES' ? 'permission_denied' : 'workspace_unavailable');
    }
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const path = portable(relative(cwd, absolute));
      if (isStableNonGitExclusion(path, entry.isDirectory())) continue;
      if (isSensitiveWorkspacePath(path)) return failed('non_git', 'sensitive_path');
      let info;
      try {
        info = lstatSync(absolute);
      } catch (error) {
        return failed('non_git', (error as NodeJS.ErrnoException).code === 'EACCES' ? 'permission_denied' : 'concurrent_mutation');
      }
      if (info.isSymbolicLink()) {
        hash.update(path);
        hash.update(String(info.mode));
        filesMeasured += 1;
        const link = internalSymlink(cwd, absolute);
        if (!link.ok) return failed('non_git', 'unsafe_symlink');
        hash.update(link.target);
      } else if (info.isDirectory()) {
        if (path !== '.agents') {
          hash.update(path);
          hash.update(String(info.mode));
        }
        const failure = walk(absolute);
        if (failure) return failure;
      } else if (info.isFile()) {
        hash.update(path);
        hash.update(String(info.mode));
        filesMeasured += 1;
        if (filesMeasured > maxFiles || bytesHashed + info.size > maxTotalBytes) {
          return failed('non_git', 'scan_budget_exceeded');
        }
        try {
          const content = stableFileBytes(absolute);
          if (!content) return failed('non_git', 'concurrent_mutation');
          bytesHashed += content.length;
          hash.update(content);
        } catch (error) {
          return failed('non_git', (error as NodeJS.ErrnoException).code === 'EACCES' ? 'permission_denied' : 'concurrent_mutation');
        }
      } else {
        return failed('non_git', 'concurrent_mutation');
      }
      if (filesMeasured > maxFiles) return failed('non_git', 'scan_budget_exceeded');
    }
    return undefined;
  };

  try {
    if (!statSync(cwd).isDirectory()) return failed('unknown', 'workspace_unavailable');
  } catch {
    return failed('unknown', 'workspace_unavailable');
  }
  const failure = walk(cwd);
  if (failure) return failure;
  return {
    policy: WORKSPACE_MEASUREMENT_POLICY,
    kind: 'non_git',
    measurable: true,
    fingerprint: hash.digest('hex'),
    filesMeasured,
    bytesHashed,
  };
}

export function measureWorkspace(cwd: string, options: WorkspaceMeasurementOptions = {}): WorkspaceSnapshot {
  const git = options.git ?? defaultGit;
  const probe = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (probe.ok && probe.stdout.trim() === 'true') return measureGit(cwd, options);
  try {
    if (lstatSync(resolve(cwd, '.git'))) return failed('git', 'git_command_failed');
  } catch {
    // No repository metadata: bounded non-Git measurement applies.
  }
  return measureNonGit(cwd, options);
}

export function classifyWorkspaceChange(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChangeEvidence {
  if (before.policy !== after.policy) return { state: 'unmeasurable', before, after: { ...after, measurable: false, reason: 'policy_mismatch' } };
  if (!before.measurable || !after.measurable || !before.fingerprint || !after.fingerprint) {
    return { state: 'unmeasurable', before, after };
  }
  return { state: before.fingerprint === after.fingerprint ? 'unchanged' : 'changed', before, after };
}

export function legacyFingerprintSnapshot(fingerprint: string | undefined): WorkspaceSnapshot {
  return fingerprint === undefined
    ? failed('unknown', 'workspace_unavailable')
    : { policy: WORKSPACE_MEASUREMENT_POLICY, kind: 'unknown', measurable: true, fingerprint };
}
