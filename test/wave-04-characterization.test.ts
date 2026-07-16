import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TaskStore } from '../src/task-store.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('[wave04 characterization transition] committed v0 task remains importable through backed migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-wave04-transition-'));
  try {
    let id = 0;
    const runtime = { now: () => '2026-01-02T03:04:05.000Z', nowMs: () => Date.parse('2026-01-02T03:04:05.000Z'), newId: () => `transition-${++id}`, fingerprint: () => 'fingerprint' };
    const store = new TaskStore({ root, runtime });
    await store.initialize();
    const legacy = {
      id: 'legacy-task', modelId: 'codex:gpt-5.6-luna@high', prompt: 'legacy', cwd: '/synthetic', mode: 'plan', status: 'completed',
      createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-01-02T03:04:05.000Z', resultPreview: 'not a full result',
    };
    await writeFile(join(root, 'tasks', 'legacy-task.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const migrated = await store.migrateAll();
    assert.equal(migrated.records[0]?.schemaVersion, 1);
    assert.equal(migrated.records[0]?.status, 'blocked');
    assert.equal(migrated.records[0]?.blockedCode, 'LEGACY_RESULT_UNAVAILABLE');
    assert.equal((await readdir(join(root, 'backups', 'tasks'))).some((file) => file.endsWith('.v0.json')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('[wave04 characterization transition] CLI no longer contains the blocking preview/lock writer', () => {
  const cli = readFileSync(join(repositoryRoot, 'src', 'cli.tsx'), 'utf8');
  const store = readFileSync(join(repositoryRoot, 'src', 'task-store.ts'), 'utf8');
  assert.doesNotMatch(cli, /resultPreview|acquireSlot/);
  assert.match(cli, /new TaskEngine\(\)/);
  assert.match(cli, /flags\.has\('--wait'\)/);
  assert.match(cli, /command === 'task'/);
  assert.doesNotMatch(store, /delegate-\$\{slot\}\.lock|STALE_LOCK_MS/);
});
