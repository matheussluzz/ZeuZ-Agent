import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';

import {
  BoundedByteAccumulator,
  BoundedLineDecoder,
  DEFAULT_PARTIAL_LINE_LIMIT_BYTES,
  DEFAULT_STDERR_LIMIT_BYTES,
  DEFAULT_STDOUT_LIMIT_BYTES,
  type TruncationMetadata,
} from './streaming.js';

export interface TimerHandle {
  clear(): void;
}

export interface ProcessSeams {
  spawn: typeof spawn;
  schedule(delayMs: number, callback: () => void): TimerHandle;
}

export const DEFAULT_KILL_GRACE_MS = 1_500;
export const DEFAULT_POST_KILL_WATCHDOG_MS = 500;

export const defaultProcessSeams: ProcessSeams = {
  spawn,
  schedule(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return {
      clear: () => clearTimeout(handle),
    };
  },
};

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onStdoutChunk?: (chunk: string) => void;
  killGraceMs?: number;
  postKillWatchdogMs?: number;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  partialLineLimitBytes?: number;
  runner?: 'supervised' | 'legacy';
  seams?: ProcessSeams;
}

export type TerminationCause = 'completed' | 'exit_failure' | 'cancelled' | 'spawn_failure';

export type EscalationStage =
  | 'none'
  | 'interrupt_sent'
  | 'grace_elapsed'
  | 'kill_sent'
  | 'exited'
  | 'termination_incomplete';

export type SpawnRaceWinner = 'spawn_error' | 'cancelled';

export type KillDeliveryOutcome = 'delivered' | 'refused' | 'thrown';

export interface SignalDeliveryAttempt {
  signal: NodeJS.Signals;
  outcome: KillDeliveryOutcome;
}

export interface TerminationMetadata {
  cause: TerminationCause;
  stage: EscalationStage;
  signal?: NodeJS.Signals | null;
  killSignal?: NodeJS.Signals;
  killDelivered?: boolean;
  killAttempts?: SignalDeliveryAttempt[];
  abortedBeforeSpawn?: boolean;
  exitObserved?: boolean;
  spawnRaceWinner?: SpawnRaceWinner;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  termination?: TerminationMetadata;
  truncation?: TruncationMetadata[];
}

export class ProcessSpawnError extends Error {
  readonly code?: string;
  readonly errno?: number;
  readonly spawnRaceWinner: SpawnRaceWinner;

  constructor(
    message: string,
    options: { code?: string; errno?: number; spawnRaceWinner: SpawnRaceWinner; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProcessSpawnError';
    if (options.code !== undefined) this.code = options.code;
    if (options.errno !== undefined) this.errno = options.errno;
    this.spawnRaceWinner = options.spawnRaceWinner;
  }
}

export type ProcessCallbackName = 'onStdoutChunk' | 'onStdoutLine' | 'onStderrLine';

export class ProcessCallbackError extends Error {
  readonly callback: ProcessCallbackName;

  constructor(callback: ProcessCallbackName, cause: unknown) {
    super(`Process callback ${callback} failed`, { cause });
    this.name = 'ProcessCallbackError';
    this.callback = callback;
  }
}

function deliverSignal(child: ChildProcess, signal: NodeJS.Signals): KillDeliveryOutcome {
  try {
    return child.kill(signal) ? 'delivered' : 'refused';
  } catch {
    return 'thrown';
  }
}

function killOutcomeDelivered(outcome: KillDeliveryOutcome): boolean {
  return outcome === 'delivered';
}

function childHasSafeHandle(child: ChildProcess): boolean {
  return child.pid !== undefined && child.pid > 0;
}

function cancelledBeforeSpawnResult(): ProcessResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: '',
    termination: {
      cause: 'cancelled',
      stage: 'none',
      abortedBeforeSpawn: true,
      exitObserved: false,
    },
  };
}

function buildTerminationMetadata(input: {
  cause: TerminationCause;
  stage: EscalationStage;
  signal?: NodeJS.Signals | null;
  killAttempts?: SignalDeliveryAttempt[];
  abortedBeforeSpawn?: boolean;
  exitObserved?: boolean;
  spawnRaceWinner?: SpawnRaceWinner;
}): TerminationMetadata {
  const lastAttempt = input.killAttempts?.at(-1);
  return {
    cause: input.cause,
    stage: input.stage,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(lastAttempt !== undefined
      ? {
          killSignal: lastAttempt.signal,
          killDelivered: killOutcomeDelivered(lastAttempt.outcome),
        }
      : {}),
    ...(input.killAttempts !== undefined && input.killAttempts.length > 0
      ? { killAttempts: [...input.killAttempts] }
      : {}),
    ...(input.abortedBeforeSpawn !== undefined ? { abortedBeforeSpawn: input.abortedBeforeSpawn } : {}),
    ...(input.exitObserved !== undefined ? { exitObserved: input.exitObserved } : {}),
    ...(input.spawnRaceWinner !== undefined ? { spawnRaceWinner: input.spawnRaceWinner } : {}),
  };
}

export async function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return options.runner === 'legacy'
    ? await runProcessLegacy(command, args, options)
    : await runSupervisedProcess(command, args, options);
}

export async function runSupervisedProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return cancelledBeforeSpawnResult();
  }

  const seams = options.seams ?? defaultProcessSeams;
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const watchdogMs = options.postKillWatchdogMs ?? DEFAULT_POST_KILL_WATCHDOG_MS;

  return await new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    const stdoutCapture = new BoundedByteAccumulator(
      'stdout',
      options.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT_BYTES,
    );
    const stderrCapture = new BoundedByteAccumulator(
      'stderr',
      options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES,
    );
    const partialLineLimitBytes = options.partialLineLimitBytes ?? DEFAULT_PARTIAL_LINE_LIMIT_BYTES;
    const stdoutLines = new BoundedLineDecoder('stdout', partialLineLimitBytes);
    const stderrLines = new BoundedLineDecoder('stderr', partialLineLimitBytes);
    let killTimer: TimerHandle | undefined;
    let watchdogTimer: TimerHandle | undefined;
    let escalationStage: EscalationStage = 'none';
    const killAttempts: SignalDeliveryAttempt[] = [];
    let cancelledByAbort = false;
    let pendingAbort = false;
    let childReady = false;
    let spawnObserved = false;
    let closingFromExit = false;
    let streamSuppressed = false;
    let exitObserved = false;
    let spawnRaceDecided = false;
    let child: ChildProcess | undefined;
    let abortListenerAttached = false;
    let killDeliveryInProgress = false;
    let killEscalationActive = false;
    let deferredClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let pendingCallbackFailure: { callback: ProcessCallbackName; error: unknown } | undefined;

    const getTruncation = (): TruncationMetadata[] => [
      stdoutCapture.metadata(),
      stderrCapture.metadata(),
      stdoutLines.metadata(),
      stderrLines.metadata(),
    ].filter((item): item is TruncationMetadata => item !== undefined);

    const capturedOutput = () => ({
      stdout: stdoutCapture.value(),
      stderr: stderrCapture.value(),
      ...(getTruncation().length > 0 ? { truncation: getTruncation() } : {}),
    });

    const recordKillAttempt = (signal: NodeJS.Signals, outcome: KillDeliveryOutcome) => {
      killAttempts.push({ signal, outcome });
    };

    const rejectCallbackFailure = () => {
      if (settled || !pendingCallbackFailure) return;
      settled = true;
      cleanup();
      reject(new ProcessCallbackError(pendingCallbackFailure.callback, pendingCallbackFailure.error));
    };

    const handleCallbackFailure = (error: unknown, callback: ProcessCallbackName) => {
      if (settled || pendingCallbackFailure) return;
      pendingCallbackFailure = { callback, error };
      streamSuppressed = true;
      if (exitObserved) {
        rejectCallbackFailure();
        return;
      }
      beginKillEscalation(false);
    };

    const invokeLineCallback = (
      callback: ((line: string) => void) | undefined,
      line: string,
      callbackName: ProcessCallbackName,
      allowDuringClose = false,
    ) => {
      if (!callback || settled || streamSuppressed || (!allowDuringClose && closingFromExit)) return;
      try {
        callback(line);
      } catch (error) {
        handleCallbackFailure(error, callbackName);
      }
    };

    const onChildSpawn = () => {
      if (spawnObserved) return;
      spawnObserved = true;
      armChild();
    };

    const onChildError = (error: NodeJS.ErrnoException) => {
      if (settled) return;
      if (pendingCallbackFailure) return;
      if (!spawnObserved) {
        if (!spawnRaceDecided) settleSpawnRace(error);
        return;
      }
      if (cancelledByAbort || closingFromExit) return;
      if (spawnRaceDecided) return;
      spawnRaceDecided = true;
      rejectSpawn(error);
    };

    const onStdoutData = (chunk: string) => {
      if (settled || streamSuppressed || closingFromExit) return;
      stdoutCapture.append(chunk);
      if (options.onStdoutChunk) {
        try {
          options.onStdoutChunk(chunk);
        } catch (error) {
          handleCallbackFailure(error, 'onStdoutChunk');
          return;
        }
      }
      stdoutLines.push(chunk, (line) => {
        invokeLineCallback(options.onStdoutLine, line, 'onStdoutLine');
      });
    };

    const onStderrData = (chunk: string) => {
      if (settled || streamSuppressed || closingFromExit) return;
      stderrCapture.append(chunk);
      stderrLines.push(chunk, (line) => {
        invokeLineCallback(options.onStderrLine, line, 'onStderrLine');
      });
    };

    const onChildClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (killDeliveryInProgress) {
        deferredClose = { code, signal };
        return;
      }
      exitObserved = true;
      closingFromExit = true;
      detachAbort();
      killTimer?.clear();
      watchdogTimer?.clear();
      flushLineBuffers();
      streamSuppressed = true;
      if (settled) return;

      const exitCode = code ?? 1;
      let cause: TerminationCause;
      let stage: EscalationStage;

      if (cancelledByAbort) {
        cause = 'cancelled';
        stage = 'exited';
      } else if (exitCode === 0 && !signal) {
        cause = 'completed';
        stage = 'exited';
      } else {
        cause = 'exit_failure';
        stage = 'exited';
      }

      const terminationInput: {
        cause: TerminationCause;
        stage: EscalationStage;
        signal?: NodeJS.Signals | null;
        killAttempts: SignalDeliveryAttempt[];
        exitObserved: boolean;
      } = {
        cause,
        stage,
        signal,
        killAttempts,
        exitObserved: true,
      };

      finish({
        exitCode,
        ...capturedOutput(),
        termination: buildTerminationMetadata(terminationInput),
      });
    };

    const finish = (result: ProcessResult) => {
      if (pendingCallbackFailure) {
        rejectCallbackFailure();
        return;
      }
      settle(result);
    };

    const detachAbort = () => {
      if (!abortListenerAttached) return;
      options.signal?.removeEventListener('abort', onAbort);
      abortListenerAttached = false;
    };

    const cleanup = () => {
      detachAbort();
      killTimer?.clear();
      watchdogTimer?.clear();
      if (child) {
        child.stdout?.off('data', onStdoutData);
        child.stderr?.off('data', onStderrData);
        child.off('error', onChildError);
        child.off('close', onChildClose);
        child.off('spawn', onChildSpawn);
      }
    };

    const settle = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const rejectSpawn = (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      const spawnErrorOptions: {
        code?: string;
        errno?: number;
        spawnRaceWinner: SpawnRaceWinner;
        cause?: unknown;
      } = { spawnRaceWinner: 'spawn_error', cause: error };
      if (error.code !== undefined) spawnErrorOptions.code = error.code;
      if (error.errno !== undefined) spawnErrorOptions.errno = error.errno;
      reject(new ProcessSpawnError(error.message, spawnErrorOptions));
    };

    const settleSpawnRace = (error: NodeJS.ErrnoException) => {
      if (settled || spawnRaceDecided) return;
      spawnRaceDecided = true;
      detachAbort();

      const abortWon =
        options.signal?.aborted === true || pendingAbort || cancelledByAbort;
      if (abortWon) {
        settle({
          exitCode: 1,
          ...capturedOutput(),
          termination: buildTerminationMetadata({
            cause: 'cancelled',
            stage: childReady ? escalationStage : 'none',
            abortedBeforeSpawn: !childReady,
            exitObserved: false,
            spawnRaceWinner: 'cancelled',
          }),
        });
        return;
      }

      rejectSpawn(error);
    };

    const schedulePostKillWatchdog = () => {
      if (watchdogTimer || settled || exitObserved || closingFromExit) return;
      watchdogTimer = seams.schedule(watchdogMs, () => {
        watchdogTimer = undefined;
        if (settled || exitObserved || closingFromExit) return;
        const incomplete: {
          cause: TerminationCause;
          stage: EscalationStage;
          exitObserved: boolean;
          killAttempts: SignalDeliveryAttempt[];
        } = {
          cause: cancelledByAbort ? 'cancelled' : 'exit_failure',
          stage: 'termination_incomplete',
          exitObserved: false,
          killAttempts,
        };
        finish({
          exitCode: 1,
          ...capturedOutput(),
          termination: buildTerminationMetadata(incomplete),
        });
      });
    };

    const tryDeliverSignal = (signal: NodeJS.Signals, nextStage: EscalationStage): void => {
      if (!child || settled) return;
      killDeliveryInProgress = true;
      let scheduleWatchdogAfterDrain = false;
      try {
        const outcome = deliverSignal(child, signal);
        recordKillAttempt(signal, outcome);
        escalationStage = nextStage;
        if (signal === 'SIGKILL') {
          scheduleWatchdogAfterDrain = true;
        }
      } finally {
        killDeliveryInProgress = false;
        if (deferredClose !== undefined && !settled) {
          const pendingClose = deferredClose;
          deferredClose = undefined;
          onChildClose(pendingClose.code, pendingClose.signal);
        }
        if (
          scheduleWatchdogAfterDrain &&
          !settled &&
          !exitObserved &&
          !closingFromExit
        ) {
          schedulePostKillWatchdog();
        }
      }
    };

    const beginKillEscalation = (markCancelled: boolean) => {
      if (!childReady || !child || settled) {
        if (!childReady && !settled && markCancelled) pendingAbort = true;
        return;
      }
      if (killEscalationActive) return;
      killEscalationActive = true;
      if (markCancelled) cancelledByAbort = true;
      if (escalationStage !== 'none') return;

      tryDeliverSignal('SIGINT', 'interrupt_sent');
      if (settled || exitObserved) return;

      killTimer = seams.schedule(graceMs, () => {
        if (settled || exitObserved || !child) return;
        escalationStage = 'grace_elapsed';
        tryDeliverSignal('SIGKILL', 'kill_sent');
      });
    };

    const onAbort = () => beginKillEscalation(true);

    const flushLineBuffers = () => {
      stdoutLines.finish((line) => invokeLineCallback(options.onStdoutLine, line, 'onStdoutLine', true));
      if (settled) return;
      stderrLines.finish((line) => invokeLineCallback(options.onStderrLine, line, 'onStderrLine', true));
    };

    const armChild = () => {
      if (!child || !childHasSafeHandle(child)) return;
      childReady = true;
      if (options.signal?.aborted) pendingAbort = true;
      if (options.signal && !abortListenerAttached) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        abortListenerAttached = true;
      }
      if (pendingAbort) beginKillEscalation(true);
    };

    try {
      child = seams.spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      settleSpawnRace(error as NodeJS.ErrnoException);
      return;
    }

    if (options.signal?.aborted) pendingAbort = true;

    armChild();

    child.on('spawn', onChildSpawn);
    child.on('error', onChildError);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', onStdoutData);
    child.stderr?.on('data', onStderrData);
    child.on('close', onChildClose);
  });
}

/**
 * One-release compatibility runner retaining the pre-Wave-03 behavior.
 * Does not emit typed termination metadata or fix pre-abort spawn/kill races.
 */
export async function runProcessLegacy(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return { exitCode: 1, stdout: '', stderr: '' };
  }
  const spawnFn = options.seams?.spawn ?? spawn;
  const seams = options.seams ?? defaultProcessSeams;
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const watchdogMs = options.postKillWatchdogMs ?? DEFAULT_POST_KILL_WATCHDOG_MS;

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawnFn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutCapture = new BoundedByteAccumulator(
      'stdout',
      options.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT_BYTES,
    );
    const stderrCapture = new BoundedByteAccumulator(
      'stderr',
      options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES,
    );
    const partialLineLimitBytes = options.partialLineLimitBytes ?? DEFAULT_PARTIAL_LINE_LIMIT_BYTES;
    const stdoutLines = new BoundedLineDecoder('stdout', partialLineLimitBytes);
    const stderrLines = new BoundedLineDecoder('stderr', partialLineLimitBytes);
    let settled = false;
    let pendingCallbackFailure: { callback: ProcessCallbackName; error: unknown } | undefined;
    let killEscalationActive = false;
    let killTimer: TimerHandle | undefined;
    let watchdogTimer: TimerHandle | undefined;
    let streamSuppressed = false;

    const capturedOutput = () => {
      const truncation = [
        stdoutCapture.metadata(),
        stderrCapture.metadata(),
        stdoutLines.metadata(),
        stderrLines.metadata(),
      ].filter((item): item is TruncationMetadata => item !== undefined);
      return {
        stdout: stdoutCapture.value(),
        stderr: stderrCapture.value(),
        ...(truncation.length > 0 ? { truncation } : {}),
      };
    };

    const detachAbort = () => {
      options.signal?.removeEventListener('abort', onAbort);
    };

    const detachOwnedStreamHandlers = () => {
      child.stdout?.off('data', onStdoutData);
      child.stderr?.off('data', onStderrData);
    };

    const cleanupOwned = () => {
      detachAbort();
      killTimer?.clear();
      watchdogTimer?.clear();
      detachOwnedStreamHandlers();
      child.off('error', onChildError);
      child.off('close', onChildClose);
    };

    const rejectCallbackFailure = () => {
      if (settled || !pendingCallbackFailure) return;
      settled = true;
      cleanupOwned();
      reject(new ProcessCallbackError(pendingCallbackFailure.callback, pendingCallbackFailure.error));
    };

    const handleCallbackFailure = (error: unknown, callback: ProcessCallbackName) => {
      if (settled || pendingCallbackFailure) return;
      pendingCallbackFailure = { callback, error };
      streamSuppressed = true;
      detachOwnedStreamHandlers();
      beginKillEscalation();
    };

    const beginKillEscalation = () => {
      if (killEscalationActive || settled) return;
      killEscalationActive = true;
      try {
        child.kill('SIGINT');
      } catch {
        // Legacy path records delivery only through eventual close/watchdog settlement.
      }
      if (settled) return;

      const onGraceElapsed = () => {
        if (settled) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // Same as SIGINT: bounded termination continues through close/watchdog.
        }
        if (pendingCallbackFailure && !settled) {
          watchdogTimer = seams.schedule(watchdogMs, () => {
            if (!settled) rejectCallbackFailure();
          });
        }
      };

      if (options.seams) {
        killTimer = seams.schedule(graceMs, onGraceElapsed);
        return;
      }

      const handle = setTimeout(() => child.kill('SIGKILL'), 1_500);
      handle.unref?.();
      killTimer = { clear: () => clearTimeout(handle) };
      if (pendingCallbackFailure && !settled) {
        watchdogTimer = defaultProcessSeams.schedule(1_500 + watchdogMs, () => {
          if (!settled) rejectCallbackFailure();
        });
      }
    };

    const onAbort = () => beginKillEscalation();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    const invokeLegacyLine = (
      callback: ((line: string) => void) | undefined,
      line: string,
      callbackName: ProcessCallbackName,
    ) => {
      if (streamSuppressed || !callback) return;
      try {
        callback(line);
      } catch (error) {
        handleCallbackFailure(error, callbackName);
      }
    };

    const onStdoutData = (chunk: string) => {
      if (settled || streamSuppressed) return;
      stdoutCapture.append(chunk);
      if (options.onStdoutChunk) {
        try {
          options.onStdoutChunk(chunk);
        } catch (error) {
          handleCallbackFailure(error, 'onStdoutChunk');
          return;
        }
      }
      stdoutLines.push(chunk, (line) => {
        invokeLegacyLine(options.onStdoutLine, line, 'onStdoutLine');
      });
    };

    const onStderrData = (chunk: string) => {
      if (settled || streamSuppressed) return;
      stderrCapture.append(chunk);
      stderrLines.push(chunk, (line) => {
        invokeLegacyLine(options.onStderrLine, line, 'onStderrLine');
      });
    };

    const onChildError = (error: NodeJS.ErrnoException) => {
      if (settled || pendingCallbackFailure) return;
      settled = true;
      cleanupOwned();
      reject(error);
    };

    const onChildClose = (code: number | null) => {
      if (settled) return;
      if (!pendingCallbackFailure) {
        stdoutLines.finish((line) => invokeLegacyLine(options.onStdoutLine, line, 'onStdoutLine'));
        if (pendingCallbackFailure) {
          rejectCallbackFailure();
          return;
        }
        stderrLines.finish((line) => invokeLegacyLine(options.onStderrLine, line, 'onStderrLine'));
        if (pendingCallbackFailure) {
          rejectCallbackFailure();
          return;
        }
        settled = true;
        cleanupOwned();
        resolve({ exitCode: code ?? 1, ...capturedOutput() });
        return;
      }
      rejectCallbackFailure();
    };

    child.stdout?.on('data', onStdoutData);
    child.stderr?.on('data', onStderrData);
    child.on('error', onChildError);
    child.on('close', onChildClose);
  });
}

export function findExecutable(name: string): string | undefined {
  const which = spawnSync('which', [name], { encoding: 'utf8' });
  const found = which.status === 0 ? which.stdout.trim().split('\n')[0] : undefined;
  if (found && existsSync(found)) return found;
  return undefined;
}

export function resolveCodexExecutable(): string {
  const candidates = [
    process.env.CODEX_BIN,
    findExecutable('codex'),
    '/Applications/Codex.app/Contents/Resources/codex',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 8_000 });
    if (probe.status === 0) return candidate;
  }
  throw new Error('No healthy Codex executable found. Run `codex doctor`.');
}

export type FakeChildHandle = ChildProcess & {
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  emitClose(code: number | null, signal?: NodeJS.Signals | null): void;
  emitError(error: NodeJS.ErrnoException): void;
};

export function createFakeChildProcess(seams?: ProcessSeams): {
  seams: ProcessSeams;
  lastChild: () => FakeChildHandle | undefined;
} {
  let current: FakeChildHandle | undefined;

  const makeStream = () => {
    const stream = new EventEmitter() as EventEmitter & {
      setEncoding(encoding: BufferEncoding): void;
      removeAllListeners(event?: string): EventEmitter;
    };
    stream.setEncoding = () => stream;
    return stream;
  };

  const fakeSeams: ProcessSeams = {
    spawn: ((..._args: unknown[]) => {
      const stdout = makeStream();
      const stderr = makeStream();
      const emitter = new EventEmitter();
      const handle = emitter as FakeChildHandle;
      handle.stdout = stdout as ChildProcess['stdout'];
      handle.stderr = stderr as ChildProcess['stderr'];
      Object.defineProperty(handle, 'pid', { value: 42_001, configurable: true });
      handle.kill = (signal?: NodeJS.Signals) => {
        emitter.emit('killed', signal);
        return true;
      };
      handle.emitStdout = (chunk: string) => stdout.emit('data', chunk);
      handle.emitStderr = (chunk: string) => stderr.emit('data', chunk);
      handle.emitClose = (code, signal = null) => emitter.emit('close', code, signal);
      handle.emitError = (error) => emitter.emit('error', error);
      current = handle;
      queueMicrotask(() => emitter.emit('spawn'));
      return handle;
    }) as unknown as typeof spawn,
    schedule: seams?.schedule ?? defaultProcessSeams.schedule,
  };

  return {
    seams: fakeSeams,
    lastChild: () => current,
  };
}
