import type { AgentEvent } from './types.js';

export const DEFAULT_STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_STDERR_LIMIT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PARTIAL_LINE_LIMIT_BYTES = 256 * 1024;
export const DEFAULT_RAW_EVENT_LIMIT_BYTES = 1024 * 1024;
export const DEFAULT_EVENT_LIMIT_BYTES = 256 * 1024;
export const DEFAULT_EVENT_QUEUE_LIMIT_BYTES = 1024 * 1024;
export const DEFAULT_HTTP_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export type TruncatedStream = 'stdout' | 'stderr' | 'partial_line' | 'raw_event' | 'http_body';

export interface TruncationMetadata {
  stream: TruncatedStream;
  channel?: 'stdout' | 'stderr';
  limitBytes: number;
  observedBytes: number;
  discardedBytes: number;
}

export class BoundedLineDecoder {
  readonly channel: 'stdout' | 'stderr';
  readonly limitBytes: number;
  private fragment = '';
  private fragmentBytes = 0;
  private lineOverflowed = false;
  private totalObservedBytes = 0;
  private totalDiscardedBytes = 0;

  constructor(channel: 'stdout' | 'stderr', limitBytes = DEFAULT_PARTIAL_LINE_LIMIT_BYTES) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      throw new RangeError('Partial-line byte limit must be a non-negative safe integer.');
    }
    this.channel = channel;
    this.limitBytes = limitBytes;
  }

  push(chunk: string, onLine: (line: string) => void): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf('\n', start);
      if (newline < 0) {
        this.appendFragment(chunk.slice(start));
        return;
      }
      this.appendFragment(chunk.slice(start, newline));
      if (!this.lineOverflowed) {
        onLine(this.fragment.endsWith('\r') ? this.fragment.slice(0, -1) : this.fragment);
      }
      this.resetLine();
      start = newline + 1;
    }
  }

  finish(onLine: (line: string) => void): void {
    if (!this.lineOverflowed && this.fragment.length > 0) onLine(this.fragment);
    this.resetLine();
  }

  metadata(): TruncationMetadata | undefined {
    if (this.totalDiscardedBytes === 0) return undefined;
    return {
      stream: 'partial_line',
      channel: this.channel,
      limitBytes: this.limitBytes,
      observedBytes: this.totalObservedBytes,
      discardedBytes: this.totalDiscardedBytes,
    };
  }

  get retainedBytes(): number {
    return this.fragmentBytes;
  }

  private appendFragment(value: string): void {
    const buffer = Buffer.from(value);
    this.totalObservedBytes += buffer.length;
    if (this.lineOverflowed) {
      this.totalDiscardedBytes += buffer.length;
      return;
    }
    const available = this.limitBytes - this.fragmentBytes;
    const retained = utf8Prefix(buffer, Math.min(buffer.length, Math.max(0, available)));
    if (retained.length > 0) {
      this.fragment += retained.toString('utf8');
      this.fragmentBytes += retained.length;
    }
    const discarded = buffer.length - retained.length;
    if (discarded > 0) {
      this.totalDiscardedBytes += discarded;
      this.lineOverflowed = true;
    }
  }

  private resetLine(): void {
    this.fragment = '';
    this.fragmentBytes = 0;
    this.lineOverflowed = false;
  }
}

export class StreamBudgetExceededError extends Error {
  readonly code = 'STREAM_BUDGET_EXCEEDED';
  readonly truncation: TruncationMetadata;

  constructor(truncation: TruncationMetadata) {
    super(
      `${truncation.stream} exceeded its ${truncation.limitBytes}-byte limit; `
      + `${truncation.discardedBytes} of ${truncation.observedBytes} observed bytes were discarded.`,
    );
    this.name = 'StreamBudgetExceededError';
    this.truncation = { ...truncation };
  }
}

export class ProtocolParseError extends Error {
  readonly code = 'PROTOCOL_PARSE_FAILURE';

  constructor(message = 'Provider stream contained a malformed protocol event.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProtocolParseError';
  }
}

export class UnsafeCompletionError extends Error {
  readonly code = 'UNSAFE_COMPLETION';
  readonly truncation: TruncationMetadata[];

  constructor(truncation: TruncationMetadata[]) {
    super(`Provider completion is unsafe because ${truncation.map((item) => item.stream).join(', ')} exceeded a byte budget.`);
    this.name = 'UnsafeCompletionError';
    this.truncation = truncation.map((item) => ({ ...item }));
  }
}

function utf8Prefix(buffer: Buffer, limitBytes: number): Buffer {
  if (buffer.length <= limitBytes) return buffer;
  let end = Math.max(0, limitBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end > 0) {
    try {
      decoder.decode(buffer.subarray(0, end));
      return buffer.subarray(0, end);
    } catch {
      end -= 1;
    }
  }
  return Buffer.alloc(0);
}

export class BoundedByteAccumulator {
  readonly stream: TruncatedStream;
  readonly limitBytes: number;
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalObservedBytes = 0;

  constructor(stream: TruncatedStream, limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      throw new RangeError('Byte limit must be a non-negative safe integer.');
    }
    this.stream = stream;
    this.limitBytes = limitBytes;
  }

  append(value: string | Uint8Array): void {
    const buffer = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
    this.totalObservedBytes += buffer.length;
    const available = this.limitBytes - this.retainedBytes;
    if (available <= 0 || buffer.length === 0) return;
    const retained = buffer.subarray(0, Math.min(buffer.length, available));
    if (retained.length > 0) {
      this.chunks.push(Buffer.from(retained));
      this.retainedBytes += retained.length;
    }
  }

  get observedBytes(): number {
    return this.totalObservedBytes;
  }

  get sizeBytes(): number {
    return this.safeBuffer().length;
  }

  get truncated(): boolean {
    return this.totalObservedBytes > this.safeBuffer().length;
  }

  value(): string {
    return this.safeBuffer().toString('utf8');
  }

  metadata(): TruncationMetadata | undefined {
    if (!this.truncated) return undefined;
    return {
      stream: this.stream,
      limitBytes: this.limitBytes,
      observedBytes: this.totalObservedBytes,
      discardedBytes: this.totalObservedBytes - this.safeBuffer().length,
    };
  }

  private safeBuffer(): Buffer {
    const retained = Buffer.concat(this.chunks, this.retainedBytes);
    return this.totalObservedBytes > this.retainedBytes
      ? utf8Prefix(retained, retained.length)
      : retained;
  }
}

export class RawEventCollector {
  readonly limitBytes: number;
  private retainedBytes = 0;
  private readonly values: unknown[] = [];

  constructor(limitBytes = DEFAULT_RAW_EVENT_LIMIT_BYTES) {
    this.limitBytes = limitBytes;
  }

  push(value: unknown): void {
    const encoded = Buffer.from(JSON.stringify(value));
    const observedBytes = this.retainedBytes + encoded.length;
    if (encoded.length > this.limitBytes || observedBytes > this.limitBytes) {
      throw new StreamBudgetExceededError({
        stream: 'raw_event',
        limitBytes: this.limitBytes,
        observedBytes,
        discardedBytes: Math.max(encoded.length, observedBytes - this.limitBytes),
      });
    }
    this.values.push(value);
    this.retainedBytes = observedBytes;
  }

  result(): unknown[] {
    return [...this.values];
  }

  get sizeBytes(): number {
    return this.retainedBytes;
  }
}

export function parseJsonEvent<T extends object>(line: string): T {
  const observedBytes = Buffer.byteLength(line);
  if (observedBytes > DEFAULT_RAW_EVENT_LIMIT_BYTES) {
    throw new StreamBudgetExceededError({
      stream: 'raw_event',
      limitBytes: DEFAULT_RAW_EVENT_LIMIT_BYTES,
      observedBytes,
      discardedBytes: observedBytes - DEFAULT_RAW_EVENT_LIMIT_BYTES,
    });
  }
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object') throw new TypeError('event must be an object');
    return value as T;
  } catch (error) {
    throw new ProtocolParseError('Provider stream contained a malformed JSON event.', { cause: error });
  }
}

export function splitUtf8Text(text: string, limitBytes = DEFAULT_EVENT_LIMIT_BYTES): string[] {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw new RangeError('Event byte limit must be a positive safe integer.');
  }
  if (Buffer.byteLength(text) <= limitBytes) return [text];

  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const codePoint of text) {
    const bytes = Buffer.byteLength(codePoint);
    if (bytes > limitBytes) throw new RangeError('Event byte limit cannot hold one UTF-8 code point.');
    if (currentBytes + bytes > limitBytes) {
      parts.push(current);
      current = codePoint;
      currentBytes = bytes;
    } else {
      current += codePoint;
      currentBytes += bytes;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function emitBoundedEvent(sink: ((event: AgentEvent) => void) | undefined, event: AgentEvent): void {
  if (!sink) return;
  for (const text of splitUtf8Text(event.text)) sink({ ...event, text });
}

export class EventQueueCancelledError extends Error {
  readonly code = 'EVENT_QUEUE_CANCELLED';

  constructor() {
    super('Event queue wait was cancelled.');
    this.name = 'EventQueueCancelledError';
  }
}

export class BoundedEventQueue {
  readonly limitBytes: number;
  private readonly queue: Array<{ event: AgentEvent; bytes: number }> = [];
  private retained = 0;
  private readonly capacityWaiters = new Set<() => void>();

  constructor(limitBytes = DEFAULT_EVENT_QUEUE_LIMIT_BYTES) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < DEFAULT_EVENT_LIMIT_BYTES) {
      throw new RangeError(`Event queue limit must be at least ${DEFAULT_EVENT_LIMIT_BYTES} bytes.`);
    }
    this.limitBytes = limitBytes;
  }

  async enqueue(event: AgentEvent, signal?: AbortSignal): Promise<void> {
    for (const text of splitUtf8Text(event.text)) {
      const next = { ...event, text };
      const bytes = Buffer.byteLength(text);
      while (this.retained + bytes > this.limitBytes) await this.waitForCapacity(signal);
      this.queue.push({ event: next, bytes });
      this.retained += bytes;
    }
  }

  dequeue(): AgentEvent | undefined {
    const item = this.queue.shift();
    if (!item) return undefined;
    this.retained -= item.bytes;
    for (const wake of [...this.capacityWaiters]) wake();
    return item.event;
  }

  get retainedBytes(): number {
    return this.retained;
  }

  get length(): number {
    return this.queue.length;
  }

  private async waitForCapacity(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new EventQueueCancelledError();
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new EventQueueCancelledError());
      };
      const cleanup = () => {
        this.capacityWaiters.delete(wake);
        signal?.removeEventListener('abort', onAbort);
      };
      this.capacityWaiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
