#!/usr/bin/env node

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';
import React from 'react';
import { render } from 'ink';

import { MODEL_CATALOG, DEFAULT_MODEL_ID, requireModel } from './catalog.js';
import { ZeuzController } from './controller.js';
import { installRoot, loadZeuZEnvironment } from './env.js';
import { TaskEngine } from './task-engine.js';
import { TaskResultStore } from './task-result-store.js';
import { stateDirectory } from './state-root.js';
import { TaskStore } from './task-store.js';
import type { PermissionMode } from './types.js';
import { runSkillCommand } from './skill-registry/cli.js';
import { App } from './ui.js';

const require = createRequire(import.meta.url);
const packageJson = require(resolve(installRoot(), 'package.json')) as { version: string };

function parseFlags(args: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith('--')) continue;
    const [name = arg, inline] = arg.split('=', 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (args[index + 1] && !args[index + 1]?.startsWith('--')) flags.set(name, args[++index] ?? '');
    else flags.set(name, true);
  }
  return flags;
}

function flag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function permission(value: string | undefined, fallback: PermissionMode): PermissionMode {
  if (!value) return fallback;
  if (value === 'plan' || value === 'agent' || value === 'yolo') return value;
  throw new Error(`Invalid permission mode: ${value}`);
}

function printCliHelp(): void {
  process.stdout.write(`ZeuZ-Agent ${packageJson.version}\n\n`);
  process.stdout.write('Usage:\n');
  process.stdout.write('  zeuz                              Start the interactive terminal\n');
  process.stdout.write('  zeuz models                       List configured model routes\n');
  process.stdout.write('  zeuz health [--deep]              Check provider health\n');
  process.stdout.write('  zeuz run --model ID --prompt TEXT Run one non-interactive turn\n');
  process.stdout.write('  zeuz delegate --model ID --task TEXT [--mode plan|agent|yolo] [--wait]\n');
  process.stdout.write('  zeuz task list|status|result|cancel|wait|recover [ID]\n');
  process.stdout.write('  zeuz skill list|status|validate|install|update|remove|sync|check [args]\n');
  process.stdout.write('  zeuz version                      Print version\n');
}

async function runNonInteractive(command: 'run' | 'delegate', args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const modelId = flag(flags, '--model') ?? DEFAULT_MODEL_ID;
  const task = flag(flags, '--task') ?? flag(flags, '--prompt');
  const cwd = resolve(flag(flags, '--cwd') ?? installRoot());
  const mode = permission(flag(flags, '--mode'), command === 'delegate' ? 'plan' : 'agent');
  const json = flags.has('--json');
  if (!task) throw new Error(`${command} requires --task or --prompt.`);
  requireModel(modelId);

  if (command === 'delegate') {
    const depth = Number.parseInt(process.env.ZEUZ_DELEGATION_DEPTH ?? '0', 10);
    if (depth >= 1) throw new Error('Delegation depth limit reached (maximum: 1).');
    const engine = new TaskEngine();
    const submitted = await engine.submit({
      ...(process.env.ZEUZ_PARENT_TASK_ID ? { parentTaskId: process.env.ZEUZ_PARENT_TASK_ID } : {}),
      ...(process.env.ZEUZ_PARENT_SESSION_ID ? { parentSessionId: process.env.ZEUZ_PARENT_SESSION_ID } : {}),
      modelId,
      prompt: task,
      cwd,
      mode,
    });
    if (!flags.has('--wait')) {
      const payload = { taskId: submitted.task.id, status: submitted.task.status, workerLaunched: submitted.launched };
      process.stdout.write(json ? `${JSON.stringify(payload)}\n` : `${submitted.task.id}\n`);
      return;
    }
    if (!submitted.launched) await engine.runOne(submitted.task.id);
    const settled = await engine.wait(submitted.task.id);
    if (settled.status !== 'completed' || !settled.result) throw new Error(`Task ${settled.id} settled as ${settled.status}${settled.errorCode ? ` (${settled.errorCode})` : ''}.`);
    const text = await new TaskResultStore({ root: stateDirectory(), now: () => new Date().toISOString() }).retrieve(settled.result);
    process.stdout.write(json ? `${JSON.stringify({ taskId: settled.id, status: settled.status, result: text })}\n` : `${text}\n`);
    return;
  }

  const controller = await ZeuzController.create(cwd, { modelId, mode });
  process.env.ZEUZ_PARENT_SESSION_ID = controller.session.id;
  const outcome = await controller.ask(modelId, task, json ? undefined : (event) => {
    if (event.type === 'status' || event.type === 'tool') process.stderr.write(`[${event.type}] ${event.text}\n`);
  }, mode);
  if (json) process.stdout.write(`${JSON.stringify(outcome)}\n`);
  else process.stdout.write(`${outcome.response}\n`);
}

async function runTaskCommand(args: string[]): Promise<void> {
  const [subcommand, id] = args;
  const store = new TaskStore();
  const engine = new TaskEngine();
  if (subcommand === 'recover') {
    process.stdout.write(`${JSON.stringify(await engine.recover(), null, 2)}\n`);
    return;
  }
  if (subcommand === 'list') {
    const result = await store.listDetailed();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (subcommand === 'worker') {
    if (process.env.ZEUZ_INTERNAL_WORKER !== '1' || !id) throw new Error('Internal task worker invocation is denied.');
    const task = await store.load(id);
    process.env.ZEUZ_PARENT_TASK_ID = task.id;
    process.env.ZEUZ_DELEGATION_DEPTH = String(task.depth + 1);
    await engine.runOne(task.id);
    return;
  }
  if (!id) throw new Error(`task ${subcommand ?? ''} requires an ID.`);
  if (subcommand === 'status') {
    process.stdout.write(`${JSON.stringify(await store.load(id), null, 2)}\n`);
    return;
  }
  if (subcommand === 'cancel') {
    const task = await store.requestCancel(id);
    process.stdout.write(`${JSON.stringify({ taskId: task.id, status: task.status, cancelRequestedAt: task.cancelRequestedAt }, null, 2)}\n`);
    return;
  }
  if (subcommand === 'wait') {
    process.stdout.write(`${JSON.stringify(await engine.wait(id), null, 2)}\n`);
    return;
  }
  if (subcommand === 'result') {
    const task = await store.load(id);
    if (!task.result) throw new Error(`Task result is unavailable: ${task.status}.`);
    process.stdout.write(`${await new TaskResultStore({ root: stateDirectory(), now: () => new Date().toISOString() }).retrieve(task.result)}\n`);
    return;
  }
  throw new Error(`Unknown task command: ${subcommand ?? ''}. Use list, status, result, cancel, wait, or recover.`);
}

async function main(): Promise<void> {
  loadZeuZEnvironment();
  const root = installRoot();
  process.chdir(root);
  process.env.ZEUZ_DELEGATION_DEPTH ??= '0';

  const [command, ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') return printCliHelp();
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }
  if (command === 'models') {
    for (const model of MODEL_CATALOG) process.stdout.write(`${model.id}\t${model.label}\n`);
    return;
  }
  if (command === 'run' || command === 'delegate') return await runNonInteractive(command, args);
  if (command === 'task') return await runTaskCommand(args);
  if (command === 'skill') {
    const result = await runSkillCommand(args, root);
    process.stdout.write(`${result.output}\n`);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  if (command === 'health') {
    const controller = await ZeuzController.create(root);
    process.stdout.write(`${await controller.health(args.includes('--deep'))}\n`);
    return;
  }
  if (command) throw new Error(`Unknown command: ${command}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive mode requires a TTY. Use `zeuz run --prompt ...`.');

  await new TaskEngine().recover();
  const controller = await ZeuzController.create(root);
  const instance = render(<App controller={controller} />, { exitOnCtrlC: false, patchConsole: true });
  await instance.waitUntilExit();
}

main().catch((error) => {
  process.stderr.write(`ZeuZ-Agent error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
