import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MaintenanceStore } from '../src/maintenance-store.js';
import { makeMessage, SessionStore } from '../src/session-store.js';

test('persists, loads, lists, and forks sessions without native provider state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-session-test-'));
  const previous = process.env.ZEUZ_STATE_DIR;
  process.env.ZEUZ_STATE_DIR = root;
  try {
    const store = new SessionStore();
    const session = await store.create('/tmp/example', { title: 'Example' });
    session.summary = 'Durable summary';
    session.providerSessions['codex:gpt-5.6-sol@medium'] = 'native-id';
    session.messages.push(makeMessage('user', 'hello'));
    await store.save(session);

    const loaded = await store.load(session.id.slice(0, 8));
    assert.equal(loaded.title, 'Example');
    assert.equal(loaded.messages[0]?.content, 'hello');
    assert.equal((await store.list())[0]?.id, session.id);

    const fork = await store.fork(loaded, 'Forked');
    assert.equal(fork.parentId, session.id);
    assert.equal(fork.summary, 'Durable summary');
    assert.deepEqual(fork.providerSessions, {});
    assert.notEqual(fork.messages[0]?.id, loaded.messages[0]?.id);

    const serialized = await readFile(join(root, 'sessions', `${fork.id}.json`), 'utf8');
    assert.match(serialized, /Forked/);
  } finally {
    if (previous === undefined) delete process.env.ZEUZ_STATE_DIR;
    else process.env.ZEUZ_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('migrates legacy v0 sessions with backup and reports quarantine/future diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-session-migration-'));
  try {
    const store = new SessionStore({ root });
    await store.initialize();
    const now = new Date().toISOString();
    const legacy = {
      id: 'legacy-session', title: 'Legacy', cwd: '/synthetic', activeModelId: 'codex:gpt-5.6-sol@medium', permissionMode: 'plan',
      createdAt: now, updatedAt: now, messages: [], providerSessions: {},
    };
    await writeFile(join(root, 'sessions', 'legacy-session.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    await writeFile(join(root, 'sessions', 'broken.json'), '{"id":', { mode: 0o600 });
    await writeFile(join(root, 'sessions', 'mismatch.json'), `${JSON.stringify({ ...legacy, id: 'mismatch', schemaVersion: 1, revision: 0, surprise: true })}\n`, { mode: 0o600 });
    await writeFile(join(root, 'sessions', 'future.json'), `${JSON.stringify({ ...legacy, id: 'future', schemaVersion: 2, revision: 0 })}\n`, { mode: 0o600 });
    const beforeMigration = await store.listDetailed();
    assert.equal(beforeMigration.records.some((session) => session.id === 'legacy-session'), true);
    assert.equal(beforeMigration.diagnostics.some((item) => item.code === 'LEGACY_STATE_READ_ONLY'), true);
    assert.equal(beforeMigration.diagnostics.some((item) => item.code === 'STATE_JSON_INVALID' && item.quarantined), true);
    assert.equal(beforeMigration.diagnostics.some((item) => item.record === 'mismatch.json' && item.code === 'STATE_SCHEMA_MISMATCH' && item.quarantined), true);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(join(root, 'sessions', 'legacy-session.json'), 'utf8')), 'schemaVersion'), false);
    const maintenance = new MaintenanceStore(root);
    await maintenance.enter('test_migration');
    const listed = await store.migrateRecordsInMaintenance();
    await maintenance.exit();
    assert.equal(listed.records.find((session) => session.id === 'legacy-session')?.schemaVersion, 1);
    assert.equal(listed.diagnostics.some((item) => item.code === 'LEGACY_STATE_MIGRATED'), true);
    assert.equal(listed.diagnostics.some((item) => item.code === 'UNSUPPORTED_STATE_VERSION' && !item.quarantined), true);
    assert.equal((await readdir(join(root, 'sessions'))).includes('future.json'), true);
    assert.equal((await readdir(join(root, 'backups', 'sessions'))).some((file) => file.endsWith('.v0.json')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SessionStore save uses revision CAS against stale snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-session-cas-'));
  try {
    const store = new SessionStore({ root });
    const created = await store.create('/synthetic');
    const left = structuredClone(created);
    const right = structuredClone(created);
    left.title = 'Left';
    right.title = 'Right';
    await store.save(left);
    await assert.rejects(() => store.save(right), /revision is stale/);
    assert.equal((await store.load(created.id)).title, 'Left');
  } finally { await rm(root, { recursive: true, force: true }); }
});
