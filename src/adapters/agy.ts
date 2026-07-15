import { defaultAdapterRuntime, type AdapterRuntime } from './runtime.js';
import { permissionArguments } from '../permissions.js';
import type { AgentAdapter, HealthResult, RunRequest, RunResult } from '../types.js';
import { assertProcessNotCancelled, assertSafeProcessCompletion, withBoundedEvents } from './protocol.js';

export class AgyAdapter implements AgentAdapter {
  readonly provider = 'agy' as const;
  private readonly runtime: AdapterRuntime;

  constructor(runtime: AdapterRuntime = defaultAdapterRuntime) {
    this.runtime = runtime;
  }

  async run(request: RunRequest): Promise<RunResult> {
    request = withBoundedEvents(request);
    const executable = this.runtime.findExecutable('agy');
    if (!executable) throw new Error('agy was not found in PATH.');

    // agy parses flags after --print as prompt input, so --print must be last.
    const args = ['--model', request.model.model];
    args.push(...permissionArguments(this.provider, request.mode, request.resumeId));
    args.push('--print', request.prompt);

    const result = await this.runtime.runProcess(executable, args, {
      cwd: request.cwd,
      env: this.runtime.sanitizedChildEnvironment(),
      ...(request.signal ? { signal: request.signal } : {}),
      onStdoutChunk: (chunk) => request.onEvent?.({ type: 'delta', text: chunk }),
      onStderrLine: (line) => {
        if (line.trim()) request.onEvent?.({ type: 'status', text: line.trim() });
      },
    });

    assertSafeProcessCompletion(result);
    assertProcessNotCancelled(result);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `agy exited with code ${result.exitCode}`);
    const text = result.stdout.trim();
    if (!text) throw new Error('Antigravity completed without a final response.');
    return { text };
  }

  async health(): Promise<HealthResult> {
    const started = this.runtime.now();
    const executable = this.runtime.findExecutable('agy');
    if (!executable) return { provider: this.provider, ok: false, latencyMs: this.runtime.now() - started, detail: 'agy not found' };
    const result = this.runtime.spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 8_000 });
    const version = (result.stdout || result.stderr).trim().split('\n')[0] ?? '';
    return { provider: this.provider, ok: result.status === 0, version, latencyMs: this.runtime.now() - started };
  }
}
