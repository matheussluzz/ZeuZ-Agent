import { spawnSync } from 'node:child_process';

import { sanitizedChildEnvironment } from '../env.js';
import { findExecutable, runProcess } from '../process.js';
import type { AgentAdapter, HealthResult, RunRequest, RunResult } from '../types.js';

export class AgyAdapter implements AgentAdapter {
  readonly provider = 'agy' as const;

  async run(request: RunRequest): Promise<RunResult> {
    const executable = findExecutable('agy');
    if (!executable) throw new Error('agy was not found in PATH.');

    // agy parses flags after --print as prompt input, so --print must be last.
    const args = ['--model', request.model.model];
    if (request.mode !== 'yolo') args.push('--sandbox');
    if (request.mode !== 'plan') args.push('--dangerously-skip-permissions');
    args.push('--print', request.prompt);

    const result = await runProcess(executable, args, {
      cwd: request.cwd,
      env: sanitizedChildEnvironment(),
      ...(request.signal ? { signal: request.signal } : {}),
      onStdoutChunk: (chunk) => request.onEvent?.({ type: 'delta', text: chunk }),
      onStderrLine: (line) => {
        if (line.trim()) request.onEvent?.({ type: 'status', text: line.trim() });
      },
    });

    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `agy exited with code ${result.exitCode}`);
    const text = result.stdout.trim();
    if (!text) throw new Error('Antigravity completed without a final response.');
    return { text };
  }

  async health(): Promise<HealthResult> {
    const started = Date.now();
    const executable = findExecutable('agy');
    if (!executable) return { provider: this.provider, ok: false, latencyMs: Date.now() - started, detail: 'agy not found' };
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 8_000 });
    const version = (result.stdout || result.stderr).trim().split('\n')[0] ?? '';
    return { provider: this.provider, ok: result.status === 0, version, latencyMs: Date.now() - started };
  }
}
