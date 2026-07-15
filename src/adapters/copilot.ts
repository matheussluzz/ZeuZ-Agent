import { configuredSecretNames } from '../env.js';
import { permissionArguments } from '../permissions.js';
import { defaultAdapterRuntime, type AdapterRuntime } from './runtime.js';
import type { AgentAdapter, HealthResult, ProviderId, RunRequest, RunResult } from '../types.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' ? value as JsonRecord : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface CopilotAdapterOptions {
  provider?: ProviderId;
  nvidia?: boolean;
  runtime?: AdapterRuntime;
}

export class CopilotAdapter implements AgentAdapter {
  readonly provider: ProviderId;
  private readonly nvidia: boolean;
  private readonly runtime: AdapterRuntime;

  constructor(options: CopilotAdapterOptions = {}) {
    this.provider = options.provider ?? 'copilot';
    this.nvidia = options.nvidia ?? false;
    this.runtime = options.runtime ?? defaultAdapterRuntime;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const executable = this.runtime.findExecutable('copilot');
    if (!executable) throw new Error('copilot was not found in PATH.');

    const nativeSessionId = request.resumeId ?? this.runtime.randomUUID();
    const args = [
      '--prompt', request.prompt,
      '--model', this.wireModel(request),
      '--output-format', 'json',
      '--stream', this.streamMode(request),
      '--session-id', nativeSessionId,
      '-C', request.cwd,
      '--no-remote',
      '--no-remote-export',
      '--no-ask-user',
    ];

    args.push(...permissionArguments(this.provider, request.mode, request.resumeId));

    const secretNames = this.nvidia ? ['COPILOT_PROVIDER_API_KEY'] : configuredSecretNames();
    if (secretNames.length > 0) args.push(`--secret-env-vars=${secretNames.join(',')}`);

    let streamedText = '';
    let finalText = '';
    let usage: Record<string, unknown> | undefined;
    const rawEvents: unknown[] = [];
    const env = this.environment(request);

    const result = await this.runtime.runProcess(executable, args, {
      cwd: request.cwd,
      env,
      ...(request.signal ? { signal: request.signal } : {}),
      onStdoutLine: (line) => {
        if (!line.trim()) return;
        let event: JsonRecord;
        try {
          event = JSON.parse(line) as JsonRecord;
        } catch {
          request.onEvent?.({ type: 'status', text: line });
          return;
        }
        if (rawEvents.length < 250) rawEvents.push(event);
        const type = string(event.type);
        const data = record(event.data);

        if (type === 'assistant.message_delta') {
          const chunk = string(data?.deltaContent);
          if (chunk) {
            streamedText += chunk;
            request.onEvent?.({ type: 'delta', text: chunk });
          }
        }

        if (type === 'assistant.message') finalText = string(data?.content) ?? finalText;
        if (type?.includes('tool') && type.endsWith('start')) {
          request.onEvent?.({ type: 'tool', status: 'started', text: string(data?.toolName) ?? string(data?.name) ?? 'Copilot tool' });
        }
        if (type === 'result') {
          const eventUsage = record(event.usage);
          if (eventUsage) usage = eventUsage;
        }
      },
      onStderrLine: (line) => {
        if (line.trim()) request.onEvent?.({ type: 'status', text: line.trim() });
      },
    });

    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `copilot exited with code ${result.exitCode}`);
    const text = finalText || streamedText;
    if (!text) throw new Error(`${this.provider} completed without a final response.`);
    if (!streamedText) request.onEvent?.({ type: 'delta', text });

    return { text, nativeSessionId, ...(usage ? { usage } : {}), rawEvents };
  }

  async health(): Promise<HealthResult> {
    const started = this.runtime.now();
    const executable = this.runtime.findExecutable('copilot');
    if (!executable) return { provider: this.provider, ok: false, latencyMs: this.runtime.now() - started, detail: 'copilot not found' };
    const result = this.runtime.spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 8_000 });
    return {
      provider: this.provider,
      ok: result.status === 0,
      version: result.stdout.trim().split('\n')[0] ?? '',
      latencyMs: this.runtime.now() - started,
      ...(result.status === 0 ? {} : { detail: result.stderr.trim() }),
    };
  }

  private wireModel(request: RunRequest): string {
    if (!this.nvidia) return request.model.model;
    return request.model.modelEnv
      ? (this.runtime.envGet(request.model.modelEnv) ?? request.model.defaultApiModel ?? request.model.model)
      : request.model.model;
  }

  private streamMode(request: RunRequest): 'on' | 'off' {
    if (!this.nvidia) return 'on';
    return /(?:minimax|qwen|kimi)/i.test(request.model.id) ? 'off' : 'on';
  }

  private environment(request: RunRequest): NodeJS.ProcessEnv {
    if (!this.nvidia) return this.runtime.sanitizedChildEnvironment();
    if (!request.model.apiKeyEnv) throw new Error(`No API key environment configured for ${request.model.id}.`);
    const apiKey = this.runtime.envGet(request.model.apiKeyEnv);
    if (!apiKey || apiKey.startsWith('nvapi-your-')) throw new Error(`Missing ${request.model.apiKeyEnv}. Configure the matching route in private lamine.yaml (or legacy .env).`);
    return this.runtime.sanitizedChildEnvironment({
      COPILOT_PROVIDER_BASE_URL: this.runtime.envGet('NVIDIA_API_BASE_URL') ?? 'https://integrate.api.nvidia.com/v1',
      COPILOT_PROVIDER_API_KEY: apiKey,
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_WIRE_API: 'completions',
      COPILOT_MODEL: this.wireModel(request),
    });
  }
}
