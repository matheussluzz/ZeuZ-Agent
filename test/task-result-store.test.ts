import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TaskResultError, TaskResultStore, validateArtifact } from '../src/task-result-store.js';

const NOW = '2026-01-02T03:04:05.000Z';

test('full result persists privately and survives restart with hash verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-result-store-'));
  try {
    const first = new TaskResultStore({ root, now: () => NOW, maxBytes: 1_024 });
    const reference = await first.persist('task-id', 1, 'complete result');
    if (process.platform !== 'win32') assert.equal((await stat(join(root, reference.path))).mode & 0o777, 0o600);
    const restarted = new TaskResultStore({ root, now: () => NOW, maxBytes: 1_024 });
    assert.equal(await restarted.retrieve(reference), 'complete result');
    await chmod(join(root, reference.path), 0o600);
    await writeFile(join(root, reference.path), 'tampered', { mode: 0o600 });
    await assert.rejects(() => restarted.retrieve(reference), (error: unknown) => error instanceof TaskResultError && error.code === 'RESULT_INTEGRITY_FAILURE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('oversized and duplicate results fail without partial success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-result-budget-'));
  try {
    const store = new TaskResultStore({ root, now: () => NOW, maxBytes: 10 });
    await assert.rejects(() => store.persist('task', 1, '01234567890'), (error: unknown) => error instanceof TaskResultError && error.code === 'RESULT_TOO_LARGE');
    const first = await store.persist('task', 1, 'safe');
    assert.deepEqual(await store.persist('task', 1, 'safe'), first);
    await assert.rejects(() => store.persist('task', 1, 'again'), (error: unknown) => error instanceof TaskResultError && error.code === 'RESULT_ALREADY_EXISTS');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact policy rejects traversal, private paths, credentials, and escaping symlinks', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zeuz-artifact-workspace-'));
  const outside = await mkdtemp(join(tmpdir(), 'zeuz-artifact-outside-'));
  try {
    await writeFile(join(workspace, 'safe.txt'), 'safe');
    const safe = await validateArtifact(workspace, { path: 'safe.txt', kind: 'created', status: 'captured' });
    assert.equal(safe.byteCount, 4);
    assert.match(safe.sha256 ?? '', /^[a-f0-9]{64}$/);
    const verifier = new TaskResultStore({ root: workspace, now: () => NOW });
    await verifier.verifyArtifacts(workspace, [safe]);
    await assert.rejects(() => verifier.verifyArtifacts(workspace, [{ ...safe, sha256: '0'.repeat(64) }]), (error: unknown) => error instanceof TaskResultError && error.code === 'ARTIFACT_EVIDENCE_MISMATCH');
    assert.equal((await validateArtifact(workspace, { path: 'gone.txt', kind: 'removed', status: 'missing' })).status, 'missing');
    await assert.rejects(() => validateArtifact(workspace, { path: 'safe.txt', kind: 'removed', status: 'missing' }), (error: unknown) => error instanceof TaskResultError && error.code === 'ARTIFACT_EVIDENCE_MISMATCH');
    await assert.rejects(() => validateArtifact(workspace, { path: '../escape', kind: 'created', status: 'captured' }));
    await assert.rejects(() => validateArtifact(workspace, { path: 'handoff.md', kind: 'created', status: 'captured' }), /private/i);
    await assert.rejects(() => validateArtifact(workspace, { path: '.env', kind: 'created', status: 'captured' }), /private/i);
    await writeFile(join(outside, 'outside.txt'), 'outside');
    await symlink(join(outside, 'outside.txt'), join(workspace, 'escape-link'));
    await assert.rejects(() => validateArtifact(workspace, { path: 'escape-link', kind: 'created', status: 'captured' }), /escapes/);
    await symlink(join(workspace, 'safe.txt'), join(workspace, 'internal-link'));
    assert.equal((await validateArtifact(workspace, { path: 'internal-link', kind: 'modified', status: 'captured' })).status, 'captured');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('secret-shaped result near the byte limit is redacted before hashing and storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-result-redaction-'));
  try {
    const store = new TaskResultStore({ root, now: () => NOW, maxBytes: 128 });
    const reference = await store.persist('task', 1, `prefix sk-proj-${'A'.repeat(30)} suffix`);
    const result = await store.retrieve(reference);
    assert.doesNotMatch(result, /sk-proj-/);
    assert.match(result, /<redacted:secret>/);
    assert.equal(Buffer.byteLength(result), reference.byteCount);
  } finally { await rm(root, { recursive: true, force: true }); }
});
