#!/usr/bin/env node

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';
import React from 'react';
import { render } from 'ink';

import { MODEL_CATALOG, DEFAULT_MODEL_ID, requireModel } from './catalog.js';
import { ZeuzController } from './controller.js';
import { installRoot, loadZeuZEnvironment } from './env.js';
import { TaskStore } from './task-store.js';
import type { PermissionMode } from './types.js';
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
  process.stdout.write('  zeuz delegate --model ID --task TEXT [--mode plan|agent|yolo]\n');
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

  const taskStore = new TaskStore();
  let release: (() => Promise<void>) | undefined;
  let taskRecord;

  if (command === 'delegate') {
    const depth = Number.parseInt(process.env.ZEUZ_DELEGATION_DEPTH ?? '0', 10);
    if (depth >= 1) throw new Error('Delegation depth limit reached (maximum: 1).');
    process.env.ZEUZ_DELEGATION_DEPTH = String(depth + 1);
    release = await taskStore.acquireSlot();
    taskRecord = await taskStore.create({
      ...(process.env.ZEUZ_PARENT_SESSION_ID ? { parentSessionId: process.env.ZEUZ_PARENT_SESSION_ID } : {}),
      modelId,
      prompt: task,
      cwd,
      mode,
    });
    taskRecord.status = 'running';
    await taskStore.save(taskRecord);
  }

  try {
    const controller = await ZeuzController.create(cwd, { modelId, mode });
    process.env.ZEUZ_PARENT_SESSION_ID = controller.session.id;
    const outcome = await controller.ask(modelId, task, json ? undefined : (event) => {
      if (event.type === 'status' || event.type === 'tool') process.stderr.write(`[${event.type}] ${event.text}\n`);
    }, mode);

    if (taskRecord) {
      taskRecord.status = 'completed';
      taskRecord.resultPreview = outcome.response.slice(0, 500);
      await taskStore.save(taskRecord);
    }

    if (json) process.stdout.write(`${JSON.stringify(outcome)}\n`);
    else process.stdout.write(`${outcome.response}\n`);
  } catch (error) {
    if (taskRecord) {
      taskRecord.status = 'failed';
      taskRecord.error = error instanceof Error ? error.message : String(error);
      await taskStore.save(taskRecord);
    }
    throw error;
  } finally {
    await release?.();
  }
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
  if (command === 'health') {
    const controller = await ZeuzController.create(root);
    process.stdout.write(`${await controller.health(args.includes('--deep'))}\n`);
    return;
  }
  if (command) throw new Error(`Unknown command: ${command}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive mode requires a TTY. Use `zeuz run --prompt ...`.');

  const controller = await ZeuzController.create(root);
  const instance = render(<App controller={controller} />, { exitOnCtrlC: false, patchConsole: true });
  await instance.waitUntilExit();
}

main().catch((error) => {
  process.stderr.write(`ZeuZ-Agent error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
