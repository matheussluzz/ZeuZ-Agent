import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { WorktreeManager, inspectGitPreflight } from '../src/worktree-manager.js';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-worktree-repo-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);
  await writeFile(join(root, 'file.txt'), 'one\n');
  git(root, ['add', 'file.txt']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

test('Git preflight distinguishes clean no-upstream and dirty states', async () => {
  const root = await repository();
  try {
    const clean = inspectGitPreflight(root);
    assert.equal(clean.allowed, true);
    assert.deepEqual(clean.states, ['no_upstream']);
    await writeFile(join(root, 'file.txt'), 'two\n');
    const dirty = inspectGitPreflight(root);
    assert.equal(dirty.allowed, false);
    assert.equal(dirty.states.includes('unstaged'), true);
    await writeFile(join(root, 'untracked.txt'), 'new\n');
    assert.equal(inspectGitPreflight(root).states.includes('untracked'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Git preflight rejects executable filters and branch collisions', async () => {
  const root = await repository();
  try {
    git(root, ['config', 'filter.danger.clean', 'false']);
    assert.equal(inspectGitPreflight(root).states.includes('unsafe_git_config'), true);
    git(root, ['config', '--unset', 'filter.danger.clean']);
    git(root, ['branch', 'zeuz/task-collision']);
    assert.equal(inspectGitPreflight(root, 'zeuz/task-collision').states.includes('branch_collision'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('editing task creates a distinct owner-only managed worktree without merging', async () => {
  const root = await repository();
  const state = await mkdtemp(join(tmpdir(), 'zeuz-worktree-state-'));
  let executionWorkspace: string | undefined;
  try {
    const manager = new WorktreeManager(state);
    const managed = await manager.create('task-123', root);
    executionWorkspace = managed.executionWorkspace;
    assert.notEqual(managed.executionWorkspace, root);
    assert.equal(git(managed.executionWorkspace, ['branch', '--show-current']), 'zeuz/task-task-123');
    assert.equal(git(root, ['rev-parse', 'HEAD']), managed.baseCommit);
    assert.equal(git(root, ['show-ref', '--verify', '--quiet', 'refs/heads/zeuz/task-task-123']), '');
    assert.equal(git(root, ['status', '--porcelain']), '');
    assert.equal((await manager.reuse('task-123', root, managed.executionWorkspace, managed.repositoryIdentity, managed.baseCommit)).executionWorkspace, managed.executionWorkspace);
    await writeFile(join(managed.executionWorkspace, 'file.txt'), 'changed\n');
    await assert.rejects(() => manager.reuse('task-123', root, managed.executionWorkspace, managed.repositoryIdentity, managed.baseCommit), /no longer clean/i);
  } finally {
    if (executionWorkspace) {
      git(root, ['worktree', 'remove', '--force', executionWorkspace]);
      git(root, ['branch', '-D', 'zeuz/task-task-123']);
    }
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('editing task rejects a pre-existing symlink destination before invoking Git worktree add', async () => {
  const root = await repository();
  const state = await mkdtemp(join(tmpdir(), 'zeuz-worktree-symlink-state-'));
  const outside = await mkdtemp(join(tmpdir(), 'zeuz-worktree-symlink-outside-'));
  try {
    await (await import('node:fs/promises')).mkdir(join(state, 'worktrees'), { mode: 0o700 });
    await symlink(outside, join(state, 'worktrees', 'symlink-task'));
    await assert.rejects(() => new WorktreeManager(state).create('symlink-task', root), /preflight blocked|destination already exists/i);
    assert.equal(git(root, ['branch', '--list', 'zeuz/task-symlink-task']), '');
  } finally { await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('Git preflight classifies synced, ahead, behind, diverged, detached, unborn, and existing worktree', async () => {
  const root = await repository();
  const fixture = await mkdtemp(join(tmpdir(), 'zeuz-worktree-matrix-'));
  const bare = join(fixture, 'remote.git');
  const other = join(fixture, 'other');
  const existing = join(fixture, 'existing-worktree');
  try {
    const originalBranch = git(root, ['branch', '--show-current']);
    git(fixture, ['init', '--bare', bare]);
    git(root, ['remote', 'add', 'origin', bare]);
    git(root, ['push', '-u', 'origin', 'HEAD']);
    git(fixture, ['--git-dir', bare, 'symbolic-ref', 'HEAD', `refs/heads/${originalBranch}`]);
    assert.equal(inspectGitPreflight(root).states.includes('clean_synced'), true);
    await writeFile(join(root, 'ahead.txt'), 'ahead\n');
    git(root, ['add', 'ahead.txt']);
    git(root, ['commit', '-m', 'ahead']);
    assert.equal(inspectGitPreflight(root).states.includes('clean_ahead'), true);
    git(root, ['push']);

    git(fixture, ['clone', bare, other]);
    git(other, ['config', 'user.email', 'fixture@example.invalid']);
    git(other, ['config', 'user.name', 'Fixture']);
    await writeFile(join(other, 'behind.txt'), 'behind\n');
    git(other, ['add', 'behind.txt']);
    git(other, ['commit', '-m', 'remote']);
    git(other, ['push']);
    git(root, ['fetch', 'origin']);
    assert.equal(inspectGitPreflight(root).states.includes('behind'), true);
    await writeFile(join(root, 'diverged.txt'), 'diverged\n');
    git(root, ['add', 'diverged.txt']);
    git(root, ['commit', '-m', 'diverged']);
    assert.equal(inspectGitPreflight(root).states.includes('diverged'), true);
    git(root, ['checkout', '--detach']);
    assert.equal(inspectGitPreflight(root).states.includes('detached'), true);

    const unborn = await mkdtemp(join(tmpdir(), 'zeuz-worktree-unborn-'));
    try { git(unborn, ['init']); assert.equal(inspectGitPreflight(unborn).states.includes('unborn'), true); }
    finally { await rm(unborn, { recursive: true, force: true }); }

    git(root, ['checkout', '-B', 'matrix-clean', `origin/${originalBranch}`]);
    git(root, ['worktree', 'add', existing, '-b', 'existing-branch']);
    assert.equal(inspectGitPreflight(root, undefined, existing).states.includes('worktree_exists'), true);
  } finally {
    spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', existing], { encoding: 'utf8' });
    await rm(root, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});
