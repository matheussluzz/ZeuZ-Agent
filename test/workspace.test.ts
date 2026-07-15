import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { classifyWorkspaceChange, measureWorkspace } from '../src/workspace.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function gitRoot(): Promise<string> {
  const cwd = await root('zeuz-workspace-git-');
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  git(cwd, 'config', 'user.name', 'ZeuZ Fixture');
  await writeFile(join(cwd, 'tracked.txt'), 'one\n');
  git(cwd, 'add', 'tracked.txt');
  git(cwd, 'commit', '-qm', 'fixture');
  return cwd;
}

test('non-Git snapshots classify unchanged, create, modify, and remove explicitly', async () => {
  const cwd = await root('zeuz-workspace-nongit-');
  await writeFile(join(cwd, 'a.txt'), 'one');
  const initial = measureWorkspace(cwd);
  assert.equal(classifyWorkspaceChange(initial, measureWorkspace(cwd)).state, 'unchanged');

  await writeFile(join(cwd, 'b.txt'), 'created');
  const created = measureWorkspace(cwd);
  assert.equal(classifyWorkspaceChange(initial, created).state, 'changed');

  await writeFile(join(cwd, 'a.txt'), 'two');
  const modified = measureWorkspace(cwd);
  assert.equal(classifyWorkspaceChange(created, modified).state, 'changed');

  await rm(join(cwd, 'b.txt'));
  assert.equal(classifyWorkspaceChange(modified, measureWorkspace(cwd)).state, 'changed');
});

test('non-Git stable exclusions do not create false workspace changes', async () => {
  const cwd = await root('zeuz-workspace-excluded-');
  await writeFile(join(cwd, 'source.txt'), 'stable');
  const before = measureWorkspace(cwd);
  await mkdir(join(cwd, '.agents/reviews'), { recursive: true });
  await writeFile(join(cwd, '.agents/reviews/report.json'), 'review metadata');
  await writeFile(join(cwd, 'handoff.md'), 'private continuity');
  await mkdir(join(cwd, 'dist'));
  await writeFile(join(cwd, 'dist/output.js'), 'generated');
  assert.equal(classifyWorkspaceChange(before, measureWorkspace(cwd)).state, 'unchanged');
});

test('non-Git sensitive paths, external symlinks, and scan overshoot are unmeasurable', async () => {
  const sensitive = await root('zeuz-workspace-sensitive-');
  await writeFile(join(sensitive, 'credentials.json'), '{}');
  assert.equal(measureWorkspace(sensitive).reason, 'sensitive_path');

  const linked = await root('zeuz-workspace-linked-');
  const outside = await root('zeuz-workspace-outside-');
  await writeFile(join(outside, 'outside.txt'), 'outside');
  await symlink(join(outside, 'outside.txt'), join(linked, 'escape'));
  assert.equal(measureWorkspace(linked).reason, 'unsafe_symlink');

  const large = await root('zeuz-workspace-large-');
  await writeFile(join(large, 'large.txt'), '12345');
  assert.equal(measureWorkspace(large, { maxTotalBytes: 4 }).reason, 'scan_budget_exceeded');
});

test('non-Git internal symlinks are stable evidence without target traversal', async () => {
  const cwd = await root('zeuz-workspace-internal-link-');
  await writeFile(join(cwd, 'target.txt'), 'target');
  await symlink('target.txt', join(cwd, 'link.txt'));
  const before = measureWorkspace(cwd);
  assert.equal(before.measurable, true);
  assert.equal(classifyWorkspaceChange(before, measureWorkspace(cwd)).state, 'unchanged');
});

test('Git snapshots observe tracked, staged, untracked, branch, and HEAD changes', async () => {
  const cwd = await gitRoot();
  const clean = measureWorkspace(cwd);
  assert.equal(clean.kind, 'git');
  assert.equal(classifyWorkspaceChange(clean, measureWorkspace(cwd)).state, 'unchanged');

  await writeFile(join(cwd, 'tracked.txt'), 'two\n');
  const unstaged = measureWorkspace(cwd);
  assert.equal(classifyWorkspaceChange(clean, unstaged).state, 'changed');

  git(cwd, 'add', 'tracked.txt');
  const staged = measureWorkspace(cwd);
  assert.equal(classifyWorkspaceChange(clean, staged).state, 'changed');

  await writeFile(join(cwd, 'untracked.txt'), 'new');
  const untracked = measureWorkspace(cwd);
  assert.equal(classifyWorkspaceChange(staged, untracked).state, 'changed');

  git(cwd, 'commit', '-qm', 'second');
  git(cwd, 'switch', '-qc', 'fixture-branch');
  const branch = measureWorkspace(cwd);
  assert.equal(classifyWorkspaceChange(untracked, branch).state, 'changed');
});

test('Git review artifacts are excluded but other .agents content is measured', async () => {
  const cwd = await gitRoot();
  const before = measureWorkspace(cwd);
  await mkdir(join(cwd, '.agents/reviews'), { recursive: true });
  await writeFile(join(cwd, '.agents/reviews/report.json'), '{}');
  assert.equal(classifyWorkspaceChange(before, measureWorkspace(cwd)).state, 'unchanged');
  await writeFile(join(cwd, '.agents/config.txt'), 'measured');
  assert.equal(classifyWorkspaceChange(before, measureWorkspace(cwd)).state, 'changed');
});

test('Git oversized untracked files and command failure are unmeasurable', async () => {
  const cwd = await gitRoot();
  await writeFile(join(cwd, 'large.bin'), '12345');
  assert.equal(measureWorkspace(cwd, { maxUntrackedBytes: 4 }).reason, 'entry_too_large');

  const failed = measureWorkspace(cwd, { git: () => ({ ok: false, stdout: '' }) });
  assert.equal(failed.kind, 'git');
  assert.equal(failed.reason, 'git_command_failed');
});

test('Git sensitive tracked paths and escaping symlinks fail closed', async () => {
  const sensitive = await gitRoot();
  await writeFile(join(sensitive, 'private.key'), 'fixture');
  git(sensitive, 'add', 'private.key');
  assert.equal(measureWorkspace(sensitive).reason, 'sensitive_path');

  const linked = await gitRoot();
  const outside = await root('zeuz-workspace-git-outside-');
  await writeFile(join(outside, 'outside.txt'), 'outside');
  await symlink(join(outside, 'outside.txt'), join(linked, 'escape'));
  git(linked, 'add', 'escape');
  assert.equal(measureWorkspace(linked).reason, 'unsafe_symlink');
});
