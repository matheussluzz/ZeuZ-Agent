import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { WorkspaceContextManager } from '../src/context.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

test('workspace bootstrap is private and non-destructive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-context-'));
  roots.push(root);
  await writeFile(join(root, 'AGENTS.md'), '# Local contract\n');

  const manager = new WorkspaceContextManager();
  const first = await manager.initialize(root, 'Matheus Luz', {
    useCase: 'data',
    objective: 'Reduce query scan cost',
    context: 'Athena datasets',
    proficiency: 'intermediate',
    teachingPreference: 'Explain unfamiliar AWS controls',
    autonomyPreference: 'Pause before paid queries',
  });

  assert.equal(first.userSlug, 'matheus-luz');
  assert.equal(first.onboardingRequired, false);
  assert.ok(first.files.includes('AGENTS.md'));
  assert.ok(first.files.includes('users/matheus-luz.md'));
  assert.match(first.context, /Reduce query scan cost/);
  assert.equal((await stat(join(root, 'users', 'matheus-luz.md'))).mode & 0o077, 0);

  await writeFile(join(root, 'vault', 'Home.md'), '# User-owned Home\n');
  await manager.initialize(root, 'Matheus Luz', {
    useCase: 'product',
    objective: 'Must not overwrite',
    context: 'ignored',
    proficiency: 'advanced',
    teachingPreference: 'compact',
    autonomyPreference: 'high',
  });
  assert.equal(await readFile(join(root, 'vault', 'Home.md'), 'utf8'), '# User-owned Home\n');
  assert.doesNotMatch(await readFile(join(root, 'users', 'matheus-luz.md'), 'utf8'), /Must not overwrite/);
});
