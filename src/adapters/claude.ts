import { defaultAdapterRuntime, type AdapterRuntime } from './runtime.js';
import type { AgentAdapter, HealthResult, RunRequest, RunResult } from '../types.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' ? value as JsonRecord : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;
  private readonly runtime: AdapterRuntime;

  constructor(runtime: AdapterRuntime = defaultAdapterRuntime) {
    this.runtime = runtime;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const executable = this.runtime.findExecutable('claude');
    if (!executable) throw new Error('claude was not found in PATH. Install Claude Code or select the Cursor Fable route.');

    const args = [
      '--print', request.prompt,
      '--model', request.model.model,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--no-chrome',
    ];

    if (request.mode === 'plan') args.push('--permission-mode', 'plan');
    if (request.mode === 'agent') args.push('--permission-mode', 'acceptEdits');
    if (request.mode === 'yolo') args.push('--dangerously-skip-permissions');
    if (request.resumeId) args.push('--resume', request.resumeId);
    if (request.ephemeral) args.push('--no-session-persistence');

    let streamedText = '';
    let finalText = '';
    let nativeSessionId = request.resumeId;
    let usage: Record<string, unknown> | undefined;
    let resultError: string | undefined;
    const rawEvents: unknown[] = [];

    const result = await this.runtime.runProcess(executable, args, {
      cwd: request.cwd,
      env: this.runtime.sanitizedChildEnvironment({ CLAUDE_CODE_SKIP_PROMPT_HISTORY: request.ephemeral ? '1' : undefined }),
      ...(request.signal ? { signal: request.signal } : {}),
      onStdoutLine: (line) => {
        if (!line.trim()) return;
        let event: JsonRecord;
        try {
          event = JSON.parse(line) as JsonRecord;
        } catch {
          request.onEvent?.({ type: 'status', text: line.trim() });
          return;
        }
        if (rawEvents.length < 250) rawEvents.push(event);
        nativeSessionId = string(event.session_id) ?? string(event.sessionId) ?? nativeSessionId;

        const type = string(event.type);
        if (type === 'stream_event') {
          const inner = record(event.event);
          const delta = record(inner?.delta);
          const chunk = string(delta?.text) ?? string(delta?.content);
          if (chunk) {
            streamedText += chunk;
            request.onEvent?.({ type: 'delta', text: chunk });
          }
        }

        if (type === 'assistant') {
          const message = record(event.message);
          const content = Array.isArray(message?.content) ? message.content : [];
          for (const partValue of content) {
            const part = record(partValue);
            if (part?.type === 'tool_use') request.onEvent?.({ type: 'tool', status: 'started', text: string(part.name) ?? 'Claude tool' });
            const chunk = string(part?.text);
            if (chunk && !streamedText.includes(chunk)) {
              streamedText += chunk;
              request.onEvent?.({ type: 'delta', text: chunk });
            }
          }
        }

        if (type === 'result') {
          finalText = string(event.result) ?? finalText;
          const eventUsage = record(event.usage) ?? record(event.modelUsage);
          if (eventUsage) usage = eventUsage;
          if (event.is_error === true || typeof event.api_error_status === 'number') {
            resultError = finalText || string(event.error) || `Claude API error ${String(event.api_error_status ?? 'unknown')}`;
          }
        }
      },
      onStderrLine: (line) => {
        if (line.trim()) request.onEvent?.({ type: 'status', text: line.trim() });
      },
    });

    if (resultError) throw new Error(resultError);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim().slice(0, 2_000) || `claude exited with code ${result.exitCode}`);
    const text = finalText || streamedText;
    if (!text) throw new Error('Claude completed without a final response.');
    if (!streamedText) request.onEvent?.({ type: 'delta', text });
    return {
      text,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(usage ? { usage } : {}),
      rawEvents,
    };
  }

  async health(): Promise<HealthResult> {
    const started = this.runtime.now();
    const executable = this.runtime.findExecutable('claude');
    if (!executable) return { provider: this.provider, ok: false, latencyMs: this.runtime.now() - started, detail: 'claude not installed (optional)' };
    const result = this.runtime.spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 8_000 });
    const version = result.stdout.trim().split('\n')[0] ?? '';
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    const fableCapable = Boolean(match && [Number(match[1]), Number(match[2]), Number(match[3])].join('.').localeCompare('2.1.170', undefined, { numeric: true }) >= 0);
    const ok = result.status === 0 && fableCapable;
    return {
      provider: this.provider,
      ok,
      version,
      latencyMs: this.runtime.now() - started,
      ...(ok ? {} : { detail: result.status === 0 ? 'Claude Code 2.1.170+ is required for the configured Fable 5 fallback.' : result.stderr.trim() }),
    };
  }
}
