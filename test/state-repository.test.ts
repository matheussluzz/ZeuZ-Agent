import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { StateRepository, StateRepositoryError, assertMigrationManifest, type VersionedStateRecord } from '../src/state-repository.js';

interface FixtureRecord extends VersionedStateRecord { schemaVersion: 1; value: string }

const NOW = '2026-01-02T03:04:05.000Z';

function runtime() {
  let id = 0;
  return { now: () => NOW, nowMs: () => Date.parse(NOW), newId: () => `runtime-${++id}` };
}

function validate(value: unknown): asserts value is FixtureRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('invalid'), { code: 'STATE_SCHEMA_MISMATCH' });
  const item = value as Record<string, unknown>;
  if (typeof item.schemaVersion === 'number' && item.schemaVersion > 1) throw Object.assign(new Error('future'), { code: 'UNSUPPORTED_STATE_VERSION' });
  if (item.schemaVersion !== 1 || !Number.isSafeInteger(item.revision) || typeof item.id !== 'string' || typeof item.value !== 'string') {
    throw Object.assign(new Error('invalid'), { code: 'STATE_SCHEMA_MISMATCH' });
  }
}

function fixture(id: string, value = 'one'): FixtureRecord {
  return { schemaVersion: 1, revision: 0, id, value, createdAt: NOW, updatedAt: NOW };
}

test('state repository provides exclusive create and revision CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-repository-'));
  try {
    const repository = new StateRepository({ root, collection: 'fixtures', runtime: runtime(), validate });
    const created = await repository.create(fixture('record'));
    await assert.rejects(() => repository.create(fixture('record', 'collision')), (error: unknown) => error instanceof StateRepositoryError && error.code === 'STATE_ID_COLLISION');
    const first = await repository.replace({ ...created, value: 'two' }, 0);
    assert.equal(first.revision, 1);
    await assert.rejects(() => repository.replace({ ...created, value: 'stale' }, 0), (error: unknown) => error instanceof StateRepositoryError && error.code === 'STALE_STATE_REVISION');
    assert.equal((await repository.load('record')).value, 'two');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('one repository instance initializes safely under concurrent first use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-concurrent-init-'));
  try {
    const repository = new StateRepository({ root, collection: 'fixtures', runtime: runtime(), validate });
    const records = Array.from({ length: 24 }, (_, index) => fixture(`concurrent-${index}`));
    const created = await Promise.all(records.map(async (item) => await repository.create(item)));
    assert.equal(created.length, records.length);
    assert.deepEqual((await repository.listDetailed()).records.map((item) => item.id).sort(), records.map((item) => item.id).sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two CAS writers with the same revision cannot both win', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-cas-race-'));
  try {
    const repository = new StateRepository({ root, collection: 'fixtures', runtime: runtime(), validate });
    const created = await repository.create(fixture('record'));
    const results = await Promise.allSettled([
      repository.replace({ ...created, value: 'left' }, 0),
      repository.replace({ ...created, value: 'right' }, 0),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy migration creates a verified backup and is idempotently readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-migration-'));
  try {
    const repository = new StateRepository<FixtureRecord>({
      root,
      collection: 'fixtures',
      runtime: runtime(),
      validate,
      importLegacy(value) {
        const legacy = value as { id: string; value: string; createdAt: string; updatedAt: string };
        if (!legacy.id || !legacy.value) throw Object.assign(new Error('invalid legacy'), { code: 'LEGACY_STATE_INVALID' });
        return { schemaVersion: 1, revision: 0, ...legacy };
      },
    });
    await repository.initialize();
    const legacy = `${JSON.stringify({ id: 'legacy', value: 'old', createdAt: NOW, updatedAt: NOW }, null, 2)}\n`;
    await writeFile(join(root, 'fixtures', 'legacy.json'), legacy, { mode: 0o600 });
    const migrated = await repository.migrateAll();
    assert.equal(migrated.records[0]?.schemaVersion, 1);
    assert.equal(migrated.diagnostics[0]?.code, 'LEGACY_STATE_MIGRATED');
    const backups = await readdir(join(root, 'backups', 'fixtures'));
    assert.equal(backups.some((file) => file.endsWith('.v0.json')), true);
    assert.equal(backups.some((file) => file.endsWith('.manifest.json')), true);
    const manifestName = backups.find((file) => file.endsWith('.manifest.json'))!;
    const manifest = JSON.parse(await readFile(join(root, 'backups', 'fixtures', manifestName), 'utf8')) as unknown;
    assert.doesNotThrow(() => assertMigrationManifest(manifest));
    assert.throws(() => assertMigrationManifest({ ...(manifest as object), surprise: true }), /unknown|invalid/i);
    assert.equal((await repository.migrateAll()).records[0]?.value, 'old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent and interrupted migration recovery converges without duplicate replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-migration-race-'));
  try {
    const make = () => new StateRepository<FixtureRecord>({
      root, collection: 'fixtures', runtime: runtime(), validate,
      importLegacy(value) { const legacy = value as { id: string; value: string; createdAt: string; updatedAt: string }; return { schemaVersion: 1, revision: 0, ...legacy }; },
    });
    const first = make();
    await first.initialize();
    const legacy = `${JSON.stringify({ id: 'legacy', value: 'old', createdAt: NOW, updatedAt: NOW }, null, 2)}\n`;
    await writeFile(join(root, 'fixtures', 'legacy.json'), legacy, { mode: 0o600 });
    const [left, right] = await Promise.all([first.migrateAll(), make().migrateAll()]);
    assert.equal(left.records[0]?.schemaVersion, 1);
    assert.equal(right.records[0]?.schemaVersion, 1);
    assert.equal((await readdir(join(root, 'backups', 'fixtures'))).filter((file) => file.endsWith('.v0.json')).length, 1);
    assert.equal((await first.migrateAll()).records[0]?.value, 'old');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corruption is quarantined with safe metadata while future versions remain intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-quarantine-'));
  try {
    const repository = new StateRepository({ root, collection: 'fixtures', runtime: runtime(), validate });
    await repository.initialize();
    await writeFile(join(root, 'fixtures', 'broken.json'), '{"secret":"not returned"', { mode: 0o600 });
    await writeFile(join(root, 'fixtures', 'future.json'), `${JSON.stringify({ ...fixture('future'), schemaVersion: 2 })}\n`, { mode: 0o600 });
    const result = await repository.listDetailed();
    assert.deepEqual(result.diagnostics.map((item) => item.code).sort(), ['STATE_JSON_INVALID', 'UNSUPPORTED_STATE_VERSION']);
    assert.equal(result.diagnostics.find((item) => item.record === 'broken.json')?.quarantined, true);
    assert.equal(result.diagnostics.find((item) => item.record === 'future.json')?.quarantined, false);
    assert.equal((await readdir(join(root, 'fixtures'))).includes('future.json'), true);
    const metadataName = (await readdir(join(root, 'quarantine', 'fixtures'))).find((file) => file.endsWith('.meta.json'));
    assert.ok(metadataName);
    const metadata = await readFile(join(root, 'quarantine', 'fixtures', metadataName), 'utf8');
    assert.doesNotMatch(metadata, /not returned/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('state repository rejects quota overflow and symlinked quarantine boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-quota-'));
  try {
    const repository = new StateRepository({ root, collection: 'fixtures', runtime: runtime(), validate, maxRecordBytes: 180 });
    await assert.rejects(() => repository.create(fixture('large', 'x'.repeat(500))), (error: unknown) => error instanceof StateRepositoryError && error.code === 'STATE_QUOTA_EXCEEDED');
    await repository.initialize();
    await rm(join(root, 'quarantine', 'fixtures'), { recursive: true, force: true });
    await writeFile(join(root, 'outside'), 'outside', { mode: 0o600 });
    await symlink(join(root, 'outside'), join(root, 'quarantine', 'fixtures'));
    const second = new StateRepository({ root, collection: 'fixtures', runtime: runtime(), validate });
    await assert.rejects(() => second.initialize(), /non-symlink directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('injected replace failure preserves current state and leftover temporary recovery is bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-failure-'));
  try {
    const normal = new StateRepository({ root, collection: 'fixtures', runtime: runtime(), validate });
    const created = await normal.create(fixture('record'));
    const failing = new StateRepository({ root, collection: 'fixtures', runtime: runtime(), validate, writeReplace: async () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); } });
    await assert.rejects(() => failing.replace({ ...created, value: 'lost' }, 0), /rename failed/);
    assert.equal((await normal.load('record')).value, 'one');
    await writeFile(join(root, 'fixtures', 'record.synthetic.tmp'), 'temporary', { mode: 0o600 });
    assert.equal(await normal.recoverTemporaryFiles(), 1);
    assert.equal((await readdir(join(root, 'fixtures'))).some((file) => file.endsWith('.tmp')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('record identity mismatch is quarantined and an expired proven-dead mutation lock is recovered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-state-lock-recovery-'));
  try {
    const rt = runtime();
    const repository = new StateRepository({ root, collection: 'fixtures', runtime: rt, validate, lockLeaseMs: 1_000, hostId: 'local', ownerProbe: () => 'dead' });
    const created = await repository.create(fixture('record'));
    await writeFile(join(root, 'fixtures', 'wrong-file.json'), `${JSON.stringify(fixture('different-id'))}\n`, { mode: 0o600 });
    const listed = await repository.listDetailed();
    assert.equal(listed.diagnostics.some((item) => item.record === 'wrong-file.json' && item.code === 'STATE_ID_MISMATCH' && item.quarantined), true);
    const expired = new Date(Date.parse(NOW) - 1).toISOString();
    await writeFile(join(root, 'locks', 'fixtures', 'record.lock'), `${JSON.stringify({ schemaVersion: 1, id: 'record', ownerId: 'dead', ownerPid: 42, hostId: 'local', claimedAt: NOW, expiresAt: expired })}\n`, { mode: 0o600 });
    assert.equal((await repository.replace({ ...created, value: 'recovered' }, created.revision)).value, 'recovered');
  } finally { await rm(root, { recursive: true, force: true }); }
});
