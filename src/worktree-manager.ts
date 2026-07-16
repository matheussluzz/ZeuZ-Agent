import { existsSync, realpathSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { sanitizedChildEnvironment } from './env.js';
import { ensurePrivateStateDirectory, ensureStateContainerDirectory } from './state-policy.js';

export type GitPreflightState =
  | 'clean_synced'
  | 'clean_ahead'
  | 'no_upstream'
  | 'staged'
  | 'unstaged'
  | 'untracked'
  | 'behind'
  | 'diverged'
  | 'detached'
  | 'unborn'
  | 'branch_collision'
  | 'worktree_exists'
  | 'unsafe_git_config';

export interface GitPreflight {
  workspace: string;
  repositoryIdentity: string;
  baseCommit?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  states: GitPreflightState[];
  allowed: boolean;
}

export interface GitCommandResult { ok: boolean; stdout: string; stderr: string }
export type GitRunner = (cwd: string, args: string[]) => GitCommandResult;

export class WorktreeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

export function sanitizedGitRunner(cwd: string, args: string[]): GitCommandResult {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never', ...args], {
    cwd,
    env: sanitizedChildEnvironment({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' }),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

function required(runner: GitRunner, cwd: string, args: string[], code: string): string {
  const result = runner(cwd, args);
  if (!result.ok) throw new WorktreeError(code, 'Git preflight command failed.');
  return result.stdout.trim();
}

export function inspectGitPreflight(cwd: string, targetBranch?: string, targetWorktree?: string, runner: GitRunner = sanitizedGitRunner): GitPreflight {
  const workspace = realpathSync(cwd);
  const top = required(runner, workspace, ['rev-parse', '--show-toplevel'], 'NOT_GIT_REPOSITORY');
  if (realpathSync(top) !== workspace) throw new WorktreeError('WORKSPACE_NOT_REPOSITORY_ROOT', 'Editing isolation requires the repository root.');
  const commonText = required(runner, workspace, ['rev-parse', '--git-common-dir'], 'GIT_IDENTITY_UNAVAILABLE');
  const common = realpathSync(resolve(workspace, commonText));
  const head = runner(workspace, ['rev-parse', '--verify', 'HEAD']);
  const branchResult = runner(workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const statusResult = runner(workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!statusResult.ok) throw new WorktreeError('GIT_STATUS_FAILED', 'Git preflight command failed.');
  const status = statusResult.stdout.replace(/\n$/, '');
  const states: GitPreflightState[] = [];
  if (!head.ok) states.push('unborn');
  if (!branchResult.ok && head.ok) states.push('detached');
  for (const line of status.split('\n').filter(Boolean)) {
    if (line.startsWith('??')) states.push('untracked');
    else {
      if (line[0] && line[0] !== ' ') states.push('staged');
      if (line[1] && line[1] !== ' ') states.push('unstaged');
    }
  }
  const dangerous = runner(workspace, ['config', '--local', '--get-regexp', '^(filter\\..*\\.(clean|smudge|process)|core\\.fsmonitor)$']);
  if (dangerous.ok && dangerous.stdout.trim()) states.push('unsafe_git_config');
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const upstreamResult = runner(workspace, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!upstreamResult.ok) states.push('no_upstream');
  else {
    upstream = upstreamResult.stdout.trim();
    const counts = required(runner, workspace, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], 'GIT_UPSTREAM_FAILED').split(/\s+/).map(Number);
    ahead = counts[0] ?? 0;
    behind = counts[1] ?? 0;
    if (ahead > 0 && behind > 0) states.push('diverged');
    else if (behind > 0) states.push('behind');
    else if (ahead > 0) states.push('clean_ahead');
    else states.push('clean_synced');
  }
  if (targetBranch && runner(workspace, ['show-ref', '--verify', '--quiet', `refs/heads/${targetBranch}`]).ok) states.push('branch_collision');
  if (targetWorktree) {
    let actualTarget: string;
    try { actualTarget = realpathSync(targetWorktree); } catch { actualTarget = resolve(targetWorktree); }
    const list = required(runner, workspace, ['worktree', 'list', '--porcelain'], 'GIT_WORKTREE_LIST_FAILED');
    if (existsSync(targetWorktree) || list.split('\n').some((line) => line === `worktree ${actualTarget}`)) states.push('worktree_exists');
  }
  const unique = [...new Set(states)];
  const blocked = new Set<GitPreflightState>(['staged', 'unstaged', 'untracked', 'behind', 'diverged', 'detached', 'unborn', 'branch_collision', 'worktree_exists', 'unsafe_git_config']);
  return {
    workspace,
    repositoryIdentity: common,
    ...(head.ok ? { baseCommit: head.stdout.trim() } : {}),
    ...(branchResult.ok ? { branch: branchResult.stdout.trim() } : {}),
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    states: unique,
    allowed: !unique.some((state) => blocked.has(state)),
  };
}

export interface ManagedWorktree {
  requestedWorkspace: string;
  executionWorkspace: string;
  repositoryIdentity: string;
  baseCommit: string;
  branch: string;
  preflight: GitPreflight;
}

export type ReusedManagedWorktree = Pick<ManagedWorktree, 'requestedWorkspace' | 'executionWorkspace' | 'repositoryIdentity' | 'baseCommit' | 'branch'>;

export class WorktreeManager {
  private readonly stateRoot: string;
  private readonly runner: GitRunner;

  constructor(stateRoot: string, runner: GitRunner = sanitizedGitRunner) {
    this.stateRoot = resolve(stateRoot);
    this.runner = runner;
  }

  async create(taskId: string, workspace: string, explicitBase?: string): Promise<ManagedWorktree> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(taskId)) throw new WorktreeError('INVALID_TASK_ID', 'Task ID is unsafe for worktree creation.');
    const root = await ensureStateContainerDirectory(this.stateRoot);
    const worktrees = await ensurePrivateStateDirectory(join(root, 'worktrees'), root);
    const branch = `zeuz/task-${taskId.slice(0, 48)}`;
    const executionWorkspace = join(worktrees, taskId);
    const preflight = inspectGitPreflight(workspace, branch, executionWorkspace, this.runner);
    if (!preflight.allowed) throw new WorktreeError('GIT_PREFLIGHT_BLOCKED', `Git preflight blocked: ${preflight.states.join(', ')}.`);
    const baseCommit = explicitBase ?? preflight.baseCommit;
    if (!baseCommit) throw new WorktreeError('GIT_BASE_REQUIRED', 'A base commit is required.');
    try { await mkdir(executionWorkspace, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorktreeError('WORKTREE_DESTINATION_EXISTS', 'Managed worktree destination already exists.'); throw error; }
    const result = this.runner(preflight.workspace, ['worktree', 'add', '-b', branch, executionWorkspace, baseCommit]);
    if (!result.ok) throw new WorktreeError('WORKTREE_CREATE_FAILED', 'Git worktree creation failed.');
    const actual = await realpath(executionWorkspace);
    const relation = relative(worktrees, actual);
    if (relation.startsWith('..') || isAbsolute(relation)) throw new WorktreeError('WORKTREE_ESCAPED_ROOT', 'Managed worktree escaped its root.');
    return { requestedWorkspace: preflight.workspace, executionWorkspace: actual, repositoryIdentity: preflight.repositoryIdentity, baseCommit, branch, preflight };
  }

  async reuse(taskId: string, workspace: string, executionWorkspace: string, repositoryIdentity: string, baseCommit: string): Promise<ReusedManagedWorktree> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(taskId)) throw new WorktreeError('INVALID_TASK_ID', 'Task ID is unsafe for worktree reuse.');
    const root = await ensureStateContainerDirectory(this.stateRoot);
    const worktrees = await ensurePrivateStateDirectory(join(root, 'worktrees'), root);
    const expected = join(worktrees, taskId);
    if (resolve(executionWorkspace) !== expected) throw new WorktreeError('WORKTREE_IDENTITY_MISMATCH', 'Persisted worktree path does not match its task identity.');
    const actual = await realpath(expected);
    const relation = relative(worktrees, actual);
    if (relation.startsWith('..') || isAbsolute(relation)) throw new WorktreeError('WORKTREE_ESCAPED_ROOT', 'Managed worktree escaped its root.');
    const requested = await realpath(workspace);
    const requestedCommonText = required(this.runner, requested, ['rev-parse', '--git-common-dir'], 'GIT_IDENTITY_UNAVAILABLE');
    const actualCommonText = required(this.runner, actual, ['rev-parse', '--git-common-dir'], 'GIT_IDENTITY_UNAVAILABLE');
    const requestedCommon = await realpath(resolve(requested, requestedCommonText));
    const actualCommon = await realpath(resolve(actual, actualCommonText));
    if (requestedCommon !== repositoryIdentity || actualCommon !== repositoryIdentity) throw new WorktreeError('WORKTREE_IDENTITY_MISMATCH', 'Managed worktree repository identity changed.');
    const branch = `zeuz/task-${taskId.slice(0, 48)}`;
    if (required(this.runner, actual, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'WORKTREE_BRANCH_MISMATCH') !== branch) throw new WorktreeError('WORKTREE_BRANCH_MISMATCH', 'Managed worktree branch changed.');
    if (required(this.runner, actual, ['rev-parse', '--verify', 'HEAD'], 'WORKTREE_BASE_MISMATCH') !== baseCommit) throw new WorktreeError('WORKTREE_BASE_MISMATCH', 'Managed worktree base changed.');
    if (required(this.runner, actual, ['status', '--porcelain=v1', '--untracked-files=all'], 'GIT_STATUS_FAILED')) throw new WorktreeError('WORKTREE_CHANGED', 'Managed worktree is no longer clean for safe retry.');
    const dangerous = this.runner(actual, ['config', '--local', '--get-regexp', '^(filter\\..*\\.(clean|smudge|process)|core\\.fsmonitor)$']);
    if (dangerous.ok && dangerous.stdout.trim()) throw new WorktreeError('UNSAFE_GIT_CONFIG', 'Managed worktree Git configuration is unsafe.');
    return { requestedWorkspace: requested, executionWorkspace: actual, repositoryIdentity, baseCommit, branch };
  }
}
