import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchCommand, parseCommand } from '../src/command-dispatch.js';

test('parses exact commands case-insensitively and preserves normalized arguments', () => {
  assert.deepEqual(parseCommand('  /MODEL   sol  '), {
    name: 'model',
    requestedName: 'model',
    argument: 'sol',
    source: '  /MODEL   sol  ',
  });
});

test('dispatches a valid command to a UI-independent executor', async () => {
  const executed: string[] = [];
  const result = await dispatchCommand('/status', async (command) => {
    executed.push(command.name);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(executed, ['status']);
});

test('resolves the existing quit alias without changing the canonical command', () => {
  const command = parseCommand('/quit');
  assert.equal(command.name, 'exit');
  assert.equal(command.requestedName, 'quit');
});

test('rejects non-command, missing, invalid, and unknown input', async () => {
  assert.throws(() => parseCommand('status'), /must start with/);
  assert.throws(() => parseCommand('/'), /name is required/);
  assert.throws(() => parseCommand('/status!'), /Invalid command syntax/);
  assert.throws(() => parseCommand('/not-a-command'), /Unknown command/);
  await assert.rejects(() => dispatchCommand('/not-a-command', async () => 'never'), /Unknown command/);
});

test('reports ambiguous prefixes without silently selecting a command', () => {
  assert.throws(() => parseCommand('/c'), /Ambiguous command.*compact.*clear.*copy.*cd/);
});

test('does not introduce implicit unique-prefix dispatch', () => {
  assert.throws(() => parseCommand('/stat'), /Unknown command/);
});

test('propagates executor failures', async () => {
  await assert.rejects(
    () => dispatchCommand('/help', async () => {
      throw new Error('fixture dispatch failure');
    }),
    /fixture dispatch failure/,
  );
});
