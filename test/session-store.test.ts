import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
