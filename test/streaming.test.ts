import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BoundedByteAccumulator,
  BoundedLineDecoder,
  BoundedEventQueue,
  DEFAULT_EVENT_LIMIT_BYTES,
  RawEventCollector,
  StreamBudgetExceededError,
  emitBoundedEvent,
  parseJsonEvent,
  splitUtf8Text,
} from '../src/streaming.js';
import type { AgentEvent } from '../src/types.js';

test('BoundedByteAccumulator counts bytes and never retains a partial UTF-8 code point', () => {
  const accumulator = new BoundedByteAccumulator('stdout', 5);
  accumulator.append('a🙂b');
  assert.equal(accumulator.value(), 'a🙂');
  assert.equal(accumulator.sizeBytes, 5);
  assert.deepEqual(accumulator.metadata(), {
    stream: 'stdout',
    limitBytes: 5,
    observedBytes: 6,
    discardedBytes: 1,
  });
});

test('BoundedByteAccumulator keeps retained bytes bounded after repeated overflow', () => {
  const accumulator = new BoundedByteAccumulator('stderr', 4);
  for (let index = 0; index < 100; index += 1) accumulator.append('secret-never-retained');
  assert.equal(accumulator.sizeBytes, 4);
  assert.equal(accumulator.observedBytes, 2_100);
  assert.equal(accumulator.metadata()?.discardedBytes, 2_096);
  assert.doesNotMatch(JSON.stringify(accumulator.metadata()), /secret/);
});

test('BoundedLineDecoder handles split CRLF, multiple lines, trailing lines, and overflow', () => {
  const decoder = new BoundedLineDecoder('stdout', 5);
  const lines: string[] = [];
  decoder.push('one\r', (line) => lines.push(line));
  decoder.push('\ntwo\nway-too-long', (line) => lines.push(line));
  decoder.finish((line) => lines.push(line));
  assert.deepEqual(lines, ['one', 'two']);
  assert.equal(decoder.retainedBytes, 0);
  assert.deepEqual(decoder.metadata(), {
    stream: 'partial_line',
    channel: 'stdout',
    limitBytes: 5,
    observedBytes: 19,
    discardedBytes: 7,
  });
});

test('splitUtf8Text is lossless and keeps every event below the byte ceiling', () => {
  const input = `${'x'.repeat(DEFAULT_EVENT_LIMIT_BYTES - 1)}🙂tail`;
  const parts = splitUtf8Text(input);
  assert.equal(parts.join(''), input);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => Buffer.byteLength(part) <= DEFAULT_EVENT_LIMIT_BYTES));
});

test('emitBoundedEvent preserves type, status, order, and text', () => {
  const events: AgentEvent[] = [];
  const text = '🙂'.repeat(70_000);
  emitBoundedEvent((event) => events.push(event), { type: 'tool', status: 'started', text });
  assert.equal(events.map((event) => event.text).join(''), text);
  assert.ok(events.every((event) => event.type === 'tool' && event.status === 'started'));
  assert.ok(events.every((event) => Buffer.byteLength(event.text) <= DEFAULT_EVENT_LIMIT_BYTES));
});

test('RawEventCollector enforces a total byte budget without returning discarded content', () => {
  const collector = new RawEventCollector(24);
  collector.push({ ok: true });
  assert.throws(
    () => collector.push({ payload: 'credential-shaped-value' }),
    (error: unknown) => {
      assert.ok(error instanceof StreamBudgetExceededError);
      assert.equal(error.truncation.stream, 'raw_event');
      assert.doesNotMatch(error.message, /credential-shaped-value/);
      return true;
    },
  );
  assert.deepEqual(collector.result(), [{ ok: true }]);
});

test('parseJsonEvent returns objects and rejects malformed or scalar events by name', () => {
  assert.deepEqual(parseJsonEvent('{"ok":true}'), { ok: true });
  assert.throws(() => parseJsonEvent('{broken'), { name: 'ProtocolParseError' });
  assert.throws(() => parseJsonEvent('42'), { name: 'ProtocolParseError' });
});

test('BoundedEventQueue preserves FIFO and applies lossless backpressure under its byte ceiling', async () => {
  const queue = new BoundedEventQueue(DEFAULT_EVENT_LIMIT_BYTES);
  const first = 'a'.repeat(DEFAULT_EVENT_LIMIT_BYTES);
  const second = 'b'.repeat(10);
  await queue.enqueue({ type: 'delta', text: first });
  let secondSettled = false;
  const pending = queue.enqueue({ type: 'status', text: second }).then(() => { secondSettled = true; });
  await Promise.resolve();
  assert.equal(secondSettled, false);
  assert.equal(queue.retainedBytes, DEFAULT_EVENT_LIMIT_BYTES);
  assert.deepEqual(queue.dequeue(), { type: 'delta', text: first });
  await pending;
  assert.equal(secondSettled, true);
  assert.deepEqual(queue.dequeue(), { type: 'status', text: second });
  assert.equal(queue.retainedBytes, 0);
});

test('BoundedEventQueue releases blocked producers on cancellation without dropping queued events', async () => {
  const queue = new BoundedEventQueue(DEFAULT_EVENT_LIMIT_BYTES);
  await queue.enqueue({ type: 'delta', text: 'x'.repeat(DEFAULT_EVENT_LIMIT_BYTES) });
  const controller = new AbortController();
  const pending = queue.enqueue({ type: 'warning', text: 'later' }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'EventQueueCancelledError', code: 'EVENT_QUEUE_CANCELLED' });
  assert.equal(queue.length, 1);
  assert.equal(queue.retainedBytes, DEFAULT_EVENT_LIMIT_BYTES);
});
