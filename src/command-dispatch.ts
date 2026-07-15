export const COMMAND_NAMES = [
  'model',
  'ask',
  'subagents',
  'tasks',
  'plan',
  'permissions',
  'status',
  'health',
  'diff',
  'review',
  'compact',
  'new',
  'resume',
  'clear',
  'copy',
  'fork',
  'branch',
  'cd',
  'user',
  'onboard',
  'bootstrap',
  'skills',
  'help',
  'exit',
] as const;

export type CommandName = typeof COMMAND_NAMES[number];

const ALIASES: Readonly<Record<string, CommandName>> = {
  quit: 'exit',
};

export interface ParsedCommand {
  name: CommandName;
  requestedName: string;
  argument: string;
  source: string;
}

function candidatesFor(requestedName: string): CommandName[] {
  const candidates = new Set<CommandName>();
  for (const name of COMMAND_NAMES) {
    if (name.startsWith(requestedName)) candidates.add(name);
  }
  for (const [alias, name] of Object.entries(ALIASES)) {
    if (alias.startsWith(requestedName)) candidates.add(name);
  }
  return [...candidates];
}

export function parseCommand(source: string): ParsedCommand {
  if (!source.trimStart().startsWith('/')) throw new Error('Command input must start with /.');
  const body = source.trim().slice(1).trim();
  if (!body) throw new Error('Command name is required.');

  const separator = body.search(/\s/);
  const requestedName = (separator < 0 ? body : body.slice(0, separator)).toLowerCase();
  const argument = separator < 0 ? '' : body.slice(separator).trim();
  if (!/^[a-z][a-z0-9-]*$/.test(requestedName)) throw new Error(`Invalid command syntax: /${requestedName}`);

  const exact = COMMAND_NAMES.find((name) => name === requestedName) ?? ALIASES[requestedName];
  if (exact) return { name: exact, requestedName, argument, source };

  const candidates = candidatesFor(requestedName);
  if (candidates.length > 1) throw new Error(`Ambiguous command: /${requestedName} (${candidates.join(', ')})`);
  throw new Error(`Unknown command: /${requestedName}. Use /help.`);
}

export async function dispatchCommand<T>(source: string, executor: (command: ParsedCommand) => T | Promise<T>): Promise<T> {
  return await executor(parseCommand(source));
}
