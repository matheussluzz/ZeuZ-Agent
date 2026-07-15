import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { installRoot, sanitizedChildEnvironment } from '../env.js';
import { gitDiff } from '../git.js';
import { findExecutable } from '../process.js';
import { assertDirectShellPolicy, isCredentialPath } from '../security-policy.js';
import type { AgentAdapter, HealthResult, PermissionMode, RunRequest, RunResult } from '../types.js';
import { CopilotAdapter } from './copilot.js';
import { defaultAdapterRuntime, type AdapterRuntime } from './runtime.js';

interface DirectMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DirectAction {
  action: 'tool' | 'final';
  tool?: string;
  input?: Record<string, unknown>;
  content?: string;
}

const DIRECT_HARNESS = /(?:minimax|qwen|kimi)/i;
const MAX_TOOL_STEPS = 16;
const MAX_TOOL_OUTPUT = 60_000;

const SYSTEM_PROMPT = `You are a coding agent inside ZeuZ-Agent. You have local tools through a strict JSON action protocol.

At every step, return exactly one JSON object and no Markdown fences:
- Tool call: {"action":"tool","tool":"read_file|list_files|search|write_file|replace_in_file|run_command|git_diff|delegate","input":{...}}
- Final answer: {"action":"final","content":"your answer to the user"}

Tool inputs:
- read_file: {"path":"relative/path","start":1,"end":240}
- list_files: {"pattern":"optional glob"}
- search: {"query":"literal text","path":"optional relative path"}
- write_file: {"path":"relative/path","content":"complete content"}
- replace_in_file: {"path":"relative/path","old":"exact text","new":"replacement","all":false}
- run_command: {"command":"command to run from the workspace"}
- git_diff: {}
- delegate: {"model":"model id","task":"bounded task","mode":"plan|agent"}

Rules:
- Read before editing. Keep changes minimal and inside the active workspace.
- Never access, print, or persist secrets. Never read .env or auth files.
- In plan mode, write tools and mutating commands will fail.
- Verify changes with proportional commands/tests before returning final.
- Be brutally honest about failures and uncertainty.
- If a tool fails, adapt or report the failure; never pretend it succeeded.`;

export function safeWorkspacePath(cwd: string, input: unknown, forWrite = false): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('A non-empty relative path is required.');
  if (isAbsolute(input)) throw new Error('Absolute paths are not allowed.');
  const root = realpathSync(cwd);
  const target = resolve(root, input);
  const relation = relative(root, target);
  if (relation.startsWith('..') || isAbsolute(relation)) throw new Error('Path escapes the active workspace.');
  if (existsSync(target)) {
    const actual = realpathSync(target);
    const actualRelation = relative(root, actual);
    if (actualRelation.startsWith('..') || isAbsolute(actualRelation)) throw new Error('Symlink escapes the active workspace.');
    if (lstatSync(target).isSymbolicLink() && forWrite) throw new Error('Writing through symlinks is not allowed.');
    return actual;
  }
  if (forWrite) {
    let parent = dirname(target);
    while (!existsSync(parent) && parent !== root) parent = dirname(parent);
    const actualParent = realpathSync(parent);
    const parentRelation = relative(root, actualParent);
    if (parentRelation.startsWith('..') || isAbsolute(parentRelation)) throw new Error('Parent path escapes the active workspace.');
  }
  return target;
}

function bounded(value: string): string {
  return value.length <= MAX_TOOL_OUTPUT ? value : `${value.slice(0, MAX_TOOL_OUTPUT)}\n… output truncated …`;
}

function parseAction(content: string): DirectAction | undefined {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as DirectAction;
    return parsed.action === 'tool' || parsed.action === 'final' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function safeHttpError(response: Response): Promise<string> {
  let title = response.statusText || 'request failed';
  try {
    const payload = JSON.parse(await response.text()) as { title?: unknown; detail?: unknown };
    if (typeof payload.title === 'string' && payload.title.trim()) title = payload.title.trim();
  } catch {
    // Provider error bodies can contain account identifiers or echoed input; do not surface them.
  }
  if (response.status === 401 || response.status === 403) return `NVIDIA HTTP ${response.status}: authentication or authorization failed.`;
  if (response.status === 404) return 'NVIDIA HTTP 404: this model endpoint is unavailable for the configured account.';
  if (response.status === 429) return 'NVIDIA HTTP 429: rate limit or quota reached.';
  return `NVIDIA HTTP ${response.status}: ${title.slice(0, 160)}.`;
}

export function runSandboxedCommand(cwd: string, command: string, mode: PermissionMode): string {
  assertDirectShellPolicy(command, mode);

  if (mode === 'plan') {
    const first = command.trim().split(/\s+/)[0] ?? '';
    if (!['git', 'rg', 'ls', 'pwd', 'cat', 'sed', 'head', 'tail', 'wc'].includes(first)) throw new Error(`Command is not allowed in plan mode: ${first}`);
    if (/\b(?:add|commit|switch|checkout|branch|merge|rebase|clean|restore|reset|apply)\b/.test(command) && first === 'git') throw new Error('Mutating Git command denied in plan mode.');
  }

  const env = sanitizedChildEnvironment({ ZEUZ_DELEGATION_DEPTH: process.env.ZEUZ_DELEGATION_DEPTH ?? '0' });
  let executable = '/bin/zsh';
  let args = ['-lc', command];

  if (mode !== 'yolo') {
    const sandbox = findExecutable('sandbox-exec');
    if (!sandbox) throw new Error('sandbox-exec is unavailable; direct shell commands require yolo or a provider-native agent.');
    const realRoot = realpathSync(cwd);
    const escapedRoot = realRoot.replaceAll('"', '\\"');
    const realInstallRoot = realpathSync(installRoot());
    const privatePaths = new Set([
      resolve(realRoot, '.env'),
      resolve(realRoot, 'lamine.yaml'),
      resolve(realInstallRoot, '.env'),
      resolve(realInstallRoot, 'lamine.yaml'),
    ]);
    const privateReadDenials = [...privatePaths].map((path) => `(deny file-read-data (literal "${path.replaceAll('"', '\\"')}"))`).join('\n');
    const privateWriteDenials = [...privatePaths].map((path) => `(deny file-write* (literal "${path.replaceAll('"', '\\"')}"))`).join('\n');
    const runtimeReadPaths = [process.execPath, findExecutable('node'), findExecutable('pnpm'), findExecutable('npm'), findExecutable('python3'), findExecutable('git'), findExecutable('rg')]
      .filter((path): path is string => Boolean(path))
      .map((path) => {
        try { return realpathSync(path); } catch { return path; }
      });
    const runtimeAllows = [...new Set(runtimeReadPaths)].map((path) => `(allow file-read-data (literal "${path.replaceAll('"', '\\"')}"))`).join('\n');
    const escapedHome = realpathSync(homedir()).replaceAll('"', '\\"');
    const writeRules = mode === 'agent'
      ? `(allow file-write* (subpath "${escapedRoot}") (subpath "/private/tmp") (subpath "/tmp") (subpath "/dev"))\n${privateWriteDenials}`
      : '';
    const profile = `(version 1)\n(allow default)\n(deny file-read-data (subpath "${escapedHome}"))\n(allow file-read-data (subpath "${escapedRoot}"))\n${runtimeAllows}\n${privateReadDenials}\n(deny file-write*)\n${writeRules}`;
    executable = sandbox;
    args = ['-p', profile, '/bin/zsh', '-fc', command];
  }

  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: MAX_TOOL_OUTPUT * 2 });
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command exited ${result.status ?? result.signal ?? 'unknown'}: ${bounded(output)}`);
  return bounded(output || '(command succeeded with no output)');
}

function executeTool(request: RunRequest, action: DirectAction): string {
  const input = action.input ?? {};
  switch (action.tool) {
    case 'read_file': {
      const path = safeWorkspacePath(request.cwd, input.path);
      if (isCredentialPath(path)) throw new Error('Reading secret-bearing files is denied.');
      const lines = readFileSync(path, 'utf8').split('\n');
      const start = Math.max(1, Number(input.start ?? 1));
      const end = Math.min(lines.length, Number(input.end ?? start + 239), start + 1_999);
      return bounded(lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n'));
    }
    case 'list_files': {
      const args = ['--files', '--hidden', '--glob', '!.git/**', '--glob', '!.env*', '--glob', '!lamine*.yaml', '--glob', '!.npmrc'];
      if (typeof input.pattern === 'string' && input.pattern.trim()) args.push('--glob', input.pattern);
      const result = spawnSync('rg', args, { cwd: request.cwd, env: sanitizedChildEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: MAX_TOOL_OUTPUT * 2 });
      if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr.trim());
      return bounded(result.stdout.trim() || '(no files matched)');
    }
    case 'search': {
      if (typeof input.query !== 'string' || !input.query) throw new Error('search.query is required.');
      const path = input.path ? safeWorkspacePath(request.cwd, input.path) : request.cwd;
      const result = spawnSync('rg', ['-n', '--hidden', '--glob', '!.git/**', '--glob', '!.env*', '--glob', '!lamine*.yaml', '--glob', '!.npmrc', '--fixed-strings', input.query, path], { cwd: request.cwd, env: sanitizedChildEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: MAX_TOOL_OUTPUT * 2 });
      if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr.trim());
      return bounded(result.stdout.trim() || '(no matches)');
    }
    case 'write_file': {
      if (request.mode === 'plan') throw new Error('write_file is disabled in plan mode.');
      const path = safeWorkspacePath(request.cwd, input.path, true);
      if (isCredentialPath(path)) throw new Error('Writing secret-bearing files is denied.');
      if (typeof input.content !== 'string') throw new Error('write_file.content must be a string.');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, input.content, { encoding: 'utf8', mode: 0o644 });
      return `Wrote ${relative(request.cwd, path)} (${Buffer.byteLength(input.content)} bytes).`;
    }
    case 'replace_in_file': {
      if (request.mode === 'plan') throw new Error('replace_in_file is disabled in plan mode.');
      const path = safeWorkspacePath(request.cwd, input.path, true);
      if (isCredentialPath(path)) throw new Error('Writing secret-bearing files is denied.');
      if (typeof input.old !== 'string' || typeof input.new !== 'string' || !input.old) throw new Error('replace_in_file requires non-empty old and string new.');
      const current = readFileSync(path, 'utf8');
      const count = current.split(input.old).length - 1;
      if (count === 0) throw new Error('Exact old text was not found.');
      if (count > 1 && input.all !== true) throw new Error(`Old text occurs ${count} times; set all=true or provide more context.`);
      const next = input.all === true ? current.split(input.old).join(input.new) : current.replace(input.old, input.new);
      writeFileSync(path, next, 'utf8');
      return `Replaced ${input.all === true ? count : 1} occurrence(s) in ${relative(request.cwd, path)}.`;
    }
    case 'run_command': {
      if (typeof input.command !== 'string') throw new Error('run_command.command is required.');
      return runSandboxedCommand(request.cwd, input.command, request.mode);
    }
    case 'git_diff':
      return bounded(gitDiff(request.cwd));
    case 'delegate': {
      if (typeof input.model !== 'string' || typeof input.task !== 'string') throw new Error('delegate requires model and task.');
      const mode = input.mode === 'agent' ? 'agent' : 'plan';
      const bin = resolve(installRoot(), 'bin', 'agents');
      const result = spawnSync(process.execPath, [bin, 'delegate', '--model', input.model, '--task', input.task, '--mode', mode, '--cwd', request.cwd], {
        cwd: request.cwd,
        env: sanitizedChildEnvironment({ ZEUZ_INSTALL_DIR: installRoot(), ZEUZ_DELEGATION_DEPTH: process.env.ZEUZ_DELEGATION_DEPTH ?? '0' }),
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: MAX_TOOL_OUTPUT * 2,
      });
      if (result.status !== 0) throw new Error(result.stderr.trim() || 'Delegate failed.');
      return bounded(result.stdout.trim());
    }
    default:
      throw new Error(`Unknown tool: ${action.tool ?? '(missing)'}`);
  }
}

export interface NvidiaAdapterOptions {
  runtime?: AdapterRuntime;
  copilot?: CopilotAdapter;
}

export class NvidiaAdapter implements AgentAdapter {
  readonly provider = 'nvidia' as const;
  private readonly runtime: AdapterRuntime;
  private readonly copilot: CopilotAdapter;

  constructor(options: NvidiaAdapterOptions = {}) {
    this.runtime = options.runtime ?? defaultAdapterRuntime;
    this.copilot = options.copilot ?? new CopilotAdapter({ provider: 'nvidia', nvidia: true, runtime: this.runtime });
  }

  async run(request: RunRequest): Promise<RunResult> {
    if (!DIRECT_HARNESS.test(request.model.id)) return await this.copilot.run(request);
    return await this.runDirect(request);
  }

  async health(): Promise<HealthResult> {
    return await this.copilot.health();
  }

  private async runDirect(request: RunRequest): Promise<RunResult> {
    if (!request.model.apiKeyEnv) throw new Error(`No API key configured for ${request.model.id}.`);
    const apiKey = process.env[request.model.apiKeyEnv];
    if (!apiKey || apiKey.startsWith('nvapi-your-')) throw new Error(`Missing ${request.model.apiKeyEnv}. Configure the matching route in private lamine.yaml (or legacy .env).`);
    const model = request.model.modelEnv ? (process.env[request.model.modelEnv] ?? request.model.defaultApiModel ?? request.model.model) : request.model.model;
    if (request.prompt.trim() === 'Reply with exactly: ok') {
      const text = await this.complete({
        apiKey,
        model,
        messages: [
          { role: 'system', content: 'This is a health probe. Reply with exactly: ok' },
          { role: 'user', content: 'Reply with exactly: ok' },
        ],
        maxTokens: 64,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      request.onEvent?.({ type: 'delta', text });
      return { text };
    }
    const messages: DirectMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: request.prompt },
    ];
    let invalidActions = 0;

    for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
      if (request.signal?.aborted) throw new Error('NVIDIA turn aborted.');
      const content = await this.complete({ apiKey, model, messages, ...(request.signal ? { signal: request.signal } : {}) });
      const action = parseAction(content);
      if (!action) {
        invalidActions += 1;
        if (invalidActions >= 2) {
          request.onEvent?.({ type: 'warning', text: 'Model did not follow the JSON tool protocol; returning its raw response.' });
          request.onEvent?.({ type: 'delta', text: content });
          return { text: content };
        }
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: 'Protocol error: return exactly one JSON action object using the documented schema.' });
        continue;
      }

      if (action.action === 'final') {
        const text = action.content?.trim() || '(The model returned an empty final response.)';
        request.onEvent?.({ type: 'delta', text });
        return { text };
      }

      const toolName = action.tool ?? '(missing)';
      request.onEvent?.({ type: 'tool', status: 'started', text: toolName });
      let result: string;
      try {
        result = executeTool(request, action);
        request.onEvent?.({ type: 'tool', status: 'completed', text: toolName });
      } catch (error) {
        result = `TOOL ERROR: ${error instanceof Error ? error.message : String(error)}`;
        request.onEvent?.({ type: 'tool', status: 'failed', text: `${toolName}: ${result}` });
      }
      messages.push({ role: 'assistant', content: JSON.stringify(action) });
      messages.push({ role: 'user', content: `TOOL RESULT (${toolName}):\n${bounded(result)}\n\nReturn the next JSON action.` });
    }
    throw new Error(`NVIDIA direct agent exceeded ${MAX_TOOL_STEPS} tool steps.`);
  }

  private async complete(input: { apiKey: string; model: string; messages: DirectMessage[]; maxTokens?: number; signal?: AbortSignal }): Promise<string> {
    const timeout = AbortSignal.timeout(90_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const response = await fetch(`${(process.env.NVIDIA_API_BASE_URL ?? 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: input.model, messages: input.messages, stream: false, max_tokens: input.maxTokens ?? 4096, temperature: 0.2, top_p: 0.95 }),
      signal,
    });
    if (!response.ok) throw new Error(await safeHttpError(response));
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
    const message = payload.choices?.[0]?.message;
    const content = message?.content?.trim();
    if (content) return content;
    const reasoning = message?.reasoning_content?.trim();
    if (reasoning) return reasoning;
    throw new Error('NVIDIA returned no message content.');
  }
}
