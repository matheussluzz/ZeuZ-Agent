export type PhaseKind = 'producer' | 'review' | 'remediation';

export const DEFAULT_PRODUCER_DEADLINE_MS = 3_600_000;
export const DEFAULT_REVIEW_DEADLINE_MS = 1_800_000;
export const DEFAULT_REMEDIATION_DEADLINE_MS = 3_600_000;

export const MAX_PRODUCER_DEADLINE_MS = 7_200_000;
export const MAX_REVIEW_DEADLINE_MS = 3_600_000;
export const MAX_REMEDIATION_DEADLINE_MS = 7_200_000;

export interface DeadlinePolicy {
  producerMs: number;
  reviewMs: number;
  remediationMs: number;
}

export interface PartialDeadlineConfig {
  producerMs?: number;
  reviewMs?: number;
  remediationMs?: number;
}

export function deadlineConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): PartialDeadlineConfig {
  const config: PartialDeadlineConfig = {};
  if (env.ZEUZ_PRODUCER_DEADLINE_MS !== undefined) config.producerMs = Number(env.ZEUZ_PRODUCER_DEADLINE_MS);
  if (env.ZEUZ_REVIEW_DEADLINE_MS !== undefined) config.reviewMs = Number(env.ZEUZ_REVIEW_DEADLINE_MS);
  if (env.ZEUZ_REMEDIATION_DEADLINE_MS !== undefined) config.remediationMs = Number(env.ZEUZ_REMEDIATION_DEADLINE_MS);
  return config;
}

export class DeadlineConfigurationError extends Error {
  readonly phase: PhaseKind;
  readonly value: number;

  constructor(phase: PhaseKind, value: number, message: string) {
    super(message);
    this.name = 'DeadlineConfigurationError';
    this.phase = phase;
    this.value = value;
  }
}

export interface Clock {
  nowMs(): number;
}

export interface TimerHandle {
  clear(): void;
}

export interface TimerScheduler {
  schedule(delayMs: number, callback: () => void): TimerHandle;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

export const systemScheduler: TimerScheduler = {
  schedule(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return {
      clear: () => clearTimeout(handle),
    };
  },
};

const PHASE_MAX: Record<PhaseKind, number> = {
  producer: MAX_PRODUCER_DEADLINE_MS,
  review: MAX_REVIEW_DEADLINE_MS,
  remediation: MAX_REMEDIATION_DEADLINE_MS,
};

const PHASE_DEFAULT: Record<PhaseKind, number> = {
  producer: DEFAULT_PRODUCER_DEADLINE_MS,
  review: DEFAULT_REVIEW_DEADLINE_MS,
  remediation: DEFAULT_REMEDIATION_DEADLINE_MS,
};

export function validatePhaseDeadline(phase: PhaseKind, value: number): number {
  if (Number.isNaN(value)) {
    throw new DeadlineConfigurationError(phase, value, 'deadline must be a finite number');
  }
  if (!Number.isFinite(value)) {
    throw new DeadlineConfigurationError(phase, value, 'deadline must be a finite number');
  }
  if (value < 0) {
    throw new DeadlineConfigurationError(phase, value, 'deadline must not be negative');
  }
  const max = PHASE_MAX[phase];
  if (value > max) {
    throw new DeadlineConfigurationError(phase, value, `deadline exceeds maximum of ${max}ms`);
  }
  return value;
}

export function resolveDeadlinePolicy(config?: PartialDeadlineConfig): DeadlinePolicy {
  return {
    producerMs: validatePhaseDeadline('producer', config?.producerMs ?? PHASE_DEFAULT.producer),
    reviewMs: validatePhaseDeadline('review', config?.reviewMs ?? PHASE_DEFAULT.review),
    remediationMs: validatePhaseDeadline('remediation', config?.remediationMs ?? PHASE_DEFAULT.remediation),
  };
}

export function getPhaseDeadlineMs(policy: DeadlinePolicy, phase: PhaseKind): number {
  switch (phase) {
    case 'producer':
      return policy.producerMs;
    case 'review':
      return policy.reviewMs;
    case 'remediation':
      return policy.remediationMs;
  }
}

export function deadlineExpiresAt(startedAtMs: number, deadlineMs: number): number {
  return startedAtMs + deadlineMs;
}

export function hasDeadlineExpired(clock: Clock, startedAtMs: number, deadlineMs: number): boolean {
  return clock.nowMs() >= deadlineExpiresAt(startedAtMs, deadlineMs);
}

export type PhaseAbortCause = 'deadline' | 'external';

export class PhaseDeadlineError extends Error {
  readonly code = 'PHASE_DEADLINE_EXCEEDED';
  readonly phase: PhaseKind;
  readonly deadlineMs: number;

  constructor(phase: PhaseKind, deadlineMs: number) {
    super(`${phase} phase exceeded its ${deadlineMs}ms deadline.`);
    this.name = 'PhaseDeadlineError';
    this.phase = phase;
    this.deadlineMs = deadlineMs;
  }
}

export class PhaseCancelledError extends Error {
  readonly code = 'PHASE_CANCELLED';
  readonly phase: PhaseKind;

  constructor(phase: PhaseKind) {
    super(`${phase} phase was cancelled.`);
    this.name = 'PhaseCancelledError';
    this.phase = phase;
  }
}

export interface PhaseAbortSource {
  readonly signal: AbortSignal;
  readonly phase: PhaseKind;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  getCause(): PhaseAbortCause | undefined;
  getCauseAtMs(): number | undefined;
  dispose(): void;
}

export interface CreatePhaseAbortSourceInput {
  phase: PhaseKind;
  policy: DeadlinePolicy;
  externalSignal?: AbortSignal;
  clock?: Clock;
  scheduler?: TimerScheduler;
}

export function createPhaseAbortSource(input: CreatePhaseAbortSourceInput): PhaseAbortSource {
  const clock = input.clock ?? systemClock;
  const scheduler = input.scheduler ?? systemScheduler;
  const startedAtMs = clock.nowMs();
  const deadlineMs = getPhaseDeadlineMs(input.policy, input.phase);
  const controller = new AbortController();

  let cause: PhaseAbortCause | undefined;
  let causeAtMs: number | undefined;
  let deadlineTimer: TimerHandle | undefined;
  let externalListener: (() => void) | undefined;

  const recordCause = (next: PhaseAbortCause) => {
    if (cause !== undefined) return;
    cause = next;
    causeAtMs = clock.nowMs();
    controller.abort();
  };

  const onExternalAbort = () => recordCause('external');

  // Observe a pre-aborted external signal before deadline-0 so earliest effective external cause wins.
  if (input.externalSignal?.aborted) {
    onExternalAbort();
  } else if (deadlineMs === 0) {
    recordCause('deadline');
  } else {
    deadlineTimer = scheduler.schedule(deadlineMs, () => recordCause('deadline'));
  }

  if (input.externalSignal && !input.externalSignal.aborted) {
    externalListener = onExternalAbort;
    input.externalSignal.addEventListener('abort', onExternalAbort);
  }

  return {
    signal: controller.signal,
    phase: input.phase,
    startedAtMs,
    deadlineMs,
    getCause: () => cause,
    getCauseAtMs: () => causeAtMs,
    dispose() {
      deadlineTimer?.clear();
      if (input.externalSignal && externalListener) {
        input.externalSignal.removeEventListener('abort', externalListener);
      }
    },
  };
}
