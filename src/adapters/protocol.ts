import type { ProcessResult, TerminationMetadata } from '../process.js';
import type { RunRequest, RunResult } from '../types.js';
import { emitBoundedEvent, RawEventCollector, UnsafeCompletionError, parseJsonEvent } from '../streaming.js';

export class JsonlProtocolState<T extends object> {
  private readonly events = new RawEventCollector();

  parse(line: string): T {
    const event = parseJsonEvent<T>(line);
    this.events.push(event);
    return event;
  }

  rawEvents(): unknown[] {
    return this.events.result();
  }
}

export function assertSafeProcessCompletion(result: ProcessResult): void {
  if (result.truncation && result.truncation.length > 0) {
    throw new UnsafeCompletionError(result.truncation);
  }
}

export class AdapterTerminationError extends Error {
  readonly code = 'ADAPTER_TERMINATED';
  readonly termination: TerminationMetadata;
  readonly partialResult: Pick<RunResult, 'nativeSessionId'>;

  constructor(termination: TerminationMetadata, partialResult: Pick<RunResult, 'nativeSessionId'> = {}) {
    super(`Provider process terminated with cause ${termination.cause} at stage ${termination.stage}.`);
    this.name = 'AdapterTerminationError';
    this.termination = { ...termination };
    this.partialResult = { ...partialResult };
  }
}

export function assertProcessNotCancelled(
  result: ProcessResult,
  partialResult: Pick<RunResult, 'nativeSessionId'> = {},
): void {
  if (result.termination?.cause === 'cancelled' || result.termination?.stage === 'termination_incomplete') {
    throw new AdapterTerminationError(result.termination, partialResult);
  }
}

export function withBoundedEvents(request: RunRequest): RunRequest {
  const sink = request.onEvent;
  return sink ? { ...request, onEvent: (event) => emitBoundedEvent(sink, event) } : request;
}
