import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';

import { AdapterRegistry } from './adapters/index.js';
import { AdapterTerminationError } from './adapters/protocol.js';
import {
  createPhaseAbortSource,
  deadlineConfigFromEnvironment,
  PhaseCancelledError,
  PhaseDeadlineError,
  resolveDeadlinePolicy,
  type DeadlinePolicy,
  type PartialDeadlineConfig,
  type PhaseKind,
} from './deadline-policy.js';
import { DEFAULT_MODEL_ID, MODEL_CATALOG, isConfigured, requireModel } from './catalog.js';
import { currentBranch, gitDiff, gitStatus, listBranches, switchBranch } from './git.js';
import { buildTurnPrompt, reviewPrompt, reviewerFor } from './orchestration.js';
import { assertReviewPass, blockedReview, createRuntimeEvidencePacket, parseRuntimeReview } from './review-policy.js';
import { defaultUserSlug, WorkspaceContextManager } from './context.js';
import { redactSecrets } from './redact.js';
import { makeMessage, SessionStore } from './session-store.js';
import { SkillRegistry } from './skills.js';
import { runtimeWorkspaceSnapshot, systemRuntime, type RuntimeSeams } from './runtime.js';
import { classifyWorkspaceChange, type WorkspaceChangeEvidence, type WorkspaceSnapshot } from './workspace.js';
import { emitBoundedEvent } from './streaming.js';
import type { AgentEvent, ModelProfile, OnboardingAnswers, PermissionMode, ProviderId, ReviewResult, RunRequest, RunResult, TurnOutcome, WorkspaceBootstrap, ZeuzSession } from './types.js';

type EventSink = (event: AgentEvent) => void;
type SessionRepository = Pick<SessionStore, 'initialize' | 'create' | 'save' | 'load' | 'list' | 'fork'>;
type ContextProvider = Pick<WorkspaceContextManager, 'load' | 'initialize' | 'updateHandoff'>;
type SkillProvider = Pick<SkillRegistry, 'contextFor' | 'list'>;

export interface ControllerDependencies {
  sessions: SessionRepository;
  registry: AdapterRegistry;
  contexts: ContextProvider;
  skills: SkillProvider;
  runtime: RuntimeSeams;
  deadlines: DeadlinePolicy;
}

export class WorkspaceMeasurementError extends Error {
  readonly code = 'WORKSPACE_UNMEASURABLE';

  constructor() {
    super('Workspace state is unmeasurable; fallback, replay, and delivery are blocked.');
    this.name = 'WorkspaceMeasurementError';
  }
}

function emit(sink: EventSink | undefined, event: AgentEvent): void {
  emitBoundedEvent(sink, event);
}

function fallbackSummary(session: ZeuzSession): string {
  const transcript = session.messages.slice(-10).map((message) => `${message.role.toUpperCase()}${message.modelId ? ` [${message.modelId}]` : ''}: ${message.content}`).join('\n\n');
  return transcript.length > 16_000 ? transcript.slice(-16_000) : transcript;
}

export class ZeuzController {
  readonly sessions: SessionRepository;
  readonly registry: AdapterRegistry;
  readonly contexts: ContextProvider;
  readonly skills: SkillProvider;
  session: ZeuzSession;
  bootstrap: WorkspaceBootstrap;
  private readonly runtime: RuntimeSeams;
  private readonly deadlines: DeadlinePolicy;

  private constructor(session: ZeuzSession, bootstrap: WorkspaceBootstrap, dependencies: ControllerDependencies) {
    this.session = session;
    this.bootstrap = bootstrap;
    this.sessions = dependencies.sessions;
    this.registry = dependencies.registry;
    this.contexts = dependencies.contexts;
    this.skills = dependencies.skills;
    this.runtime = dependencies.runtime;
    this.deadlines = dependencies.deadlines;
  }

  static async create(
    cwd: string,
    options: { sessionId?: string; modelId?: string; mode?: PermissionMode; deadlines?: PartialDeadlineConfig } = {},
    overrides: Partial<ControllerDependencies> = {},
  ): Promise<ZeuzController> {
    const runtime = overrides.runtime ?? systemRuntime;
    const store = overrides.sessions ?? new SessionStore({ runtime });
    const contexts = overrides.contexts ?? new WorkspaceContextManager();
    const dependencies: ControllerDependencies = {
      sessions: store,
      registry: overrides.registry ?? new AdapterRegistry(),
      contexts,
      skills: overrides.skills ?? new SkillRegistry(),
      runtime,
      deadlines: overrides.deadlines ?? resolveDeadlinePolicy(options.deadlines ?? deadlineConfigFromEnvironment()),
    };
    await store.initialize();
    const session = options.sessionId
      ? await store.load(options.sessionId)
      : await store.create(cwd, {
        modelId: options.modelId ?? DEFAULT_MODEL_ID,
        mode: options.mode ?? 'agent',
      });
    session.userSlug ??= defaultUserSlug();
    const bootstrap = await contexts.load(session.cwd, session.userSlug, { initializeHandoff: session.permissionMode !== 'plan' });
    await store.save(session);
    return new ZeuzController(session, bootstrap, dependencies);
  }

  activeModel(): ModelProfile {
    return requireModel(this.session.activeModelId);
  }

  async send(userText: string, onEvent?: EventSink, signal?: AbortSignal): Promise<TurnOutcome> {
    await this.refreshBootstrap(this.session.permissionMode);
    const primary = this.activeModel();
    const before = this.workspaceSnapshot();
    const resumeId = this.session.providerSessions[primary.id];
    const includeHandoff = !resumeId || this.session.lastUsedModelId !== primary.id;
    const skillContext = await this.skills.contextFor(userText);
    const prompt = buildTurnPrompt({ session: this.session, model: primary, userText, includeHandoff, bootstrapContext: this.bootstrap.context, ...(skillContext ? { skillContext } : {}) });
    await this.recordHandoff(userText, primary.id, this.session.permissionMode, 'in_progress', onEvent);

    this.session.messages.push(this.message('user', userText));
    await this.sessions.save(this.session);
    emit(onEvent, { type: 'status', text: `${primary.label} is working` });

    let producer = primary;
    let result: RunResult;
    try {
      result = await this.runPhase('producer', primary.provider, {
        model: primary,
        prompt,
        cwd: this.session.cwd,
        mode: this.session.permissionMode,
        ...(resumeId ? { resumeId } : {}),
        ...(onEvent ? { onEvent } : {}),
      }, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const evidence = this.workspaceChange(before);
      if (primary.family !== 'GPT-5.6 Sol' || evidence.state !== 'unchanged' || error instanceof PhaseDeadlineError || error instanceof PhaseCancelledError || !/(?:not found|unavailable|rate.?limit|quota|\b429\b|authentication|unauthorized|model.+(?:missing|not))/i.test(message)) throw error;
      producer = await this.fableFallback();
      emit(onEvent, { type: 'warning', text: `${primary.label} is unavailable (${message}). Falling back explicitly to ${producer.label}.` });
      let fallbackPrompt = buildTurnPrompt({ session: this.session, model: producer, userText, includeHandoff: true, bootstrapContext: this.bootstrap.context, ...(skillContext ? { skillContext } : {}) });
      try {
        result = await this.runPhase('producer', producer.provider, { model: producer, prompt: fallbackPrompt, cwd: this.session.cwd, mode: this.session.permissionMode, ...(onEvent ? { onEvent } : {}) }, signal);
      } catch (fallbackError) {
        const fallbackEvidence = this.workspaceChange(before);
        if (producer.provider !== 'claude' || fallbackEvidence.state !== 'unchanged' || fallbackError instanceof PhaseDeadlineError || fallbackError instanceof PhaseCancelledError) throw fallbackError;
        const directFailure = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        producer = requireModel('cursor:claude-fable-5-thinking-high');
        emit(onEvent, { type: 'warning', text: `Direct Claude Fable failed (${directFailure}). Falling back explicitly to ${producer.label}.` });
        fallbackPrompt = buildTurnPrompt({ session: this.session, model: producer, userText, includeHandoff: true, bootstrapContext: this.bootstrap.context, ...(skillContext ? { skillContext } : {}) });
        result = await this.runPhase('producer', producer.provider, { model: producer, prompt: fallbackPrompt, cwd: this.session.cwd, mode: this.session.permissionMode, ...(onEvent ? { onEvent } : {}) }, signal);
      }
    }

    this.recordRun(producer, result);
    this.session.messages.push(this.message('assistant', result.text, producer.id));
    await this.sessions.save(this.session);

    const change = this.workspaceChange(before);
    if (change.state === 'unmeasurable' && this.session.permissionMode !== 'plan') {
      await this.recordHandoff(userText, producer.id, this.session.permissionMode, 'blocked', onEvent);
      throw new WorkspaceMeasurementError();
    }
    const changedWorkspace = change.state === 'changed';
    let response = result.text;
    let review: ReviewResult | undefined;

    if (changedWorkspace && this.session.permissionMode !== 'plan') {
      emit(onEvent, { type: 'status', text: 'Workspace changed — starting mandatory adversarial review' });
      review = await this.runReview(producer, onEvent);

      if (review.verdict === 'CHANGES_REQUIRED') {
        emit(onEvent, { type: 'warning', text: `Adversarial review requested changes (${review.findings.length} finding${review.findings.length === 1 ? '' : 's'})` });
        let remediation: RunResult;
        try {
          remediation = await this.remediate(producer, review, onEvent);
        } catch (error) {
          await this.recordHandoff(userText, producer.id, this.session.permissionMode, 'blocked', onEvent, true, review);
          throw error;
        }
        response = `${response}\n\n---\n\nAdversarial remediation:\n\n${remediation.text}`;
        emit(onEvent, { type: 'status', text: 'Re-running adversarial verification' });
        review = await this.runReview(producer, onEvent);
      }
    }

    let reviewGateError: unknown;
    if (changedWorkspace && this.session.permissionMode !== 'plan' && review) {
      try { assertReviewPass(review, this.measurableFingerprint()); } catch (error) { reviewGateError = error; }
    }
    await this.recordHandoff(userText, producer.id, this.session.permissionMode, reviewGateError || (review && review.verdict !== 'PASS') ? 'blocked' : 'completed', onEvent, changedWorkspace, review);
    if (reviewGateError) throw reviewGateError;
    return { response, modelId: producer.id, changedWorkspace, ...(review ? { review } : {}) };
  }

  async ask(modelQuery: string, task: string, onEvent?: EventSink, mode = this.session.permissionMode, signal?: AbortSignal): Promise<TurnOutcome> {
    await this.refreshBootstrap(mode);
    const model = requireModel(modelQuery);
    const before = this.workspaceSnapshot();
    const skillContext = await this.skills.contextFor(task);
    const prompt = buildTurnPrompt({ session: this.session, model, userText: task, includeHandoff: true, mode, bootstrapContext: this.bootstrap.context, ...(skillContext ? { skillContext } : {}) });
    await this.recordHandoff(task, model.id, mode, 'in_progress', onEvent);
    emit(onEvent, { type: 'status', text: `Delegating to ${model.label}` });
    const result = await this.runPhase('producer', model.provider, {
      model,
      prompt,
      cwd: this.session.cwd,
      mode,
      ...(onEvent ? { onEvent } : {}),
    }, signal);
    this.session.messages.push(this.message('system', `Delegated to ${model.id}: ${task}`));
    this.session.messages.push(this.message('assistant', result.text, model.id));
    await this.sessions.save(this.session);

    const change = this.workspaceChange(before);
    if (change.state === 'unmeasurable' && mode !== 'plan') {
      await this.recordHandoff(task, model.id, mode, 'blocked', onEvent);
      throw new WorkspaceMeasurementError();
    }
    const changedWorkspace = change.state === 'changed';
    let response = result.text;
    let review: ReviewResult | undefined;
    if (changedWorkspace && mode !== 'plan') {
      review = await this.runReview(model, onEvent);
      if (review.verdict === 'CHANGES_REQUIRED') {
        const remediationPrompt = `Address the following adversarial findings in the workspace. Validate every change and explain any finding you reject with concrete evidence.\n\n${review.raw}`;
        let remediation: RunResult;
        try {
          remediation = await this.runPhase('remediation', model.provider, {
            model,
            prompt: buildTurnPrompt({ session: this.session, model, userText: remediationPrompt, includeHandoff: false, mode, bootstrapContext: this.bootstrap.context }),
            cwd: this.session.cwd,
            mode,
            ...(result.nativeSessionId ? { resumeId: result.nativeSessionId } : {}),
            ...(onEvent ? { onEvent } : {}),
          }, signal);
        } catch (error) {
          await this.recordHandoff(task, model.id, mode, 'blocked', onEvent, true, review);
          throw error;
        }
        response = `${response}\n\n---\n\nAdversarial remediation:\n\n${remediation.text}`;
        review = await this.runReview(model, onEvent);
      }
    }
    let reviewGateError: unknown;
    if (changedWorkspace && mode !== 'plan' && review) {
      try { assertReviewPass(review, this.measurableFingerprint()); } catch (error) { reviewGateError = error; }
    }
    await this.recordHandoff(task, model.id, mode, reviewGateError || (review && review.verdict !== 'PASS') ? 'blocked' : 'completed', onEvent, changedWorkspace, review);
    if (reviewGateError) throw reviewGateError;
    return { response, modelId: model.id, changedWorkspace, ...(review ? { review } : {}) };
  }

  async compact(onEvent?: EventSink): Promise<string> {
    if (this.session.messages.length === 0) {
      this.session.summary = 'No conversation content yet.';
      this.session.summaryUpdatedAt = this.runtime.now();
      await this.sessions.save(this.session);
      return this.session.summary;
    }

    emit(onEvent, { type: 'status', text: 'Compacting shared context with GPT-5.6 Sol · low' });
    const summarizer = requireModel('codex:gpt-5.6-sol@low');
    const transcript = this.session.messages.map((message) => `${message.role.toUpperCase()}${message.modelId ? ` [${message.modelId}]` : ''}:\n${message.content}`).join('\n\n');
    const bounded = transcript.length > 90_000 ? transcript.slice(-90_000) : transcript;
    const prompt = `Compact this multi-model coding session into a durable handoff in Brazilian Portuguese. Preserve: user goal, hard requirements, decisions, workspace state, files changed, commands/tests and their outcomes, unresolved risks, next actions, and model-specific claims that still need verification. Remove repetition and conversational filler. Never include secrets. Stay under 1,800 words.\n\n${bounded}`;

    try {
      const result = await this.run('codex', {
        model: summarizer,
        prompt,
        cwd: this.session.cwd,
        mode: 'plan',
        ephemeral: true,
        ...(onEvent ? { onEvent } : {}),
      });
      this.session.summary = result.text;
    } catch (error) {
      this.session.summary = fallbackSummary(this.session);
      emit(onEvent, { type: 'warning', text: `Model compaction failed; deterministic fallback used: ${error instanceof Error ? error.message : String(error)}` });
    }
    this.session.summaryUpdatedAt = this.runtime.now();
    await this.sessions.save(this.session);
    return this.session.summary;
  }

  async switchModel(query: string, onEvent?: EventSink): Promise<string> {
    const model = requireModel(query);
    if (model.id === this.session.activeModelId) return `${model.label} is already active.`;
    if (this.session.messages.length > 0) await this.compact(onEvent);
    this.session.activeModelId = model.id;
    await this.sessions.save(this.session);
    return `Active model: ${model.label} (${model.id}). Shared context compacted for handoff.`;
  }

  async setPermission(mode: PermissionMode): Promise<string> {
    this.session.permissionMode = mode;
    await this.sessions.save(this.session);
    return mode === 'yolo'
      ? 'Permission mode: yolo. Sandboxes and approval gates are bypassed where providers support it; secret redaction remains enforced.'
      : `Permission mode: ${mode}.`;
  }

  async changeDirectory(input: string, onEvent?: EventSink): Promise<string> {
    if (!input.trim()) return this.session.cwd;
    if (this.session.messages.length > 0) await this.compact(onEvent);
    const expanded = input.startsWith('~/') ? resolve(homedir(), input.slice(2)) : input === '~' ? homedir() : input;
    const candidate = await realpath(isAbsolute(expanded) ? expanded : resolve(this.session.cwd, expanded));
    if (!(await stat(candidate)).isDirectory()) throw new Error(`Not a directory: ${candidate}`);
    this.session.cwd = candidate;
    this.session.providerSessions = {};
    this.session.userSlug = defaultUserSlug();
    delete this.session.lastUsedModelId;
    await this.sessions.save(this.session);
    await this.refreshBootstrap();
    return `Workspace: ${candidate}. Provider sessions were reset; shared compacted context was preserved.`;
  }

  async fork(title?: string, onEvent?: EventSink): Promise<ZeuzSession> {
    if (this.session.messages.length > 0) await this.compact(onEvent);
    this.session = await this.sessions.fork(this.session, title);
    await this.refreshBootstrap();
    return this.session;
  }

  async newSession(): Promise<ZeuzSession> {
    this.session = await this.sessions.create(this.session.cwd, { modelId: this.session.activeModelId, mode: this.session.permissionMode, ...(this.session.userSlug ? { userSlug: this.session.userSlug } : {}) });
    await this.refreshBootstrap();
    return this.session;
  }

  async resume(idOrPrefix: string): Promise<ZeuzSession> {
    this.session = await this.sessions.load(idOrPrefix);
    this.session.userSlug ??= defaultUserSlug();
    await this.refreshBootstrap();
    return this.session;
  }

  async listSessions(): Promise<ZeuzSession[]> {
    return await this.sessions.list();
  }

  onboardingRequired(): boolean {
    return this.bootstrap.onboardingRequired;
  }

  async completeOnboarding(answers: OnboardingAnswers): Promise<string> {
    const slug = this.session.userSlug ?? defaultUserSlug();
    this.bootstrap = await this.contexts.initialize(this.session.cwd, slug, answers);
    await this.sessions.save(this.session);
    return `Onboarding complete for ${slug}. Created a private local profile and visible vault indexes in ${this.session.cwd}.`;
  }

  async selectUser(user?: string): Promise<string> {
    if (!user?.trim()) return this.session.userSlug ?? defaultUserSlug();
    this.session.userSlug = user.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || defaultUserSlug();
    await this.sessions.save(this.session);
    await this.refreshBootstrap();
    return `Active user: ${this.session.userSlug}${this.bootstrap.onboardingRequired ? ' (onboarding required)' : ''}.`;
  }

  bootstrapStatus(): string {
    return [
      `User: ${this.bootstrap.userSlug}`,
      `Onboarding: ${this.bootstrap.onboardingRequired ? 'required' : 'complete'}`,
      `Loaded: ${this.bootstrap.files.join(', ') || 'none'}`,
      ...this.bootstrap.warnings.map((warning) => `Warning: ${warning}`),
    ].join('\n');
  }

  async skillStatus(): Promise<string> {
    const skills = await this.skills.list();
    return skills.length === 0 ? 'No repository skills were found.' : skills.map((skill) => `${skill.name.padEnd(10)} ${skill.path}`).join('\n');
  }

  async explicitReview(onEvent?: EventSink): Promise<ReviewResult> {
    return await this.runReview(this.activeModel(), onEvent);
  }

  async health(deep = false, onEvent?: EventSink): Promise<string> {
    const providerHealth = await Promise.all(this.registry.all().map(async (adapter) => await adapter.health()));
    const lines = providerHealth.map((result) => {
      const description = [result.version, result.detail].filter(Boolean).join(' — ');
      return `${result.ok ? 'PASS' : 'FAIL'}  ${result.provider.padEnd(8)} ${description}`;
    });

    if (deep) {
      const nvidiaModels = MODEL_CATALOG.filter((model) => model.provider === 'nvidia');
      const checks = await Promise.all(nvidiaModels.map(async (model) => {
        if (!isConfigured(model)) return `${'SKIP'.padEnd(5)} ${model.id} — missing ${model.apiKeyEnv}`;
        const started = this.runtime.nowMs();
        try {
          await this.run('nvidia', {
            model,
            prompt: 'Reply with exactly: ok',
            cwd: this.session.cwd,
            mode: 'plan',
            signal: AbortSignal.timeout(45_000),
            ...(onEvent ? { onEvent } : {}),
          });
          return `${'PASS'.padEnd(5)} ${model.id} — ${this.runtime.nowMs() - started}ms`;
        } catch (error) {
          return `${'FAIL'.padEnd(5)} ${model.id} — ${error instanceof Error ? error.message : String(error)}`;
        }
      }));
      lines.push('', 'NVIDIA deep checks:', ...checks);
    }
    return lines.join('\n');
  }

  status(): string {
    const model = this.activeModel();
    return [
      `Session: ${this.session.title} (${this.session.id})`,
      `Workspace: ${this.session.cwd}`,
      `Model: ${model.label} (${model.id})`,
      `Permissions: ${this.session.permissionMode}`,
      `User: ${this.bootstrap.userSlug}`,
      `Bootstrap: ${this.bootstrap.onboardingRequired ? 'onboarding required' : `${this.bootstrap.files.length} files loaded`}`,
      `Messages: ${this.session.messages.length}`,
      `Summary: ${this.session.summaryUpdatedAt ? `updated ${this.session.summaryUpdatedAt}` : 'not created'}`,
      `Branch: ${currentBranch(this.session.cwd) ?? 'n/a'}`,
      '',
      gitStatus(this.session.cwd),
    ].join('\n');
  }

  diff(): string {
    return gitDiff(this.session.cwd);
  }

  branches(): string {
    return listBranches(this.session.cwd);
  }

  async branch(name: string): Promise<string> {
    const result = switchBranch(this.session.cwd, name);
    this.session.messages.push(this.message('system', result));
    await this.sessions.save(this.session);
    return result;
  }

  private recordRun(model: ModelProfile, result: RunResult): void {
    if (result.nativeSessionId) this.session.providerSessions[model.id] = result.nativeSessionId;
    this.session.lastUsedModelId = model.id;
  }

  private async runReview(primary: ModelProfile, onEvent?: EventSink): Promise<ReviewResult> {
    const reviewer = requireModel(reviewerFor(primary));
    let packet: ReturnType<typeof createRuntimeEvidencePacket> | undefined;
    emit(onEvent, { type: 'status', text: `Adversarial reviewer: ${reviewer.label}` });
    try {
      const originalRequest = [...this.session.messages].reverse().find((message) => message.role === 'user' || message.role === 'system');
      const producerDelivery = [...this.session.messages].reverse().find((message) => message.role === 'assistant');
      const snapshot = this.workspaceSnapshot();
      const fingerprint = snapshot.measurable ? snapshot.fingerprint : undefined;
      if (!fingerprint) {
        const review = blockedReview({ reviewer, raw: '', reason: 'Workspace fingerprint is unavailable; review freshness cannot be established.' });
        this.session.messages.push(this.message('reviewer', JSON.stringify(review), reviewer.id));
        await this.sessions.save(this.session);
        return review;
      }
      let status = 'Git status unavailable to the runtime review driver.';
      let diff = 'Git diff unavailable to the runtime review driver.';
      try {
        status = gitStatus(this.session.cwd);
        diff = gitDiff(this.session.cwd);
      } catch {
        // Fingerprint availability remains the review freshness authority in this Wave 02 seam.
      }
      const artifacts = status.startsWith('Git status unavailable') || status === 'Not a Git repository.'
        ? []
        : status.split('\n').filter((line) => !line.startsWith('##') && /^[ MADRCU?!]{2} /.test(line)).map((line) => line.slice(3).trim()).filter(Boolean);
      packet = createRuntimeEvidencePacket({
        producer: primary,
        reviewer,
        cwd: this.session.cwd,
        workspaceFingerprint: fingerprint,
        status,
        diff,
        artifacts,
        request: originalRequest?.content ?? 'Unavailable',
        delivery: producerDelivery?.content ?? 'Unavailable',
        verification: 'The independent reviewer must re-run proportional deterministic checks; producer claims are not accepted as proof.',
        bootstrapContract: this.bootstrap.context,
      });
      const result = await this.runPhase('review', reviewer.provider, {
        model: reviewer,
        prompt: `${reviewPrompt(primary, this.session.cwd)}\n\n${await this.skills.contextFor('$medusa adversarial review') ?? ''}\n\nMEDUSA_RUNTIME_PACKET_JSON\n${JSON.stringify(packet)}\nEND_MEDUSA_RUNTIME_PACKET_JSON`,
        cwd: this.session.cwd,
        mode: 'plan',
        ephemeral: true,
        ...(onEvent ? { onEvent } : {}),
      });
      let review = parseRuntimeReview(result.text, packet, reviewer);
      const currentSnapshot = this.workspaceSnapshot();
      const currentFingerprint = currentSnapshot.measurable ? currentSnapshot.fingerprint : undefined;
      if (!currentFingerprint || currentFingerprint !== packet.workspace.fingerprint) {
        review = blockedReview({ packet, reviewer, raw: result.text, reason: 'Workspace changed during review; the packet is stale.' });
      }
      this.session.messages.push(this.message('reviewer', review.raw, reviewer.id));
      await this.sessions.save(this.session);
      return review;
    } catch (error) {
      const raw = `Reviewer execution failed: ${error instanceof Error ? error.message : String(error)}`;
      const review = blockedReview({ ...(packet ? { packet } : {}), reviewer, raw, reason: raw });
      this.session.messages.push(this.message('reviewer', raw, reviewer.id));
      await this.sessions.save(this.session);
      return review;
    }
  }

  private async remediate(primary: ModelProfile, review: ReviewResult, onEvent?: EventSink): Promise<RunResult> {
    const resumeId = this.session.providerSessions[primary.id];
    const remediationTask = `Mandatory adversarial review returned CHANGES_REQUIRED. Address every valid finding in the workspace, run proportional verification, and explicitly rebut any invalid finding with file/line/test evidence. Do not ignore low-severity findings without explanation.\n\n${review.raw}`;
    const prompt = buildTurnPrompt({ session: this.session, model: primary, userText: remediationTask, includeHandoff: false, bootstrapContext: this.bootstrap.context });
    const result = await this.runPhase('remediation', primary.provider, {
      model: primary,
      prompt,
      cwd: this.session.cwd,
      mode: this.session.permissionMode,
      ...(resumeId ? { resumeId } : {}),
      ...(onEvent ? { onEvent } : {}),
    });
    this.recordRun(primary, result);
    this.session.messages.push(this.message('assistant', result.text, primary.id));
    await this.sessions.save(this.session);
    return result;
  }

  private async recordHandoff(
    latestDemand: string,
    modelId: string,
    mode: PermissionMode,
    status: 'in_progress' | 'completed' | 'blocked',
    onEvent?: EventSink,
    changedWorkspace?: boolean,
    review?: ReviewResult,
  ): Promise<void> {
    if (mode === 'plan') return;
    try {
      const warning = await this.contexts.updateHandoff(this.session.cwd, {
        latestDemand,
        modelId,
        status,
        ...(changedWorkspace === undefined ? {} : { changedWorkspace }),
        ...(review ? { reviewVerdict: review.verdict } : {}),
      });
      if (warning) emit(onEvent, { type: 'warning', text: warning });
      this.bootstrap = await this.contexts.load(this.session.cwd, this.session.userSlug ?? defaultUserSlug());
    } catch (error) {
      emit(onEvent, { type: 'warning', text: `handoff.md update failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async refreshBootstrap(mode = this.session.permissionMode): Promise<void> {
    this.bootstrap = await this.contexts.load(this.session.cwd, this.session.userSlug ?? defaultUserSlug(), { initializeHandoff: mode !== 'plan' });
  }

  private async fableFallback(): Promise<ModelProfile> {
    const claude = await this.registry.get('claude').health();
    return requireModel(claude.ok ? 'claude:fable' : 'cursor:claude-fable-5-thinking-high');
  }

  private workspaceSnapshot(): WorkspaceSnapshot {
    return runtimeWorkspaceSnapshot(this.runtime, this.session.cwd);
  }

  private workspaceChange(before: WorkspaceSnapshot): WorkspaceChangeEvidence {
    return classifyWorkspaceChange(before, this.workspaceSnapshot());
  }

  private measurableFingerprint(): string | undefined {
    const snapshot = this.workspaceSnapshot();
    return snapshot.measurable ? snapshot.fingerprint : undefined;
  }

  private async runPhase(
    phase: PhaseKind,
    provider: ProviderId,
    request: RunRequest,
    externalSignal?: AbortSignal,
  ): Promise<RunResult> {
    const abort = createPhaseAbortSource({
      phase,
      policy: this.deadlines,
      ...(externalSignal ? { externalSignal } : {}),
    });
    try {
      const result = await this.run(provider, { ...request, signal: abort.signal });
      const cause = abort.getCause();
      if (cause === 'deadline') throw new PhaseDeadlineError(phase, abort.deadlineMs);
      if (cause === 'external') throw new PhaseCancelledError(phase);
      return result;
    } catch (error) {
      if (error instanceof AdapterTerminationError) {
        const nativeSessionId = error.partialResult.nativeSessionId;
        if (nativeSessionId) this.session.providerSessions[request.model.id] = nativeSessionId;
        this.session.lastUsedModelId = request.model.id;
        this.session.messages.push(this.message(
          'system',
          `Turn terminated: cause=${error.termination.cause}; stage=${error.termination.stage}; phase=${phase}.`,
          request.model.id,
        ));
        await this.sessions.save(this.session);
      }
      const cause = abort.getCause();
      if (cause) {
        emit(request.onEvent, {
          type: 'cancelled',
          cause,
          phase,
          text: cause === 'deadline' ? `${phase} deadline reached.` : `${phase} cancelled.`,
        });
        if (cause === 'deadline') throw new PhaseDeadlineError(phase, abort.deadlineMs);
        throw new PhaseCancelledError(phase);
      }
      throw error;
    } finally {
      abort.dispose();
    }
  }

  private async run(provider: ProviderId, request: RunRequest): Promise<RunResult> {
    const protectedRequest: RunRequest = request.onEvent
      ? { ...request, onEvent: (event) => emitBoundedEvent(request.onEvent, { ...event, text: redactSecrets(event.text) }) }
      : request;
    try {
      const result = await this.registry.get(provider).run(protectedRequest);
      return { ...result, text: redactSecrets(result.text) };
    } catch (error) {
      if (error instanceof AdapterTerminationError) throw error;
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
    }
  }

  private message(role: Parameters<typeof makeMessage>[0], content: string, modelId?: string): ReturnType<typeof makeMessage> {
    return makeMessage(role, content, modelId, this.runtime);
  }
}
