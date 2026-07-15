import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onStdoutChunk?: (chunk: string) => void;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function emitLines(buffer: string, chunk: string, callback?: (line: string) => void): string {
  const combined = buffer + chunk;
  const lines = combined.split(/\r?\n/);
  const remainder = lines.pop() ?? '';
  if (callback) for (const line of lines) callback(line);
  return remainder;
}

export async function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';

    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      child.kill('SIGINT');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_500);
      killTimer.unref();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      options.onStdoutChunk?.(chunk);
      stdoutBuffer = emitLines(stdoutBuffer, chunk, options.onStdoutLine);
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      stderrBuffer = emitLines(stderrBuffer, chunk, options.onStderrLine);
    });

    child.once('error', reject);
    child.once('close', (code) => {
      options.signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      if (stdoutBuffer && options.onStdoutLine) options.onStdoutLine(stdoutBuffer);
      if (stderrBuffer && options.onStderrLine) options.onStderrLine(stderrBuffer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export function findExecutable(name: string): string | undefined {
  const which = spawnSync('which', [name], { encoding: 'utf8' });
  const found = which.status === 0 ? which.stdout.trim().split('\n')[0] : undefined;
  if (found && existsSync(found)) return found;
  return undefined;
}

export function resolveCodexExecutable(): string {
  const candidates = [
    process.env.CODEX_BIN,
    findExecutable('codex'),
    '/Applications/Codex.app/Contents/Resources/codex',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 8_000 });
    if (probe.status === 0) return candidate;
  }
  throw new Error('No healthy Codex executable found. Run `codex doctor`.');
}
