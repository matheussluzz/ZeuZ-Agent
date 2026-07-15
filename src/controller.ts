import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';

import { AdapterRegistry } from './adapters/index.js';
import { DEFAULT_MODEL_ID, MODEL_CATALOG, isConfigured, requireModel } from './catalog.js';
import { currentBranch, gitDiff, gitStatus, listBranches, switchBranch, workspaceFingerprint } from './git.js';
import { buildTurnPrompt, reviewPrompt, reviewerFor } from './orchestration.js';
import { defaultUserSlug, WorkspaceContextManager } from './context.js';
import { redactSecrets } from './redact.js';
import { makeMessage, SessionStore } from './session-store.js';
import { SkillRegistry } from './skills.js';
import type { AgentEvent, ModelProfile, OnboardingAnswers, PermissionMode, ProviderId, ReviewFinding, ReviewResult, RunRequest, RunResult, TurnOutcome, WorkspaceBootstrap, ZeuzSession } from './types.js';

type EventSink = (event: AgentEvent) => void;

function emit(sink: EventSink | undefined, event: AgentEvent): void {
  sink?.(event);
}

function fallbackSummary(session: ZeuzSession): string {
  const transcript = session.messages.slice(-10).map((message) => `${message.role.toUpperCase()}${message.modelId ? ` [${message.modelId}]` : ''}: ${message.content}`).join('\n\n');
  return transcript.length > 16_000 ? transcript.slice(-16_000) : transcript;
}

function parseReview(raw: string, reviewerModelId: string): ReviewResult {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('No JSON object found');
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const verdict = parsed.verdict === 'PASS' ? 'PASS' : parsed.verdict === 'REVIEW_BLOCKED' ? 'REVIEW_BLOCKED' : 'CHANGES_REQUIRED';
    const findings: ReviewFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const finding = value as Record<string, unknown>;
        const severity = ['critical', 'high', 'medium', 'low'].includes(String(finding.severity))
          ? String(finding.severity) as ReviewFinding['severity']
          : 'medium';
        return [{
          severity,
          title: String(finding.title ?? 'Untitled finding'),
          detail: String(finding.detail ?? ''),
          ...(typeof finding.file === 'string' ? { file: finding.file } : {}),
          ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
        }];
      })
      : [];
    return {
      verdict,
      summary: String(parsed.summary ?? 'Adversarial review completed.'),
      findings,
      raw,
      reviewerModelId,
    };
  } catch (error) {
    return {
      verdict: 'CHANGES_REQUIRED',
      summary: 'The reviewer did not return valid structured evidence; completion cannot be certified.',
      findings: [{
        severity: 'high',
        title: 'Unparseable adversarial review',
        detail: error instanceof Error ? error.message : String(error),
      }],
      raw,
      reviewerModelId,
    };
  }
}

export class ZeuzController {
  readonly sessions = new SessionStore();
  readonly registry = new AdapterRegistry();
  readonly contexts = new WorkspaceContextManager();
  readonly skills = new SkillRegistry();
  session: ZeuzSession;
  bootstrap: WorkspaceBootstrap;

  private constructor(session: ZeuzSession, bootstrap: WorkspaceBootstrap) {
    this.session = session;
    this.bootstrap = bootstrap;
  }

  static async create(cwd: string, options: { sessionId?: string; modelId?: string; mode?: PermissionMode } = {}): Promise<ZeuzController> {
    const store = new SessionStore();
    await store.initialize();
    const session = options.sessionId
      ? await store.load(options.sessionId)
      : await store.create(cwd, {
        modelId: options.modelId ?? DEFAULT_MODEL_ID,
        mode: options.mode ?? 'agent',
      });
    session.userSlug ??= defaultUserSlug();
    const bootstrap = await new WorkspaceContextManager().load(session.cwd, session.userSlug, { initializeHandoff: session.permissionMode !== 'plan' });
    await store.save(session);
    return new ZeuzController(session, bootstrap);
  }

  activeModel(): ModelProfile {
    return requireModel(this.session.activeModelId);
  }

  async send(userText: string, onEvent?: EventSink): Promise<TurnOutcome> {
    await this.refreshBootstrap(this.session.permissionMode);
    const primary = this.activeModel();
    const before = workspaceFingerprint(this.session.cwd);
    const resumeId = this.session.providerSessions[primary.id];
    const includeHandoff = !resumeId || this.session.lastUsedModelId !== primary.id;
    const skillContext = await this.skills.contextFor(userText);
    const prompt = buildTurnPrompt({ session: this.session, model: primary, userText, includeHandoff, bootstrapContext: this.bootstrap.context, ...(skillContext ? { skillContext } : {}) });
    await this.recordHandoff(userText, primary.id, this.session.permissionMode, 'in_progress', onEvent);

    this.session.messages.push(makeMessage('user', userText));
    await this.sessions.save(this.session);
    emit(onEvent, { type: 'status', text: `${primary.label} is working` });

    let producer = primary;
    let result: RunResult;
    try {
      result = await this.run(primary.provider, {
        model: primary,
        prompt,
        cwd: this.session.cwd,
        mode: this.session.permissionMode,
        ...(resumeId ? { resumeId } : {}),
        ...(onEvent ? { onEvent } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unchanged = before === workspaceFingerprint(this.session.cwd);
      if (primary.family !== 'GPT-5.6 Sol' || !unchanged || !/(?:not found|unavailable|rate.?limit|quota|\b429\b|authentication|unauthorized|model.+(?:missing|not))/i.test(message)) throw error;
      producer = await this.fableFallback();
      emit(onEvent, { type: 'warning', text: `${primary.label} is unavailable (${message}). Falling back explicitly to ${producer.label}.` });
      let fallbackPrompt = buildTurnPrompt({ session: this.session, model: producer, userText, includeHandoff: true, bootstrapContext: this.bootstrap.context, ...(skillContext ? { skillContext } : {}) });
      try {
        result = await this.run(producer.provider, { model: producer, prompt: fallbackPrompt, cwd: this.session.cwd, mode: this.session.permissionMode, ...(onEvent ? { onEvent } : {}) });
      } catch (fallbackError) {
        const fallbackUnchanged = before === workspaceFingerprint(this.session.cwd);
        if (producer.provider !== 'claude' || !fallbackUnchanged) throw fallbackError;
        const directFailure = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        producer = requireModel('cursor:claude-fable-5-thinking-high');
        emit(onEvent, { type: 'warning', text: `Direct Claude Fable failed (${directFailure}). Falling back explicitly to ${producer.label}.` });
        fallbackPrompt = buildTurnPrompt({ session: this.session, model: producer, userText, includeHandoff: true, bootstrapContext: this.bootstrap.context, ...(skillContext ? { skillContext } : {}) });
        result = await this.run(producer.provider, { model: producer, prompt: fallbackPrompt, cwd: this.session.cwd, mode: this.session.permissionMode, ...(onEvent ? { onEvent } : {}) });
      }
    }

    this.recordRun(producer, result);
    this.session.messages.push(makeMessage('assistant', result.text, producer.id));
    await this.sessions.save(this.session);

    const after = workspaceFingerprint(this.session.cwd);
    const changedWorkspace = before === undefined ? this.session.permissionMode !== 'plan' : before !== after;
    let response = result.text;
    let review: ReviewResult | undefined;

    if (changedWorkspace && this.session.permissionMode !== 'plan') {
      emit(onEvent, { type: 'status', text: 'Workspace changed — starting mandatory adversarial review' });
      review = await this.runReview(producer, onEvent);

      if (review.verdict === 'CHANGES_REQUIRED') {
        emit(onEvent, { type: 'warning', text: `Adversarial review requested changes (${review.findings.length} finding${review.findings.length === 1 ? '' : 's'})` });
        const remediation = await this.remediate(producer, review, onEvent);
        response = `${response}\n\n---\n\nAdversarial remediation:\n\n${remediation.text}`;
        emit(onEvent, { type: 'status', text: 'Re-running adversarial verification' });
        review = await this.runReview(producer, onEvent);
      }
    }

    await this.recordHandoff(userText, producer.id, this.session.permissionMode, review && review.verdict !== 'PASS' ? 'blocked' : 'completed', onEvent, changedWorkspace, review);
    return { response, modelId: producer.id, changedWorkspace, ...(review ? { review } : {}) };
  }

  async ask(modelQuery: string, task: string, onEvent?: EventSink, mode = this.session.permissionMode): Promise<TurnOutcome> {
    await this.refreshBootstrap(mode);
    const model = requireModel(modelQuery);
    const before = workspaceFingerprint(this.session.cwd);
    const skillContext = await this.skills.contextFor(task);
    const prompt = buildTurnPrompt({ session: this.session, model, userText: task, includeHandoff: true, mode, bootstrapContext: this.bootstrap.context, ...(skillContext ? { skillContext } : {}) });
    await this.recordHandoff(task, model.id, mode, 'in_progress', onEvent);
    emit(onEvent, { type: 'status', text: `Delegating to ${model.label}` });
    const result = await this.run(model.provider, {
      model,
      prompt,
      cwd: this.session.cwd,
      mode,
      ...(onEvent ? { onEvent } : {}),
    });
    this.session.messages.push(makeMessage('system', `Delegated to ${model.id}: ${task}`));
    this.session.messages.push(makeMessage('assistant', result.text, model.id));
    await this.sessions.save(this.session);

    const after = workspaceFingerprint(this.session.cwd);
    const changedWorkspace = before === undefined ? mode !== 'plan' : before !== after;
    let response = result.text;
    let review: ReviewResult | undefined;
    if (changedWorkspace && mode !== 'plan') {
      review = await this.runReview(model, onEvent);
      if (review.verdict === 'CHANGES_REQUIRED') {
        const remediationPrompt = `Address the following adversarial findings in the workspace. Validate every change and explain any finding you reject with concrete evidence.\n\n${review.raw}`;
        const remediation = await this.run(model.provider, {
          model,
          prompt: buildTurnPrompt({ session: this.session, model, userText: remediationPrompt, includeHandoff: false, mode, bootstrapContext: this.bootstrap.context }),
          cwd: this.session.cwd,
          mode,
          ...(result.nativeSessionId ? { resumeId: result.nativeSessionId } : {}),
          ...(onEvent ? { onEvent } : {}),
        });
        response = `${response}\n\n---\n\nAdversarial remediation:\n\n${remediation.text}`;
        review = await this.runReview(model, onEvent);
      }
    }
    await this.recordHandoff(task, model.id, mode, review && review.verdict !== 'PASS' ? 'blocked' : 'completed', onEvent, changedWorkspace, review);
    return { response, modelId: model.id, changedWorkspace, ...(review ? { review } : {}) };
  }

  async compact(onEvent?: EventSink): Promise<string> {
    if (this.session.messages.length === 0) {
      this.session.summary = 'No conversation content yet.';
      this.session.summaryUpdatedAt = new Date().toISOString();
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
    this.session.summaryUpdatedAt = new Date().toISOString();
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
        const started = Date.now();
        try {
          await this.run('nvidia', {
            model,
            prompt: 'Reply with exactly: ok',
            cwd: this.session.cwd,
            mode: 'plan',
            signal: AbortSignal.timeout(45_000),
            ...(onEvent ? { onEvent } : {}),
          });
          return `${'PASS'.padEnd(5)} ${model.id} — ${Date.now() - started}ms`;
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
    this.session.messages.push(makeMessage('system', result));
    await this.sessions.save(this.session);
    return result;
  }

  private recordRun(model: ModelProfile, result: RunResult): void {
    if (result.nativeSessionId) this.session.providerSessions[model.id] = result.nativeSessionId;
    this.session.lastUsedModelId = model.id;
  }

  private async runReview(primary: ModelProfile, onEvent?: EventSink): Promise<ReviewResult> {
    const reviewer = requireModel(reviewerFor(primary));
    emit(onEvent, { type: 'status', text: `Adversarial reviewer: ${reviewer.label}` });
    try {
      const originalRequest = [...this.session.messages].reverse().find((message) => message.role === 'user' || message.role === 'system');
      const producerDelivery = [...this.session.messages].reverse().find((message) => message.role === 'assistant');
      const evidence = `\n\nMEDUSA EVIDENCE PACKET\nOriginal request:\n${originalRequest?.content ?? 'Unavailable'}\n\nProducer delivery:\n${producerDelivery?.content ?? 'Unavailable'}\n\nWorkspace fingerprint:\n${workspaceFingerprint(this.session.cwd) ?? 'Unavailable'}`;
      const result = await this.run(reviewer.provider, {
        model: reviewer,
        prompt: `${reviewPrompt(primary, this.session.cwd)}\n\n${await this.skills.contextFor('$medusa adversarial review') ?? ''}\n\nOriginal requirements and bootstrapped contract:\n${this.bootstrap.context}${evidence}`,
        cwd: this.session.cwd,
        mode: 'plan',
        ephemeral: true,
        ...(onEvent ? { onEvent } : {}),
      });
      const review = parseReview(result.text, reviewer.id);
      this.session.messages.push(makeMessage('reviewer', review.raw, reviewer.id));
      await this.sessions.save(this.session);
      return review;
    } catch (error) {
      const raw = `Reviewer execution failed: ${error instanceof Error ? error.message : String(error)}`;
      const review = parseReview(raw, reviewer.id);
      this.session.messages.push(makeMessage('reviewer', raw, reviewer.id));
      await this.sessions.save(this.session);
      return review;
    }
  }

  private async remediate(primary: ModelProfile, review: ReviewResult, onEvent?: EventSink): Promise<RunResult> {
    const resumeId = this.session.providerSessions[primary.id];
    const remediationTask = `Mandatory adversarial review returned CHANGES_REQUIRED. Address every valid finding in the workspace, run proportional verification, and explicitly rebut any invalid finding with file/line/test evidence. Do not ignore low-severity findings without explanation.\n\n${review.raw}`;
    const prompt = buildTurnPrompt({ session: this.session, model: primary, userText: remediationTask, includeHandoff: false, bootstrapContext: this.bootstrap.context });
    const result = await this.run(primary.provider, {
      model: primary,
      prompt,
      cwd: this.session.cwd,
      mode: this.session.permissionMode,
      ...(resumeId ? { resumeId } : {}),
      ...(onEvent ? { onEvent } : {}),
    });
    this.recordRun(primary, result);
    this.session.messages.push(makeMessage('assistant', result.text, primary.id));
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

  private async run(provider: ProviderId, request: RunRequest): Promise<RunResult> {
    const protectedRequest: RunRequest = request.onEvent
      ? { ...request, onEvent: (event) => request.onEvent?.({ ...event, text: redactSecrets(event.text) }) }
      : request;
    try {
      const result = await this.registry.get(provider).run(protectedRequest);
      return { ...result, text: redactSecrets(result.text) };
    } catch (error) {
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
    }
  }
}
