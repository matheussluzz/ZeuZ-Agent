import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TaskMessageStore } from '../src/task-messages.js';
import type { RuntimeSeams } from '../src/runtime.js';

function runtime() : RuntimeSeams {
  let id = 0;
  return {
    now: () => '2026-01-02T03:04:05.000Z',
    nowMs: () => Date.parse('2026-01-02T03:04:05.000Z'),
    newId: () => `message-${++id}`,
    fingerprint: () => 'fixture-fingerprint',
  };
}

test('follow-up messages are redacted, atomically claimed, and acknowledged once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zeuz-task-messages-'));
  try {
    const store = new TaskMessageStore({ root, runtime: runtime() });
    const fixtureToken = ['nvapi', 'AbCdEf1234567890'].join('-');
    const queued = await store.enqueue({ taskId: 'task-1', rootCorrelationId: 'root-1', content: `Use ${fixtureToken} only as a redacted fixture.` });
    assert.match(queued.content, /redacted/);
    assert.doesNotMatch(queued.content, /nvapi-AbCdEf/);

    const firstClaim = await store.claimForExecution('task-1', 'claim-a');
    const secondClaim = await store.claimForExecution('task-1', 'claim-b');
    assert.equal(firstClaim.length, 1);
    assert.equal(secondClaim.length, 0);
    assert.equal((await store.acknowledge('task-1', 'claim-a')), 1);
    assert.equal((await store.acknowledge('task-1', 'claim-a')), 0);
    const delivered = await store.list('task-1');
    assert.equal(delivered[0]?.status, 'delivered');
    assert.equal(delivered[0]?.delivery, 'queued');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expired claims return to the queue without deleting the message', async () => {
  let current = Date.parse('2026-01-02T03:04:05.000Z');
  let id = 0;
  const runtime: RuntimeSeams = {
    now: () => new Date(current).toISOString(),
    nowMs: () => current,
    newId: () => `message-${++id}`,
    fingerprint: () => 'fixture-fingerprint',
  };
  const root = await mkdtemp(join(tmpdir(), 'zeuz-task-message-recovery-'));
  try {
    const store = new TaskMessageStore({ root, runtime, claimLeaseMs: 1_000 });
    await store.enqueue({ taskId: 'task-2', rootCorrelationId: 'root-2', content: 'retry this follow-up' });
    await store.claimForExecution('task-2', 'claim-a');
    current += 1_001;
    assert.equal(await store.recoverExpiredClaims('task-2'), 1);
    assert.equal((await store.list('task-2', 'queued')).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
