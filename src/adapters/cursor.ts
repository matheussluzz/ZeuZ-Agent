import { defaultAdapterRuntime, type AdapterRuntime } from './runtime.js';
import { permissionArguments } from '../permissions.js';
import type { AgentAdapter, HealthResult, RunRequest, RunResult } from '../types.js';
import { assertProcessNotCancelled, assertSafeProcessCompletion, JsonlProtocolState, withBoundedEvents } from './protocol.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' ? value as JsonRecord : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class CursorAdapter implements AgentAdapter {
  readonly provider = 'cursor' as const;
  private readonly runtime: AdapterRuntime;

  constructor(runtime: AdapterRuntime = defaultAdapterRuntime) {
    this.runtime = runtime;
  }

  async run(request: RunRequest): Promise<RunResult> {
    request = withBoundedEvents(request);
    const executable = this.runtime.findExecutable('cursor-agent');
    if (!executable) throw new Error('cursor-agent was not found in PATH.');

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--workspace', request.cwd,
      '--trust',
      '--model', request.model.model,
    ];

    args.push(...permissionArguments(this.provider, request.mode, request.resumeId));
    if (request.resumeId) args.push('--resume', request.resumeId);
    args.push(request.prompt);

    let streamedText = '';
    let finalText = '';
    let nativeSessionId = request.resumeId;
    let usage: Record<string, unknown> | undefined;
    const protocol = new JsonlProtocolState<JsonRecord>();

    const result = await this.runtime.runProcess(executable, args, {
      cwd: request.cwd,
      env: this.runtime.sanitizedChildEnvironment(),
      ...(request.signal ? { signal: request.signal } : {}),
      onStdoutLine: (line) => {
        if (!line.trim()) return;
        const event = protocol.parse(line);

        nativeSessionId = string(event.session_id) ?? string(event.sessionId) ?? nativeSessionId;
        const eventType = string(event.type);
        if (eventType === 'stream_event') {
          const inner = record(event.event);
          const delta = record(inner?.delta);
          const chunk = string(delta?.text) ?? string(delta?.content);
          if (chunk) {
            streamedText += chunk;
            request.onEvent?.({ type: 'delta', text: chunk });
          }
        }

        if (eventType === 'assistant') {
          const message = record(event.message);
          const content = Array.isArray(message?.content) ? message.content : [];
          for (const partValue of content) {
            const part = record(partValue);
            if (part?.type === 'tool_use') request.onEvent?.({ type: 'tool', status: 'started', text: string(part.name) ?? 'Cursor tool' });
            const chunk = string(part?.text);
            if (chunk && !streamedText.includes(chunk)) {
              streamedText += chunk;
              request.onEvent?.({ type: 'delta', text: chunk });
            }
          }
        }

        if (eventType === 'result') {
          finalText = string(event.result) ?? finalText;
          const eventUsage = record(event.usage);
          if (eventUsage) usage = eventUsage;
        }
      },
      onStderrLine: (line) => {
        if (line.trim()) request.onEvent?.({ type: 'status', text: line.trim() });
      },
    });

    assertSafeProcessCompletion(result);
    assertProcessNotCancelled(result, nativeSessionId ? { nativeSessionId } : {});
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `cursor-agent exited with code ${result.exitCode}`);
    const text = finalText || streamedText;
    if (!text) throw new Error('Cursor completed without a final response.');
    if (!streamedText) request.onEvent?.({ type: 'delta', text });

    return {
      text,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(usage ? { usage } : {}),
      rawEvents: protocol.rawEvents(),
    };
  }

  async health(): Promise<HealthResult> {
    const started = this.runtime.now();
    const executable = this.runtime.findExecutable('cursor-agent');
    if (!executable) return { provider: this.provider, ok: false, latencyMs: this.runtime.now() - started, detail: 'cursor-agent not found' };
    const result = this.runtime.spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 8_000 });
    return {
      provider: this.provider,
      ok: result.status === 0,
      version: result.stdout.trim(),
      latencyMs: this.runtime.now() - started,
      ...(result.status === 0 ? {} : { detail: result.stderr.trim() }),
    };
  }
}
