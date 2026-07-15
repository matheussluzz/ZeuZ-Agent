import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { currentBranch, gitDiff, isGitRepository, switchBranch, workspaceFingerprint } from '../src/git.js';

test('tracks Git fingerprints, diffs, and safe branch creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-git-test-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'ZeuZ Test'], { cwd: root });
    await writeFile(join(root, 'file.txt'), 'one\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });

    assert.equal(isGitRepository(root), true);
    const before = workspaceFingerprint(root);
    await writeFile(join(root, 'file.txt'), 'two\n');
    const after = workspaceFingerprint(root);
    assert.notEqual(before, after);
    assert.match(gitDiff(root), /-one/);
    assert.match(gitDiff(root), /\+two/);

    assert.match(switchBranch(root, 'agent/test'), /Created/);
    assert.equal(currentBranch(root), 'agent/test');
    assert.throws(() => switchBranch(root, '../unsafe'), /Invalid branch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
