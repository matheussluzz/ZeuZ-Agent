import { defaultAdapterRuntime, type AdapterRuntime } from './runtime.js';
import type { AgentAdapter, HealthResult, RunRequest, RunResult } from '../types.js';

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  item?: {
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    changes?: Array<{ path?: string; kind?: string }>;
    status?: string;
  };
  usage?: Record<string, unknown>;
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const;
  private readonly runtime: AdapterRuntime;

  constructor(runtime: AdapterRuntime = defaultAdapterRuntime) {
    this.runtime = runtime;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const executable = this.runtime.resolveCodexExecutable();
    const args = request.resumeId
      ? this.resumeArgs(request)
      : this.newArgs(request);

    let text = '';
    let nativeSessionId = request.resumeId;
    let usage: Record<string, unknown> | undefined;
    const rawEvents: unknown[] = [];

    const result = await this.runtime.runProcess(executable, args, {
      cwd: request.cwd,
      env: this.runtime.sanitizedChildEnvironment(),
      ...(request.signal ? { signal: request.signal } : {}),
      onStdoutLine: (line) => {
        if (!line.trim()) return;
        let event: CodexEvent;
        try {
          event = JSON.parse(line) as CodexEvent;
        } catch {
          request.onEvent?.({ type: 'status', text: line });
          return;
        }

        if (rawEvents.length < 250) rawEvents.push(event);
        if (event.type === 'thread.started' && event.thread_id) nativeSessionId = event.thread_id;
        if (event.type === 'turn.completed' && event.usage) usage = event.usage;

        if (event.type === 'item.started' && event.item?.type === 'command_execution') {
          request.onEvent?.({ type: 'tool', status: 'started', text: event.item.command ?? 'Running command' });
        }

        if (event.type === 'item.completed') {
          if (event.item?.type === 'agent_message' && event.item.text) text = event.item.text;
          if (event.item?.type === 'command_execution') {
            const label = event.item.command ?? 'Command';
            request.onEvent?.({ type: 'tool', status: event.item.status === 'failed' ? 'failed' : 'completed', text: label });
          }
          if (event.item?.type === 'file_change') {
            const files = event.item.changes?.map((change) => change.path).filter(Boolean).join(', ') || 'workspace files';
            request.onEvent?.({ type: 'diff', text: `Changed ${files}` });
          }
        }

        if (event.type === 'error' || event.type === 'turn.failed') {
          request.onEvent?.({ type: 'error', text: event.message ?? 'Codex turn failed' });
        }
      },
      onStderrLine: (line) => {
        if (line.trim() && !line.includes('OpenAI Codex')) request.onEvent?.({ type: 'status', text: line.trim() });
      },
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Codex exited with code ${result.exitCode}`);
    }
    if (!text) throw new Error('Codex completed without a final agent message.');

    return {
      text,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(usage ? { usage } : {}),
      rawEvents,
    };
  }

  async health(): Promise<HealthResult> {
    const started = this.runtime.now();
    try {
      const executable = this.runtime.resolveCodexExecutable();
      const result = this.runtime.spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 8_000 });
      return {
        provider: this.provider,
        ok: result.status === 0,
        version: result.stdout.trim(),
        latencyMs: this.runtime.now() - started,
        ...(result.status === 0 ? {} : { detail: result.stderr.trim() }),
      };
    } catch (error) {
      return { provider: this.provider, ok: false, latencyMs: this.runtime.now() - started, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private newArgs(request: RunRequest): string[] {
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', request.cwd, '-m', request.model.model];
    if (request.model.reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(request.model.reasoningEffort)}`);
    if (request.ephemeral) args.push('--ephemeral');
    if (request.mode === 'yolo') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', request.mode === 'plan' ? 'read-only' : 'workspace-write');
    args.push(request.prompt);
    return args;
  }

  private resumeArgs(request: RunRequest): string[] {
    const args = ['exec', 'resume', '--json', '--skip-git-repo-check', '-m', request.model.model];
    if (request.model.reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(request.model.reasoningEffort)}`);
    if (request.ephemeral) args.push('--ephemeral');
    if (request.mode === 'yolo') args.push('--dangerously-bypass-approvals-and-sandbox');
    args.push(request.resumeId ?? '', request.prompt);
    return args;
  }
}
