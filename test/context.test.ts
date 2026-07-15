import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { MAX_HANDOFF_CHARACTERS, WorkspaceContextManager } from '../src/context.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

test('workspace bootstrap is private and non-destructive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-context-'));
  roots.push(root);
  await writeFile(join(root, 'AGENTS.md'), '# Local contract\n');
  await writeFile(join(root, '.gitignore'), '/handoff.md\n');

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
  assert.ok(first.files.includes('handoff.md'));
  assert.match(first.context, /Reduce query scan cost/);
  assert.equal((await stat(join(root, 'users', 'matheus-luz.md'))).mode & 0o077, 0);
  assert.equal((await stat(join(root, 'handoff.md'))).mode & 0o077, 0);

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

test('handoff is loaded in bootstrap order and bounded conservatively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-handoff-'));
  roots.push(root);
  await writeFile(join(root, '.gitignore'), '/handoff.md\n');
  await writeFile(join(root, 'AGENTS.md'), '# Contract marker\n');
  await writeFile(join(root, 'handoff.md'), `# Latest demand marker\n\n${'x'.repeat(MAX_HANDOFF_CHARACTERS + 500)}`, { mode: 0o600 });

  const loaded = await new WorkspaceContextManager().load(root, 'tester');

  assert.ok(loaded.files.includes('handoff.md'));
  assert.ok(loaded.context.indexOf('## AGENTS.md') < loaded.context.indexOf('## handoff.md'));
  assert.match(loaded.context, /Latest demand marker/);
  assert.match(loaded.context, /context truncated/);
  assert.ok(loaded.warnings.some((warning) => warning.includes('12,000-character bootstrap ceiling')));
});

test('handoff must be a private regular file', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-handoff-private-'));
  roots.push(root);
  await writeFile(join(root, '.gitignore'), '/handoff.md\n');
  await writeFile(join(root, 'handoff.md'), '# Must not load\n', { mode: 0o644 });

  const loaded = await new WorkspaceContextManager().load(root, 'tester');

  assert.equal(loaded.files.includes('handoff.md'), false);
  assert.doesNotMatch(loaded.context, /Must not load/);
  assert.ok(loaded.warnings.some((warning) => warning.includes('chmod 600 handoff.md')));
});

test('read-only bootstrap never creates handoff state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-handoff-plan-'));
  roots.push(root);
  await writeFile(join(root, '.gitignore'), '/handoff.md\n');

  const loaded = await new WorkspaceContextManager().load(root, 'tester');

  await assert.rejects(async () => await readFile(join(root, 'handoff.md'), 'utf8'), { code: 'ENOENT' });
  assert.equal(loaded.files.includes('handoff.md'), false);
});

test('writable host updates keep one bounded redacted latest-turn block', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-handoff-update-'));
  roots.push(root);
  await writeFile(join(root, '.gitignore'), '/handoff.md\n/.handoff.*.tmp\n');
  const manager = new WorkspaceContextManager();
  await manager.load(root, 'tester', { initializeHandoff: true });

  const tokenFixture = ['nvapi', 'fixture-value-123456789'].join('-');
  await manager.updateHandoff(root, {
    latestDemand: `Review the roadmap with ${tokenFixture}`,
    modelId: 'codex:test',
    status: 'in_progress',
  });
  await manager.updateHandoff(root, {
    latestDemand: `Review the roadmap with ${tokenFixture}`,
    modelId: 'codex:test',
    status: 'completed',
    changedWorkspace: false,
    reviewVerdict: 'PASS',
  });

  const content = await readFile(join(root, 'handoff.md'), 'utf8');
  assert.equal(content.match(/zeuz:latest-turn:start/g)?.length, 1);
  assert.match(content, /Status: completed/);
  assert.match(content, /Adversarial review: PASS/);
  assert.match(content, /Durable requirements and decisions/);
  assert.doesNotMatch(content, /nvapi-/);
  assert.ok(content.length <= MAX_HANDOFF_CHARACTERS);
  assert.equal((await stat(join(root, 'handoff.md'))).mode & 0o077, 0);
});
