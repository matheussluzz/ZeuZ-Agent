import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPhaseAbortSource,
  deadlineConfigFromEnvironment,
  deadlineExpiresAt,
  DEFAULT_PRODUCER_DEADLINE_MS,
  DEFAULT_REMEDIATION_DEADLINE_MS,
  DEFAULT_REVIEW_DEADLINE_MS,
  DeadlineConfigurationError,
  hasDeadlineExpired,
  MAX_PRODUCER_DEADLINE_MS,
  MAX_REMEDIATION_DEADLINE_MS,
  MAX_REVIEW_DEADLINE_MS,
  resolveDeadlinePolicy,
  validatePhaseDeadline,
  type Clock,
  type TimerHandle,
  type TimerScheduler,
} from '../src/deadline-policy.js';

class FakeClock implements Clock {
  private now = 0;

  constructor(startMs = 0) {
    this.now = startMs;
  }

  nowMs(): number {
    return this.now;
  }

  advance(ms: number): void {
    this.now += ms;
  }

  set(ms: number): void {
    this.now = ms;
  }
}

class FakeScheduler implements TimerScheduler {
  private readonly tasks: Array<{ atMs: number; callback: () => void; handle: TimerHandle }> = [];

  constructor(private readonly clock: FakeClock) {}

  schedule(delayMs: number, callback: () => void): TimerHandle {
    const atMs = this.clock.nowMs() + delayMs;
    const task = {
      atMs,
      callback,
      handle: {
        clear: () => {
          const index = this.tasks.indexOf(task);
          if (index >= 0) this.tasks.splice(index, 1);
        },
      },
    };
    this.tasks.push(task);
    return task.handle;
  }

  runDue(): void {
    const now = this.clock.nowMs();
    const due = this.tasks.filter((task) => task.atMs <= now);
    for (const task of due) {
      task.callback();
      task.handle.clear();
    }
  }
}

test('resolveDeadlinePolicy applies documented defaults', () => {
  const policy = resolveDeadlinePolicy();
  assert.equal(policy.producerMs, DEFAULT_PRODUCER_DEADLINE_MS);
  assert.equal(policy.reviewMs, DEFAULT_REVIEW_DEADLINE_MS);
  assert.equal(policy.remediationMs, DEFAULT_REMEDIATION_DEADLINE_MS);
});

test('resolveDeadlinePolicy accepts configured values at exact maxima', () => {
  const policy = resolveDeadlinePolicy({
    producerMs: MAX_PRODUCER_DEADLINE_MS,
    reviewMs: MAX_REVIEW_DEADLINE_MS,
    remediationMs: MAX_REMEDIATION_DEADLINE_MS,
  });
  assert.equal(policy.producerMs, MAX_PRODUCER_DEADLINE_MS);
  assert.equal(policy.reviewMs, MAX_REVIEW_DEADLINE_MS);
  assert.equal(policy.remediationMs, MAX_REMEDIATION_DEADLINE_MS);
});

for (const [phase, max, aboveMax] of [
  ['producer', MAX_PRODUCER_DEADLINE_MS, MAX_PRODUCER_DEADLINE_MS + 1],
  ['review', MAX_REVIEW_DEADLINE_MS, MAX_REVIEW_DEADLINE_MS + 1],
  ['remediation', MAX_REMEDIATION_DEADLINE_MS, MAX_REMEDIATION_DEADLINE_MS + 1],
] as const) {
  test(`validatePhaseDeadline rejects above-maximum ${phase} deadlines`, () => {
    assert.throws(
      () => validatePhaseDeadline(phase, aboveMax),
      (error: DeadlineConfigurationError) => {
        assert.equal(error.name, 'DeadlineConfigurationError');
        assert.equal(error.phase, phase);
        assert.match(error.message, /exceeds maximum/i);
        return true;
      },
    );
  });

  test(`validatePhaseDeadline rejects very large ${phase} deadlines`, () => {
    assert.throws(
      () => validatePhaseDeadline(phase, Number.MAX_SAFE_INTEGER),
      DeadlineConfigurationError,
    );
  });
}

for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  test(`validatePhaseDeadline rejects invalid producer value ${String(invalid)}`, () => {
    assert.throws(() => validatePhaseDeadline('producer', invalid), DeadlineConfigurationError);
  });
}

test('validatePhaseDeadline accepts zero as immediate timeout', () => {
  assert.equal(validatePhaseDeadline('producer', 0), 0);
});

test('deadline boundary is inclusive at startedAt + deadlineMs', () => {
  const clock = new FakeClock(1_000);
  const startedAt = clock.nowMs();
  const deadlineMs = 500;
  assert.equal(hasDeadlineExpired(clock, startedAt, deadlineMs), false);
  clock.set(deadlineExpiresAt(startedAt, deadlineMs));
  assert.equal(hasDeadlineExpired(clock, startedAt, deadlineMs), true);
});

test('createPhaseAbortSource aborts immediately when deadline is zero', () => {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const policy = resolveDeadlinePolicy({ producerMs: 0 });
  const source = createPhaseAbortSource({
    phase: 'producer',
    policy,
    clock,
    scheduler,
  });
  assert.equal(source.signal.aborted, true);
  assert.equal(source.getCause(), 'deadline');
  source.dispose();
});

test('createPhaseAbortSource fires deadline at exact boundary with injected scheduler', () => {
  const clock = new FakeClock(10_000);
  const scheduler = new FakeScheduler(clock);
  const policy = resolveDeadlinePolicy({ reviewMs: 250 });
  const source = createPhaseAbortSource({
    phase: 'review',
    policy,
    clock,
    scheduler,
  });
  assert.equal(source.signal.aborted, false);
  clock.advance(249);
  scheduler.runDue();
  assert.equal(source.signal.aborted, false);
  clock.advance(1);
  scheduler.runDue();
  assert.equal(source.signal.aborted, true);
  assert.equal(source.getCause(), 'deadline');
  assert.equal(source.getCauseAtMs(), 10_250);
  source.dispose();
});

test('createPhaseAbortSource preserves earliest external cause over later deadline', () => {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const external = new AbortController();
  const policy = resolveDeadlinePolicy({ remediationMs: 1_000 });
  const source = createPhaseAbortSource({
    phase: 'remediation',
    policy,
    externalSignal: external.signal,
    clock,
    scheduler,
  });
  clock.advance(100);
  external.abort();
  clock.advance(2_000);
  scheduler.runDue();
  assert.equal(source.getCause(), 'external');
  assert.equal(source.getCauseAtMs(), 100);
  source.dispose();
});

test('createPhaseAbortSource preserves earliest deadline cause over later external abort', () => {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const external = new AbortController();
  const policy = resolveDeadlinePolicy({ producerMs: 100 });
  const source = createPhaseAbortSource({
    phase: 'producer',
    policy,
    externalSignal: external.signal,
    clock,
    scheduler,
  });
  clock.advance(100);
  scheduler.runDue();
  clock.advance(50);
  external.abort();
  assert.equal(source.getCause(), 'deadline');
  assert.equal(source.getCauseAtMs(), 100);
  source.dispose();
});

test('each phase abort source owns a fresh AbortSignal', () => {
  const policy = resolveDeadlinePolicy();
  const first = createPhaseAbortSource({ phase: 'producer', policy });
  const second = createPhaseAbortSource({ phase: 'review', policy });
  assert.notEqual(first.signal, second.signal);
  first.dispose();
  second.dispose();
});

test('createPhaseAbortSource disposes timers and external listeners', () => {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const external = new AbortController();
  const policy = resolveDeadlinePolicy({ producerMs: 1_000 });
  const source = createPhaseAbortSource({
    phase: 'producer',
    policy,
    externalSignal: external.signal,
    clock,
    scheduler,
  });
  source.dispose();
  clock.advance(5_000);
  scheduler.runDue();
  external.abort();
  assert.equal(source.signal.aborted, false);
  assert.equal(source.getCause(), undefined);
});

test('pre-aborted external signal records external cause without waiting for deadline', () => {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const external = new AbortController();
  external.abort();
  const policy = resolveDeadlinePolicy();
  const source = createPhaseAbortSource({
    phase: 'producer',
    policy,
    externalSignal: external.signal,
    clock,
    scheduler,
  });
  assert.equal(source.signal.aborted, true);
  assert.equal(source.getCause(), 'external');
  source.dispose();
});

test('pre-aborted external signal wins tie over deadline zero', () => {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const external = new AbortController();
  external.abort();
  const policy = resolveDeadlinePolicy({ producerMs: 0 });
  const source = createPhaseAbortSource({
    phase: 'producer',
    policy,
    externalSignal: external.signal,
    clock,
    scheduler,
  });
  assert.equal(source.signal.aborted, true);
  assert.equal(source.getCause(), 'external');
  assert.equal(source.getCauseAtMs(), 0);
  source.dispose();
});

test('deadline zero without external signal records deadline cause', () => {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const policy = resolveDeadlinePolicy({ reviewMs: 0 });
  const source = createPhaseAbortSource({
    phase: 'review',
    policy,
    clock,
    scheduler,
  });
  assert.equal(source.signal.aborted, true);
  assert.equal(source.getCause(), 'deadline');
  source.dispose();
});

test('deadline environment configuration is explicit and validated by the shared policy', () => {
  const config = deadlineConfigFromEnvironment({
    ZEUZ_PRODUCER_DEADLINE_MS: '1200',
    ZEUZ_REVIEW_DEADLINE_MS: '0',
    ZEUZ_REMEDIATION_DEADLINE_MS: '2400',
  });
  assert.deepEqual(resolveDeadlinePolicy(config), {
    producerMs: 1200,
    reviewMs: 0,
    remediationMs: 2400,
  });
  assert.throws(
    () => resolveDeadlinePolicy(deadlineConfigFromEnvironment({ ZEUZ_REVIEW_DEADLINE_MS: 'not-a-number' })),
    DeadlineConfigurationError,
  );
});
