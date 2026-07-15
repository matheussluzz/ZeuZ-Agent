import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';

import {
  createFakeChildProcess,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_POST_KILL_WATCHDOG_MS,
  ProcessCallbackError,
  ProcessSpawnError,
  runProcess,
  runProcessLegacy,
  runSupervisedProcess,
  type FakeChildHandle,
  type ProcessSeams,
  type TimerHandle,
} from '../src/process.js';

class ManualTimerScheduler {
  private readonly tasks: Array<{ id: number; delayMs: number; callback: () => void; handle: TimerHandle }> = [];
  private readonly history: number[] = [];
  private nextId = 1;

  schedule(delayMs: number, callback: () => void): TimerHandle {
    this.history.push(delayMs);
    const id = this.nextId++;
    const task = {
      id,
      delayMs,
      callback,
      handle: {
        clear: () => {
          const index = this.tasks.findIndex((entry) => entry.id === id);
          if (index >= 0) this.tasks.splice(index, 1);
        },
      },
    };
    this.tasks.push(task);
    return task.handle;
  }

  runNext(): number | undefined {
    const [task] = this.tasks.splice(0, 1);
    task?.callback();
    return task?.delayMs;
  }

  pendingCount(): number {
    return this.tasks.length;
  }

  scheduledDelays(): number[] {
    return this.tasks.map((task) => task.delayMs);
  }

  scheduleHistory(): readonly number[] {
    return this.history;
  }
}

function legacySeams(fake: ReturnType<typeof createFakeChildProcess>, scheduler: ManualTimerScheduler): ProcessSeams {
  return {
    spawn: fake.seams.spawn,
    schedule: scheduler.schedule.bind(scheduler),
  };
}

function assertLegacyOwnershipReleased(
  child: FakeChildHandle,
  scheduler: ManualTimerScheduler,
  options?: {
    externalStdout?: boolean;
    externalStderr?: boolean;
    externalClose?: boolean;
    externalError?: boolean;
  },
): void {
  assert.equal(scheduler.pendingCount(), 0);
  const ownedClose = child.listenerCount('close') - (options?.externalClose ? 1 : 0);
  const ownedError = child.listenerCount('error') - (options?.externalError ? 1 : 0);
  const ownedStdout = (child.stdout?.listenerCount('data') ?? 0) - (options?.externalStdout ? 1 : 0);
  const ownedStderr = (child.stderr?.listenerCount('data') ?? 0) - (options?.externalStderr ? 1 : 0);
  assert.equal(ownedClose, 0);
  assert.equal(ownedError, 0);
  assert.equal(ownedStdout, 0);
  assert.equal(ownedStderr, 0);
}

function supervisedSeams(fake: ReturnType<typeof createFakeChildProcess>, scheduler: ManualTimerScheduler): ProcessSeams {
  return {
    spawn: fake.seams.spawn,
    schedule: scheduler.schedule.bind(scheduler),
  };
}

function assertSupervisionReleased(
  child: FakeChildHandle,
  scheduler: ManualTimerScheduler,
  options?: {
    externalStdout?: boolean;
    externalStderr?: boolean;
    externalClose?: boolean;
    externalError?: boolean;
    abortOwnership?: { adds: number; removes: number };
  },
): void {
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(child.listenerCount('spawn'), 0);
  const ownedClose = child.listenerCount('close') - (options?.externalClose ? 1 : 0);
  const ownedError = child.listenerCount('error') - (options?.externalError ? 1 : 0);
  const ownedStdout = (child.stdout?.listenerCount('data') ?? 0) - (options?.externalStdout ? 1 : 0);
  const ownedStderr = (child.stderr?.listenerCount('data') ?? 0) - (options?.externalStderr ? 1 : 0);
  assert.equal(ownedClose, 0);
  assert.equal(ownedError, 0);
  assert.equal(ownedStdout, 0);
  assert.equal(ownedStderr, 0);
  if (options?.abortOwnership) {
    assert.equal(options.abortOwnership.removes, 1);
    assert.ok(options.abortOwnership.adds >= options.abortOwnership.removes);
  }
}

function installExternalSentinels(child: FakeChildHandle): {
  externalStdout: boolean;
  externalStderr: boolean;
  externalClose: boolean;
  externalError: boolean;
} {
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  child.on('close', () => {});
  child.on('error', () => {});
  return {
    externalStdout: true,
    externalStderr: true,
    externalClose: true,
    externalError: true,
  };
}

function killAttemptsOf(result: Awaited<ReturnType<typeof runSupervisedProcess>>) {
  return result.termination?.killAttempts ?? [];
}

function trackAbortSignal(signal: AbortSignal): { adds: number; removes: number } {
  const counts = { adds: 0, removes: 0 };
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'abort') counts.adds += 1;
    return originalAdd(type, listener, options);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === 'abort') counts.removes += 1;
    return originalRemove(type, listener, options);
  }) as typeof signal.removeEventListener;
  return counts;
}

test('runProcess completes before escalation with typed completion metadata', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const pending = runSupervisedProcess('fixture-cmd', ['one'], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild();
  assert.ok(child);
  child.emitStdout('done');
  child.emitClose(0);
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'done');
  assert.equal(result.termination?.cause, 'completed');
  assert.equal(result.termination?.stage, 'exited');
  assert.equal(result.termination?.exitObserved, true);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess escalates SIGINT then SIGKILL on abort with injectable grace timer', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const kills: NodeJS.Signals[] = [];
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 250,
  });
  const child = fake.lastChild()!;
  child.kill = (signal?: NodeJS.Signals) => {
    kills.push(signal ?? 'SIGTERM');
    return true;
  };
  child.emitStdout('partial');
  controller.abort();
  assert.deepEqual(kills, ['SIGINT']);
  assert.deepEqual(scheduler.scheduledDelays(), [250]);
  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(scheduler.runNext(), 250);
  assert.deepEqual(kills, ['SIGINT', 'SIGKILL']);
  assert.deepEqual(scheduler.scheduledDelays(), [DEFAULT_POST_KILL_WATCHDOG_MS]);
  child.emitClose(null, 'SIGKILL');
  const result = await pending;
  assert.match(result.stdout, /partial/);
  assert.equal(result.termination?.cause, 'cancelled');
  assert.equal(result.termination?.stage, 'exited');
  assert.equal(result.termination?.exitObserved, true);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess does not spawn or signal when the external signal is already aborted', async () => {
  const fake = createFakeChildProcess();
  const controller = new AbortController();
  controller.abort();
  const result = await runProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: fake.seams,
  });
  assert.equal(fake.lastChild(), undefined);
  assert.equal(result.termination?.abortedBeforeSpawn, true);
  assert.equal(result.termination?.cause, 'cancelled');
  assert.equal(result.termination?.exitObserved, false);
  assert.equal(result.exitCode, 1);
});

test('runProcess does not signal during injected spawn before child handle is armed', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const kills: NodeJS.Signals[] = [];
  const seams: ProcessSeams = {
    spawn: ((command: string, args: string[], options: { cwd: string; stdio: ['ignore', 'pipe', 'pipe'] }) => {
      controller.abort();
      assert.equal(kills.length, 0);
      const child = fake.seams.spawn(command, args, options) as FakeChildHandle;
      child.kill = (signal?: NodeJS.Signals) => {
        kills.push(signal ?? 'SIGTERM');
        return true;
      };
      return child;
    }) as unknown as ProcessSeams['spawn'],
    schedule: scheduler.schedule.bind(scheduler),
  };
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams,
  });
  assert.deepEqual(kills, ['SIGINT']);
  const child = fake.lastChild()!;
  child.emitClose(null, 'SIGINT');
  const result = await pending;
  assert.deepEqual(kills, ['SIGINT']);
  assert.equal(result.termination?.cause, 'cancelled');
  assertSupervisionReleased(child, scheduler);
});

test('runProcess settles exactly once on spawn error even when abort is armed', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const ownership = trackAbortSignal(controller.signal);
  let settlements = 0;
  const pending = runProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
  })
    .then((result) => {
      settlements += 1;
      return result;
    })
    .catch((error: ProcessSpawnError) => {
      settlements += 1;
      throw error;
    });
  const child = fake.lastChild();
  assert.ok(child);
  const external = installExternalSentinels(child);
  const error = Object.assign(new Error('spawn failed'), { code: 'ENOENT', errno: -2 }) as NodeJS.ErrnoException;
  child.emitError(error);
  await assert.rejects(pending, (thrown: ProcessSpawnError) => {
    assert.equal(thrown.name, 'ProcessSpawnError');
    assert.equal(thrown.code, 'ENOENT');
    assert.equal(thrown.errno, -2);
    assert.equal(thrown.spawnRaceWinner, 'spawn_error');
    return true;
  });
  controller.abort();
  assert.equal(settlements, 1);
  assertSupervisionReleased(child, scheduler, { ...external, abortOwnership: ownership });
});

test('runProcess abort-before-spawn-error settles cancelled with race winner cancelled', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const ownership = trackAbortSignal(controller.signal);
  const pending = runProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  controller.abort();
  const error = Object.assign(new Error('spawn failed'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
  child.emitError(error);
  const result = await pending;
  assert.equal(result.termination?.cause, 'cancelled');
  assert.equal(result.termination?.spawnRaceWinner, 'cancelled');
  assert.equal(result.termination?.exitObserved, false);
  assertSupervisionReleased(child, scheduler, { ...external, abortOwnership: ownership });
});

test('runProcess ignores repeated abort notifications after escalation starts', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const kills: NodeJS.Signals[] = [];
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild()!;
  child.kill = (signal?: NodeJS.Signals) => {
    kills.push(signal ?? 'SIGTERM');
    return true;
  };
  controller.abort();
  controller.abort();
  assert.deepEqual(kills, ['SIGINT']);
  child.emitClose(null, 'SIGINT');
  const result = await pending;
  assert.equal(result.termination?.cause, 'cancelled');
  assert.equal(kills.length, 1);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess ignores stream output after terminal settlement', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild()!;
  child.emitStdout('before');
  child.emitClose(0);
  const result = await pending;
  child.emitStdout('after');
  assert.equal(result.stdout, 'before');
  assertSupervisionReleased(child, scheduler);
});

test('runProcess bounds stdout and stderr by bytes and exposes redacted truncation metadata', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
    stdoutLimitBytes: 5,
    stderrLimitBytes: 3,
  });
  const child = fake.lastChild()!;
  child.emitStdout('a🙂secret-shaped-discard');
  child.emitStderr('xyzsecret-shaped-discard');
  child.emitClose(0);
  const result = await pending;
  assert.equal(result.stdout, 'a🙂');
  assert.equal(result.stderr, 'xyz');
  assert.deepEqual(result.truncation?.map((entry) => entry.stream), ['stdout', 'stderr']);
  assert.ok(result.truncation?.every((entry) => entry.discardedBytes > 0));
  assert.doesNotMatch(JSON.stringify(result.truncation), /secret-shaped-discard/);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess bounds incomplete lines and does not emit a truncated line as valid protocol data', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const lines: string[] = [];
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
    partialLineLimitBytes: 4,
    onStdoutLine: (line) => lines.push(line),
  });
  const child = fake.lastChild()!;
  child.emitStdout('valid\noversized-secret\nnext\n');
  child.emitClose(0);
  const result = await pending;
  assert.deepEqual(lines, ['next']);
  const partial = result.truncation?.find((entry) => entry.stream === 'partial_line');
  assert.equal(partial?.channel, 'stdout');
  assert.equal(partial?.limitBytes, 4);
  assert.doesNotMatch(JSON.stringify(partial), /oversized-secret/);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess close detaches abort before trailing-line flush so callback abort cannot re-escalate', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const ownership = trackAbortSignal(controller.signal);
  const kills: NodeJS.Signals[] = [];
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    onStdoutLine: () => controller.abort(),
  });
  const child = fake.lastChild()!;
  child.kill = (signal?: NodeJS.Signals) => {
    kills.push(signal ?? 'SIGTERM');
    return true;
  };
  child.emitStdout('line-without-newline');
  child.emitClose(0);
  const result = await pending;
  assert.equal(result.stdout, 'line-without-newline');
  assert.equal(result.termination?.cause, 'completed');
  assert.deepEqual(kills, []);
  assertSupervisionReleased(child, scheduler, { abortOwnership: ownership });
});

test('runProcess records kill delivery failure without inventing success', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const ownership = trackAbortSignal(controller.signal);
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  child.kill = () => false;
  controller.abort();
  child.emitClose(null, 'SIGINT');
  const result = await pending;
  assert.equal(result.termination?.cause, 'cancelled');
  assert.equal(result.termination?.killDelivered, false);
  assert.deepEqual(killAttemptsOf(result), [{ signal: 'SIGINT', outcome: 'refused' }]);
  assert.equal(result.termination?.stage, 'exited');
  assert.equal(result.termination?.exitObserved, true);
  assertSupervisionReleased(child, scheduler, { ...external, abortOwnership: ownership });
});

test('runProcess records kill throws as undelivered without rejecting', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const ownership = trackAbortSignal(controller.signal);
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  child.kill = () => {
    throw new Error('kill failed');
  };
  controller.abort();
  child.emitClose(null, 'SIGINT');
  const result = await pending;
  assert.equal(result.termination?.killDelivered, false);
  assert.deepEqual(killAttemptsOf(result), [{ signal: 'SIGINT', outcome: 'thrown' }]);
  assert.equal(result.termination?.stage, 'exited');
  assert.equal(result.termination?.exitObserved, true);
  assertSupervisionReleased(child, scheduler, { ...external, abortOwnership: ownership });
});

test('runProcess settles termination_incomplete when SIGINT delivery fails and no close follows', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  let killCount = 0;
  child.kill = (signal?: NodeJS.Signals) => {
    killCount += 1;
    if (signal === 'SIGINT') return false;
    return true;
  };
  controller.abort();
  assert.equal(killCount, 1);
  assert.deepEqual(scheduler.scheduledDelays(), [50]);
  assert.equal(scheduler.runNext(), 50);
  assert.equal(killCount, 2);
  assert.deepEqual(scheduler.scheduledDelays(), [100]);
  assert.equal(scheduler.runNext(), 100);
  const result = await pending;
  assert.equal(result.termination?.stage, 'termination_incomplete');
  assert.equal(result.termination?.exitObserved, false);
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'refused' },
    { signal: 'SIGKILL', outcome: 'delivered' },
  ]);
  assert.equal(result.termination?.killSignal, 'SIGKILL');
  assert.equal(result.termination?.killDelivered, true);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess settles termination_incomplete when SIGKILL delivery fails and no close follows', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  let killCount = 0;
  child.kill = (signal?: NodeJS.Signals) => {
    killCount += 1;
    if (signal === 'SIGKILL') return false;
    return true;
  };
  controller.abort();
  assert.equal(scheduler.runNext(), 50);
  assert.equal(scheduler.runNext(), 100);
  const result = await pending;
  assert.equal(killCount, 2);
  assert.equal(result.termination?.stage, 'termination_incomplete');
  assert.equal(result.termination?.exitObserved, false);
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'delivered' },
    { signal: 'SIGKILL', outcome: 'refused' },
  ]);
  assert.equal(result.termination?.killSignal, 'SIGKILL');
  assertSupervisionReleased(child, scheduler);
});

test('runProcess prefers later close over termination_incomplete watchdog when kill delivery fails', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  let killCount = 0;
  child.kill = (signal?: NodeJS.Signals) => {
    killCount += 1;
    if (signal === 'SIGINT') return false;
    return true;
  };
  controller.abort();
  assert.equal(scheduler.runNext(), 50);
  child.emitClose(null, 'SIGKILL');
  const result = await pending;
  assert.equal(killCount, 2);
  assert.equal(result.termination?.exitObserved, true);
  assert.equal(result.termination?.stage, 'exited');
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'refused' },
    { signal: 'SIGKILL', outcome: 'delivered' },
  ]);
  assert.equal(result.termination?.killSignal, 'SIGKILL');
  assert.equal(scheduler.pendingCount(), 0);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess settles termination_incomplete when SIGKILL delivery throws and no close follows', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  child.kill = (signal?: NodeJS.Signals) => {
    if (signal === 'SIGKILL') throw new Error('kill failed');
    return true;
  };
  controller.abort();
  assert.equal(scheduler.runNext(), 50);
  assert.deepEqual(scheduler.scheduledDelays(), [100]);
  assert.equal(scheduler.runNext(), 100);
  const result = await pending;
  assert.equal(result.termination?.stage, 'termination_incomplete');
  assert.equal(result.termination?.exitObserved, false);
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'delivered' },
    { signal: 'SIGKILL', outcome: 'thrown' },
  ]);
  assert.equal(result.termination?.killSignal, 'SIGKILL');
  assert.equal(result.termination?.killDelivered, false);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess prefers later close over SIGKILL throw watchdog', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  child.kill = (signal?: NodeJS.Signals) => {
    if (signal === 'SIGKILL') throw new Error('kill failed');
    return true;
  };
  controller.abort();
  assert.equal(scheduler.runNext(), 50);
  child.emitClose(null, 'SIGKILL');
  const result = await pending;
  assert.equal(result.termination?.exitObserved, true);
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'delivered' },
    { signal: 'SIGKILL', outcome: 'thrown' },
  ]);
  assert.equal(result.termination?.killSignal, 'SIGKILL');
  assert.equal(result.termination?.killDelivered, false);
  assert.equal(scheduler.pendingCount(), 0);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess prefers later close over SIGKILL false watchdog', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  child.kill = (signal?: NodeJS.Signals) => signal !== 'SIGKILL';
  controller.abort();
  assert.equal(scheduler.runNext(), 50);
  child.emitClose(null, 'SIGKILL');
  const result = await pending;
  assert.equal(result.termination?.exitObserved, true);
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'delivered' },
    { signal: 'SIGKILL', outcome: 'refused' },
  ]);
  assert.equal(result.termination?.killDelivered, false);
  assert.equal(scheduler.pendingCount(), 0);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess settles termination_incomplete when SIGINT throw and no close follows via SIGKILL watchdog', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  child.kill = (signal?: NodeJS.Signals) => {
    if (signal === 'SIGINT') throw new Error('sigint failed');
    return true;
  };
  controller.abort();
  assert.deepEqual(scheduler.scheduledDelays(), [50]);
  assert.equal(scheduler.runNext(), 50);
  assert.deepEqual(scheduler.scheduledDelays(), [100]);
  assert.equal(scheduler.runNext(), 100);
  const result = await pending;
  assert.equal(result.termination?.stage, 'termination_incomplete');
  assert.equal(result.termination?.exitObserved, false);
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'thrown' },
    { signal: 'SIGKILL', outcome: 'delivered' },
  ]);
  assert.equal(result.termination?.killSignal, 'SIGKILL');
  assertSupervisionReleased(child, scheduler);
});

test('runProcess prefers later close over SIGINT throw without preempting SIGKILL', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const kills: NodeJS.Signals[] = [];
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
  });
  const child = fake.lastChild()!;
  child.kill = (signal?: NodeJS.Signals) => {
    const resolved = signal ?? 'SIGTERM';
    kills.push(resolved);
    if (resolved === 'SIGINT') throw new Error('sigint failed');
    return true;
  };
  controller.abort();
  assert.equal(scheduler.runNext(), 50);
  child.emitClose(null, 'SIGKILL');
  const result = await pending;
  assert.deepEqual(kills, ['SIGINT', 'SIGKILL']);
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'thrown' },
    { signal: 'SIGKILL', outcome: 'delivered' },
  ]);
  assert.equal(result.termination?.exitObserved, true);
  assert.equal(result.termination?.killSignal, 'SIGKILL');
  assert.equal(result.termination?.killDelivered, true);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess settles termination_incomplete when delivered SIGKILL has no close', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  controller.abort();
  assert.equal(scheduler.runNext(), 50);
  assert.deepEqual(scheduler.scheduledDelays(), [100]);
  assert.equal(scheduler.runNext(), 100);
  const result = await pending;
  assert.equal(result.termination?.stage, 'termination_incomplete');
  assert.equal(result.termination?.exitObserved, false);
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'delivered' },
    { signal: 'SIGKILL', outcome: 'delivered' },
  ]);
  assert.equal(result.termination?.killSignal, 'SIGKILL');
  assert.equal(result.termination?.killDelivered, true);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess preserves separate SIGINT and SIGKILL delivery metadata on watchdog settle', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  child.kill = (signal?: NodeJS.Signals) => signal !== 'SIGINT';
  controller.abort();
  assert.equal(scheduler.runNext(), 50);
  assert.equal(scheduler.runNext(), 100);
  const result = await pending;
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'refused' },
    { signal: 'SIGKILL', outcome: 'delivered' },
  ]);
  assert.equal(result.termination?.killSignal, 'SIGKILL');
  assert.equal(result.termination?.killDelivered, true);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess ignores post-spawn error during cancellation and still escalates to SIGKILL', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const ownership = trackAbortSignal(controller.signal);
  const kills: NodeJS.Signals[] = [];
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  child.kill = (signal?: NodeJS.Signals) => {
    kills.push(signal ?? 'SIGTERM');
    return true;
  };
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  controller.abort();
  assert.deepEqual(kills, ['SIGINT']);
  assert.equal(scheduler.pendingCount(), 1);
  const error = Object.assign(new Error('post-spawn runtime'), { code: 'EIO', errno: -5 });
  child.emitError(error);
  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(scheduler.runNext(), 50);
  assert.deepEqual(scheduler.scheduledDelays(), [100]);
  scheduler.runNext();
  const result = await pending;
  assert.equal(result.termination?.cause, 'cancelled');
  assert.equal(result.termination?.spawnRaceWinner, undefined);
  assert.equal(result.termination?.stage, 'termination_incomplete');
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'delivered' },
    { signal: 'SIGKILL', outcome: 'delivered' },
  ]);
  assertSupervisionReleased(child, scheduler, { ...external, abortOwnership: ownership });
});

test('runProcess rejects synchronous spawn throw with ProcessSpawnError', async () => {
  const scheduler = new ManualTimerScheduler();
  const seams: ProcessSeams = {
    spawn: (() => {
      const error = Object.assign(new Error('sync spawn failed'), { code: 'EACCES', errno: -13 });
      throw error;
    }) as unknown as ProcessSeams['spawn'],
    schedule: scheduler.schedule.bind(scheduler),
  };
  await assert.rejects(
    runSupervisedProcess('fixture-cmd', [], { cwd: '/tmp', seams }),
    (thrown: ProcessSpawnError) => {
      assert.equal(thrown.name, 'ProcessSpawnError');
      assert.equal(thrown.code, 'EACCES');
      assert.equal(thrown.errno, -13);
      assert.equal(thrown.spawnRaceWinner, 'spawn_error');
      return true;
    },
  );
  assert.equal(scheduler.pendingCount(), 0);
});

test('runProcess synchronous spawn throw loses to cancellation observed during spawn', async () => {
  const controller = new AbortController();
  const scheduler = new ManualTimerScheduler();
  const seams: ProcessSeams = {
    spawn: (() => {
      controller.abort();
      throw Object.assign(new Error('sync spawn failed'), { code: 'ENOENT' });
    }) as unknown as ProcessSeams['spawn'],
    schedule: scheduler.schedule.bind(scheduler),
  };
  const result = await runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams,
  });
  assert.equal(result.termination?.cause, 'cancelled');
  assert.equal(result.termination?.spawnRaceWinner, 'cancelled');
  assert.equal(result.termination?.abortedBeforeSpawn, true);
  assert.equal(scheduler.pendingCount(), 0);
});

test('runProcess removes only supervisor-owned abort listener', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const ownership = trackAbortSignal(controller.signal);
  const externalAbort = () => {};
  controller.signal.addEventListener('abort', externalAbort);
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild()!;
  child.emitClose(0);
  await pending;
  assert.equal(ownership.adds, 2);
  assert.equal(ownership.removes, 1);
  controller.signal.removeEventListener('abort', externalAbort);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess cleanup preserves external child stream listeners', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  let externalStdoutHits = 0;
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild()!;
  child.stdout?.on('data', () => {
    externalStdoutHits += 1;
  });
  child.emitStdout('owned');
  child.emitClose(0);
  await pending;
  child.emitStdout('external');
  assert.equal(externalStdoutHits, 2);
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.stdout?.listenerCount('data'), 1);
  assert.equal(child.stderr?.listenerCount('data') ?? 0, 0);
});

test('runProcess maps null exit codes to exitCode 1', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild()!;
  child.emitClose(null);
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.equal(result.termination?.cause, 'exit_failure');
  assertSupervisionReleased(child, scheduler);
});

test('runProcess close-before-abort completes normally', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const ownership = trackAbortSignal(controller.signal);
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild()!;
  child.emitStdout('closed-cleanly');
  child.emitClose(0);
  controller.abort();
  const result = await pending;
  assert.equal(result.stdout, 'closed-cleanly');
  assert.equal(result.termination?.cause, 'completed');
  assertSupervisionReleased(child, scheduler, { abortOwnership: ownership });
});

test('runProcess non-zero exit retains stderr and typed exit_failure metadata', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  child.emitStderr('failed');
  child.emitClose(4);
  const result = await pending;
  assert.equal(result.exitCode, 4);
  assert.equal(result.stderr, 'failed');
  assert.equal(result.termination?.cause, 'exit_failure');
  assertSupervisionReleased(child, scheduler, external);
});

test('runProcess abort during active streaming preserves partial stdout once', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  let sawChunk = false;
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    onStdoutChunk: (chunk) => {
      if (!sawChunk && chunk.includes('streamed-partial')) {
        sawChunk = true;
        controller.abort();
      }
    },
  });
  const child = fake.lastChild()!;
  child.emitStdout('streamed-partial');
  scheduler.runNext();
  child.emitClose(null, 'SIGKILL');
  const result = await pending;
  assert.equal(sawChunk, true);
  assert.match(result.stdout, /streamed-partial/);
  assert.equal(result.termination?.cause, 'cancelled');
  assertSupervisionReleased(child, scheduler);
});

test('runProcess records SIGINT kill attempt before reentrant close without scheduling grace or watchdog', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const ownership = trackAbortSignal(controller.signal);
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 250,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  child.kill = (signal?: NodeJS.Signals) => {
    child.emitClose(null, signal ?? 'SIGTERM');
    return true;
  };
  controller.abort();
  const result = await pending;
  assert.deepEqual(killAttemptsOf(result), [{ signal: 'SIGINT', outcome: 'delivered' }]);
  assert.equal(result.termination?.exitObserved, true);
  assert.equal(result.termination?.stage, 'exited');
  assert.equal(result.termination?.cause, 'cancelled');
  assert.deepEqual(scheduler.scheduleHistory(), []);
  assert.equal(scheduler.pendingCount(), 0);
  assertSupervisionReleased(child, scheduler, { ...external, abortOwnership: ownership });
});

test('runProcess records SIGKILL kill attempt before reentrant close without post-kill watchdog', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const controller = new AbortController();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
  });
  const child = fake.lastChild()!;
  child.kill = (signal?: NodeJS.Signals) => {
    if (signal === 'SIGKILL') child.emitClose(null, 'SIGKILL');
    return true;
  };
  controller.abort();
  assert.equal(scheduler.runNext(), 50);
  const result = await pending;
  assert.deepEqual(killAttemptsOf(result), [
    { signal: 'SIGINT', outcome: 'delivered' },
    { signal: 'SIGKILL', outcome: 'delivered' },
  ]);
  assert.equal(result.termination?.exitObserved, true);
  assert.equal(result.termination?.stage, 'exited');
  assert.deepEqual(scheduler.scheduleHistory(), [50]);
  assert.equal(scheduler.pendingCount(), 0);
  assertSupervisionReleased(child, scheduler);
});

test('runProcess rejects once when streaming stdout callback throws after terminating the child', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  let settlements = 0;
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
    onStdoutChunk: () => {
      throw new Error('chunk callback failed');
    },
  })
    .then((result) => {
      settlements += 1;
      return result;
    })
    .catch((error: ProcessCallbackError) => {
      settlements += 1;
      throw error;
    });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  child.emitStdout('boom');
  assert.deepEqual(scheduler.scheduledDelays(), [50]);
  assert.equal(scheduler.runNext(), 50);
  child.emitClose(1);
  await assert.rejects(pending, (thrown: ProcessCallbackError) => {
    assert.equal(thrown.name, 'ProcessCallbackError');
    assert.equal(thrown.callback, 'onStdoutChunk');
    assert.match(thrown.message, /onStdoutChunk/);
    return true;
  });
  assert.equal(settlements, 1);
  assertSupervisionReleased(child, scheduler, external);
});

test('runProcess rejects once when trailing stdout line callback throws on close', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  let settlements = 0;
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
    onStdoutLine: () => {
      throw new Error('line callback failed');
    },
  })
    .then((result) => {
      settlements += 1;
      return result;
    })
    .catch((error: ProcessCallbackError) => {
      settlements += 1;
      throw error;
    });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  child.emitStdout('line-without-newline');
  child.emitClose(0);
  await assert.rejects(pending, (thrown: ProcessCallbackError) => {
    assert.equal(thrown.name, 'ProcessCallbackError');
    assert.equal(thrown.callback, 'onStdoutLine');
    return true;
  });
  assert.equal(settlements, 1);
  assertSupervisionReleased(child, scheduler, external);
});

test('runProcess rejects once when stderr line callback throws during streaming after child termination', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  let settlements = 0;
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    onStderrLine: () => {
      throw new Error('stderr line failed');
    },
  })
    .then((result) => {
      settlements += 1;
      return result;
    })
    .catch((error: ProcessCallbackError) => {
      settlements += 1;
      throw error;
    });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  child.emitStderr('err-line\n');
  assert.equal(scheduler.runNext(), 50);
  child.emitClose(1);
  await assert.rejects(pending, (thrown: ProcessCallbackError) => {
    assert.equal(thrown.callback, 'onStderrLine');
    return true;
  });
  assert.equal(settlements, 1);
  assertSupervisionReleased(child, scheduler, external);
});

test('runProcess rejects once with original ProcessCallbackError when callback throws then child emits EIO', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  let settlements = 0;
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
    onStdoutChunk: () => {
      throw new Error('chunk callback failed');
    },
  })
    .then((result) => {
      settlements += 1;
      return result;
    })
    .catch((error: ProcessCallbackError | ProcessSpawnError) => {
      settlements += 1;
      throw error;
    });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  child.emitStdout('boom');
  assert.deepEqual(scheduler.scheduledDelays(), [50]);
  assert.equal(scheduler.runNext(), 50);
  const error = Object.assign(new Error('post-spawn runtime'), { code: 'EIO', errno: -5 });
  child.emitError(error);
  assert.equal(scheduler.pendingCount(), 1);
  child.emitClose(1);
  await assert.rejects(pending, (thrown: ProcessCallbackError) => {
    assert.equal(thrown.name, 'ProcessCallbackError');
    assert.equal(thrown.callback, 'onStdoutChunk');
    assert.notEqual(thrown.name, 'ProcessSpawnError');
    return true;
  });
  assert.equal(settlements, 1);
  assertSupervisionReleased(child, scheduler, external);
});

test('runProcessLegacy rejects when complete-line callback throws after close settles escalation', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  let settlements = 0;
  const pending = runProcessLegacy('fixture-cmd', [], {
    cwd: '/tmp',
    seams: legacySeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
    onStdoutLine: () => {
      throw new Error('legacy line failed');
    },
  })
    .then((result) => {
      settlements += 1;
      return result;
    })
    .catch((error: ProcessCallbackError) => {
      settlements += 1;
      throw error;
    });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  child.emitStdout('line\n');
  assert.deepEqual(scheduler.scheduledDelays(), [50]);
  assert.equal(scheduler.runNext(), 50);
  assert.deepEqual(scheduler.scheduledDelays(), [100]);
  child.emitClose(1);
  await assert.rejects(pending, (thrown: ProcessCallbackError) => {
    assert.equal(thrown.callback, 'onStdoutLine');
    return true;
  });
  assert.equal(settlements, 1);
  child.emitClose(0);
  assert.equal(settlements, 1);
  assertLegacyOwnershipReleased(child, scheduler, external);
});

test('runProcessLegacy cleanup preserves external child stream listeners after callback failure', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  let externalStdoutHits = 0;
  const pending = runProcessLegacy('fixture-cmd', [], {
    cwd: '/tmp',
    seams: legacySeams(fake, scheduler),
    killGraceMs: 50,
    onStdoutLine: () => {
      throw new Error('legacy line failed');
    },
  }).catch((error: ProcessCallbackError) => error);
  const child = fake.lastChild()!;
  child.stdout?.on('data', () => {
    externalStdoutHits += 1;
  });
  child.stderr?.on('data', () => {});
  child.on('close', () => {});
  child.on('error', () => {});
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  child.emitStdout('line\n');
  scheduler.runNext();
  child.emitClose(1);
  await pending;
  child.emitStdout('external');
  assert.equal(externalStdoutHits, 2);
  assertLegacyOwnershipReleased(child, scheduler, {
    externalStdout: true,
    externalStderr: true,
    externalClose: true,
    externalError: true,
  });
});

test('runProcessLegacy records SIGINT before reentrant close without scheduling grace after settlement', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  let settlements = 0;
  const pending = runProcessLegacy('fixture-cmd', [], {
    cwd: '/tmp',
    seams: legacySeams(fake, scheduler),
    killGraceMs: 50,
    postKillWatchdogMs: 100,
    onStdoutLine: () => {
      throw new Error('legacy line failed');
    },
  })
    .then((result) => {
      settlements += 1;
      return result;
    })
    .catch((error: ProcessCallbackError) => {
      settlements += 1;
      throw error;
    });
  const child = fake.lastChild()!;
  const external = installExternalSentinels(child);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  child.kill = (signal?: NodeJS.Signals) => {
    child.emitClose(1, signal ?? 'SIGTERM');
    return true;
  };
  child.emitStdout('line\n');
  await assert.rejects(pending, (thrown: ProcessCallbackError) => {
    assert.equal(thrown.callback, 'onStdoutLine');
    return true;
  });
  assert.equal(settlements, 1);
  assert.deepEqual(scheduler.scheduleHistory(), []);
  assert.equal(scheduler.pendingCount(), 0);
  assertLegacyOwnershipReleased(child, scheduler, external);
});

test('runProcessLegacy leaves no live child after real callback failure', { timeout: 5_000 }, async () => {
  const scheduler = new ManualTimerScheduler();
  let legacyChild: ChildProcess | undefined;

  const reapLegacyChild = async (): Promise<void> => {
    if (!legacyChild?.pid) return;
    try {
      process.kill(legacyChild.pid, 0);
    } catch {
      return;
    }
    try {
      legacyChild.kill('SIGKILL');
    } catch {
      // Best-effort cleanup for a still-live probe child.
    }
    await new Promise<void>((resolve) => {
      const child = legacyChild!;
      child.once('close', () => resolve());
      setTimeout(resolve, 250);
    });
  };

  try {
    const seams: ProcessSeams = {
      spawn: ((command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] }) => {
        legacyChild = spawn(command, args, options);
        return legacyChild;
      }) as ProcessSeams['spawn'],
      schedule: scheduler.schedule.bind(scheduler),
    };
    const pending = runProcessLegacy(
      process.execPath,
      ['-e', "process.stdout.write('probe\\n'); setInterval(()=>{}, 200);"],
      {
        cwd: '/tmp',
        seams,
        killGraceMs: 50,
        postKillWatchdogMs: 100,
        onStdoutLine: () => {
          throw new Error('legacy line failed');
        },
      },
    );
    const rejection = Promise.race([
      pending.catch((error: ProcessCallbackError) => error),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for legacy callback failure')), 3_000);
      }),
    ]);

    const escalationDeadline = Date.now() + 2_000;
    while (scheduler.pendingCount() === 0 && Date.now() < escalationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    while (scheduler.pendingCount() > 0) {
      scheduler.runNext();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    const error = await rejection;
    assert.ok(error instanceof ProcessCallbackError);
    assert.equal(error.callback, 'onStdoutLine');
    assert.ok(legacyChild?.pid);
    assert.throws(() => process.kill(legacyChild!.pid!, 0));
  } finally {
    await reapLegacyChild();
  }
});

test('runProcess leaves no live child after real callback failure', async () => {
  const scheduler = new ManualTimerScheduler();
  let supervisedChild: ChildProcess | undefined;
  const seams: ProcessSeams = {
    spawn: ((command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] }) => {
      supervisedChild = spawn(command, args, options);
      return supervisedChild;
    }) as ProcessSeams['spawn'],
    schedule: scheduler.schedule.bind(scheduler),
  };
  const pending = runSupervisedProcess(
    process.execPath,
    ['-e', "process.stdout.write('probe\\n'); setInterval(()=>{}, 200);"],
    {
      cwd: '/tmp',
      seams,
      killGraceMs: 50,
      postKillWatchdogMs: 100,
      onStdoutLine: () => {
        throw new Error('line failed');
      },
    },
  );
  const rejection = pending.catch((error: ProcessCallbackError) => error);
  while (scheduler.pendingCount() > 0) {
    scheduler.runNext();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  const error = await rejection;
  assert.ok(error instanceof ProcessCallbackError);
  assert.equal(error.callback, 'onStdoutLine');
  assert.ok(supervisedChild?.pid);
  assert.throws(() => process.kill(supervisedChild!.pid!, 0));
});

test('runProcessLegacy retains legacy untyped completion without inventing typed success after abort', async () => {
  const fake = createFakeChildProcess();
  const controller = new AbortController();
  const pending = runProcessLegacy('fixture-cmd', [], {
    cwd: '/tmp',
    signal: controller.signal,
    seams: fake.seams,
  });
  const child = fake.lastChild()!;
  controller.abort();
  child.emitClose(null, 'SIGINT');
  const result = await pending;
  assert.equal(result.termination, undefined);
  assert.equal(result.exitCode, 1);
});

test('explicit legacy runner remains byte-bounded and reports truncation', async () => {
  const fake = createFakeChildProcess();
  const pending = runProcess('fixture-cmd', [], {
    cwd: '/tmp',
    runner: 'legacy',
    seams: fake.seams,
    stdoutLimitBytes: 4,
  });
  const child = fake.lastChild()!;
  child.emitStdout('safe-secret-shaped-discard');
  child.emitClose(0);
  const result = await pending;
  assert.equal(result.termination, undefined);
  assert.equal(result.stdout, 'safe');
  assert.equal(result.truncation?.[0]?.stream, 'stdout');
  assert.doesNotMatch(JSON.stringify(result.truncation), /secret-shaped-discard/);
});

test('explicit legacy runner does not spawn when its signal is already aborted', async () => {
  const fake = createFakeChildProcess();
  const controller = new AbortController();
  controller.abort();
  const result = await runProcess('fixture-cmd', [], {
    cwd: '/tmp',
    runner: 'legacy',
    signal: controller.signal,
    seams: fake.seams,
  });
  assert.equal(fake.lastChild(), undefined);
  assert.equal(result.exitCode, 1);
  assert.equal(result.termination, undefined);
});

test('runProcess is the supervised default export used by adapters', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const pending = runProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild()!;
  child.emitClose(0);
  const result = await pending;
  assert.ok(result.termination);
  assertSupervisionReleased(child, scheduler);
});

test('supervised runner uses default kill grace and post-kill watchdog constants', () => {
  assert.equal(DEFAULT_KILL_GRACE_MS, 1_500);
  assert.equal(DEFAULT_POST_KILL_WATCHDOG_MS, 500);
});

test('fake child helper exposes controllable stdout/stderr/close/error events', async () => {
  const fake = createFakeChildProcess();
  const scheduler = new ManualTimerScheduler();
  const pending = runSupervisedProcess('fixture-cmd', [], {
    cwd: '/tmp',
    seams: supervisedSeams(fake, scheduler),
  });
  const child = fake.lastChild() as FakeChildHandle;
  child.emitStdout('a');
  child.emitStderr('b');
  child.emitClose(0);
  const result = await pending;
  assert.equal(result.stdout, 'a');
  assert.equal(result.stderr, 'b');
  assertSupervisionReleased(child, scheduler);
});
