import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import chalk from 'chalk';

import { MODEL_CATALOG, isConfigured } from './catalog.js';
import { dispatchCommand } from './command-dispatch.js';
import { ROUTING_GUIDE } from './orchestration.js';
import { TaskStore } from './task-store.js';
import type { AgentEvent, ModelProfile, OnboardingAnswers, PermissionMode, ReviewResult, ZeuzSession, ZeuzUseCase } from './types.js';
import type { ZeuzController } from './controller.js';

interface TranscriptItem {
  id: string;
  kind: 'user' | 'assistant' | 'system' | 'review';
  title: string;
  content: string;
}

type PickerState =
  | { kind: 'models'; query: string; index: number }
  | { kind: 'sessions'; query: string; index: number; sessions: ZeuzSession[] };

interface AppProps {
  controller: ZeuzController;
}

interface OnboardingState {
  step: number;
  values: string[];
}

const ONBOARDING_QUESTIONS = [
  'What will you primarily use ZeuZ for? Choose: development, data, or product.',
  'What outcome do you want ZeuZ to help you achieve in this repository?',
  'What domain context, constraints, or non-negotiable rules should ZeuZ know?',
  'How familiar are you with this work? Choose: novice, intermediate, or advanced.',
  'How should ZeuZ teach or explain unfamiliar topics while delivering?',
  'How much autonomy should ZeuZ use before pausing for your confirmation?',
] as const;

function onboardingAnswers(values: string[]): OnboardingAnswers {
  const useCase = values[0] as ZeuzUseCase;
  const proficiency = values[3] as OnboardingAnswers['proficiency'];
  return {
    useCase,
    objective: values[1] ?? '',
    context: values[2] ?? '',
    proficiency,
    teachingPreference: values[4] ?? '',
    autonomyPreference: values[5] ?? '',
  };
}

function normalizeOnboardingAnswer(step: number, value: string): string {
  if (step === 0) {
    const normalized = value.toLowerCase();
    if (normalized === 'dev') return 'development';
    if (normalized === 'development' || normalized === 'data' || normalized === 'product') return normalized;
    throw new Error('Choose development, data, or product.');
  }
  if (step === 3) {
    const normalized = value.toLowerCase();
    if (normalized === 'beginner') return 'novice';
    if (normalized === 'expert') return 'advanced';
    if (normalized === 'novice' || normalized === 'intermediate' || normalized === 'advanced') return normalized;
    throw new Error('Choose novice, intermediate, or advanced.');
  }
  if (!value.trim()) throw new Error('This onboarding answer cannot be empty.');
  return value.trim();
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BANNER_MARK = String.raw`       ╱╲
   ╱╲╱ ⚡ ╲╱╲
   │ ◈  Z  ◈ │
   ╰───┬┬───╯`;

function richText(content: string): string {
  let inFence = false;
  return content.split('\n').map((line) => {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      return chalk.dim(line);
    }
    if (inFence) {
      if (line.startsWith('+') && !line.startsWith('+++')) return chalk.green(line);
      if (line.startsWith('-') && !line.startsWith('---')) return chalk.red(line);
      if (line.startsWith('@@')) return chalk.cyan(line);
      return chalk.gray(line);
    }
    if (/^#{1,6}\s/.test(line)) return chalk.bold.cyan(line.replace(/^#{1,6}\s*/, ''));
    if (/^\s*[-*]\s/.test(line)) return line.replace(/^(\s*)[-*]\s/, `$1${chalk.cyan('•')} `);
    if (/^\s*\d+\.\s/.test(line)) return chalk.white(line);
    if (/^(diff --git|index |--- |\+\+\+ |@@)/.test(line)) return chalk.cyan(line);
    if (line.startsWith('+') && !line.startsWith('+++')) return chalk.green(line);
    if (line.startsWith('-') && !line.startsWith('---')) return chalk.red(line);
    return line.replace(/`([^`]+)`/g, (_match, code: string) => chalk.bgGray.white(` ${code} `));
  }).join('\n');
}

const MessageBlock = memo(function MessageBlock({ item }: { item: TranscriptItem }): React.JSX.Element {
  const color = item.kind === 'user' ? 'cyan' : item.kind === 'review' ? 'magenta' : item.kind === 'system' ? 'yellow' : 'green';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={color}>{item.title}</Text>
      <Text>{richText(item.content)}</Text>
    </Box>
  );
});

function Spinner({ label }: { label: string }): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return <Text color="cyan">{SPINNER_FRAMES[frame]} {label}</Text>;
}

function Composer({ value, cursor, model, cwd, mode }: { value: string; cursor: number; model: ModelProfile; cwd: string; mode: PermissionMode }): React.JSX.Element {
  const characters = Array.from(value);
  const before = characters.slice(0, cursor).join('');
  const current = characters[cursor] ?? ' ';
  const after = characters.slice(cursor + (characters[cursor] ? 1 : 0)).join('');
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={mode === 'yolo' ? 'red' : mode === 'plan' ? 'yellow' : 'cyan'} paddingX={1}>
        <Text>{before}<Text inverse>{current === '\n' ? '↵' : current}</Text>{after}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>{model.label} · {mode} · {basename(cwd)}</Text>
        <Text dimColor>Enter send · Ctrl+J newline · /help</Text>
      </Box>
    </Box>
  );
}

function ModelPicker({ state }: { state: Extract<PickerState, { kind: 'models' }> }): React.JSX.Element {
  const options = useMemo(() => {
    const query = state.query.trim().toLowerCase();
    return MODEL_CATALOG.filter((profile) => !query || `${profile.id} ${profile.label} ${profile.aliases.join(' ')}`.toLowerCase().includes(query));
  }, [state.query]);
  const start = Math.max(0, Math.min(state.index - 5, Math.max(0, options.length - 11)));
  const visible = options.slice(start, start + 11);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>Select model <Text dimColor>filter: {state.query || '—'}</Text></Text>
      {visible.map((profile, offset) => {
        const active = start + offset === state.index;
        return <Text key={profile.id} {...(active ? { color: 'cyan' as const } : {})}>{active ? '❯' : ' '} {profile.label} <Text dimColor>{profile.id}{isConfigured(profile) ? '' : ' · key missing'}</Text></Text>;
      })}
      <Text dimColor>{options.length} matches · type to filter · ↑/↓ · Enter · Esc</Text>
    </Box>
  );
}

function SessionPicker({ state }: { state: Extract<PickerState, { kind: 'sessions' }> }): React.JSX.Element {
  const options = useMemo(() => {
    const query = state.query.trim().toLowerCase();
    return state.sessions.filter((session) => !query || `${session.id} ${session.title} ${session.cwd}`.toLowerCase().includes(query));
  }, [state.query, state.sessions]);
  const start = Math.max(0, Math.min(state.index - 5, Math.max(0, options.length - 11)));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>Resume session <Text dimColor>filter: {state.query || '—'}</Text></Text>
      {options.slice(start, start + 11).map((session, offset) => {
        const active = start + offset === state.index;
        return <Text key={session.id} {...(active ? { color: 'cyan' as const } : {})}>{active ? '❯' : ' '} {session.title} <Text dimColor>{session.id.slice(0, 8)} · {basename(session.cwd)}</Text></Text>;
      })}
      <Text dimColor>{options.length} matches · type to filter · ↑/↓ · Enter · Esc</Text>
    </Box>
  );
}

function reviewText(review: ReviewResult): string {
  const lines = [`VERDICT: ${review.verdict}`, `Reviewer: ${review.reviewerModelId}`, review.summary];
  for (const finding of review.findings) {
    const location = finding.file ? ` — ${finding.file}${finding.line ? `:${finding.line}` : ''}` : '';
    lines.push(`- [${finding.severity.toUpperCase()}] ${finding.title}${location}\n  ${finding.detail}`);
  }
  return lines.join('\n');
}

function helpText(): string {
  return `
# ZeuZ-Agent commands

/model [id]          Pick or switch model (compacts context first)
/ask <model> <task>  Explicitly delegate to a subagent
/subagents           Show the evidence-based routing policy
/tasks               Show recent delegated tasks
/plan [task]         Enter plan mode; optionally run a task
/permissions [mode]  Show/set plan, agent, or yolo
/status              Session, model, workspace, Git, and context state
/health [--deep]     Check CLIs; deep also calls every NVIDIA model
/diff                Render staged, unstaged, and untracked changes
/review              Run an adversarial read-only review now
/compact             Compact shared cross-model context
/new                 Start a new session in the current workspace
/resume [id]         Pick or resume a saved session
/clear               Start a clean session and clear the composer
/copy                Copy the last assistant response
/fork [title]        Fork from compacted shared context
/branch [name]       List branches or switch/create one
/cd [path]           Show or change the active workspace
/user [name]         Show or select the active local user profile
/onboard             Restart onboarding for the active workspace
/bootstrap           Show files loaded before every model turn
/skills              List the repository skill pantheon
/help                Show this help
/exit                Exit ZeuZ-Agent
`.trim();
}

export function App({ controller }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [items, setItems] = useState<TranscriptItem[]>(() => [{
    id: randomUUID(),
    kind: 'system',
    title: 'ZeuZ - Seu orquestrador de agentes',
    content: `${BANNER_MARK}\nOne terminal, many agents.\nPrimary: ${controller.activeModel().label}\nWorkspace: ${controller.session.cwd}\nUser: ${controller.bootstrap.userSlug}${controller.onboardingRequired() ? `\n\nFirst-time setup\n${ONBOARDING_QUESTIONS[0]}` : ''}`,
  }]);
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('Ready');
  const [liveText, setLiveText] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [picker, setPicker] = useState<PickerState>();
  const [renderTick, setRenderTick] = useState(0);
  const [onboarding, setOnboarding] = useState<OnboardingState | undefined>(() => controller.onboardingRequired() ? { step: 0, values: [] } : undefined);
  const lastAssistant = useRef('');

  const addItem = useCallback((kind: TranscriptItem['kind'], title: string, content: string) => {
    setItems((current) => [...current, { id: randomUUID(), kind, title, content }]);
  }, []);

  const eventSink = useCallback((event: AgentEvent) => {
    if (event.type === 'delta') setLiveText((current) => current + event.text);
    if (event.type === 'status') setActivity(event.text);
    if (event.type === 'tool') setActivity(`${event.status === 'completed' ? '✓' : event.status === 'failed' ? '✗' : '↳'} ${event.text}`);
    if (event.type === 'diff') setActivity(`Δ ${event.text}`);
    if (event.type === 'warning') addItem('system', 'Warning', event.text);
    if (event.type === 'error') addItem('system', 'Error', event.text);
  }, [addItem]);

  const runCommand = useCallback(async (line: string): Promise<void> => {
    return await dispatchCommand(line, async ({ name: lower, argument, requestedName: command }) => {

    if (lower === 'exit') {
      exit();
      return;
    }
    if (lower === 'help') return addItem('system', 'Help', helpText());
    if (lower === 'status') return addItem('system', 'Status', controller.status());
    if (lower === 'bootstrap') return addItem('system', 'Bootstrap', controller.bootstrapStatus());
    if (lower === 'skills') return addItem('system', 'Skills', await controller.skillStatus());
    if (lower === 'diff') return addItem('system', 'Git diff', controller.diff());
    if (lower === 'cd' && !argument) return addItem('system', 'Workspace', controller.session.cwd);
    if (lower === 'branch' && !argument) return addItem('system', 'Branches', controller.branches());
    if (lower === 'subagents') return addItem('system', 'Subagent routing', `${ROUTING_GUIDE}\n\nDepth: 1 · concurrency: 3 · adversarial review: mandatory`);
    if (lower === 'copy') {
      if (!lastAssistant.current) return addItem('system', 'Copy', 'No assistant response is available.');
      const copied = spawnSync('pbcopy', { input: lastAssistant.current, encoding: 'utf8' });
      return addItem('system', 'Copy', copied.status === 0 ? 'Last assistant response copied.' : 'pbcopy failed.');
    }
    if (lower === 'model' && !argument) {
      setPicker({ kind: 'models', query: '', index: 0 });
      return;
    }
    if (lower === 'resume' && !argument) {
      const sessions = await controller.listSessions();
      setPicker({ kind: 'sessions', query: '', index: 0, sessions });
      return;
    }
    if (lower === 'tasks') {
      const tasks = await new TaskStore().list();
      const content = tasks.length === 0 ? 'No delegated tasks yet.' : tasks.map((task) => `${task.status.toUpperCase().padEnd(9)} ${task.modelId} · ${task.id.slice(0, 8)}\n${task.prompt.slice(0, 160)}`).join('\n\n');
      return addItem('system', 'Tasks', content);
    }
    if (lower === 'model') return addItem('system', 'Model', await controller.switchModel(argument, eventSink));
    if (lower === 'compact') return addItem('system', 'Shared context compacted', await controller.compact(eventSink));
    if (lower === 'cd') {
      const message = await controller.changeDirectory(argument, eventSink);
      addItem('system', 'Workspace', message);
      if (controller.onboardingRequired()) {
        setOnboarding({ step: 0, values: [] });
        addItem('system', 'First-time setup', ONBOARDING_QUESTIONS[0]);
      } else setOnboarding(undefined);
      return;
    }
    if (lower === 'user') {
      const message = await controller.selectUser(argument || undefined);
      addItem('system', 'User', message);
      if (controller.onboardingRequired()) {
        setOnboarding({ step: 0, values: [] });
        addItem('system', 'First-time setup', ONBOARDING_QUESTIONS[0]);
      } else setOnboarding(undefined);
      return;
    }
    if (lower === 'onboard') {
      setOnboarding({ step: 0, values: [] });
      addItem('system', 'First-time setup', ONBOARDING_QUESTIONS[0]);
      return;
    }
    if (lower === 'branch') return addItem('system', 'Git branch', await controller.branch(argument));
    if (lower === 'fork') {
      const session = await controller.fork(argument || undefined, eventSink);
      setRenderTick((tick) => tick + 1);
      return addItem('system', 'Session forked', `${session.title}\n${session.id}`);
    }
    if (lower === 'new' || lower === 'clear') {
      const session = await controller.newSession();
      setValue('');
      setCursor(0);
      setRenderTick((tick) => tick + 1);
      return addItem('system', 'New session', `${session.title}\n${session.id}`);
    }
    if (lower === 'resume') {
      const session = await controller.resume(argument);
      setRenderTick((tick) => tick + 1);
      return addItem('system', 'Session resumed', `${session.title}\n${session.id}`);
    }
    if (lower === 'permissions') {
      if (!argument) return addItem('system', 'Permissions', controller.session.permissionMode);
      if (!['plan', 'agent', 'yolo'].includes(argument)) throw new Error('Usage: /permissions plan|agent|yolo');
      return addItem('system', 'Permissions', await controller.setPermission(argument as PermissionMode));
    }
    if (lower === 'plan') {
      await controller.setPermission('plan');
      setRenderTick((tick) => tick + 1);
      if (!argument) return addItem('system', 'Permissions', 'Permission mode: plan.');
      const outcome = await controller.send(argument, eventSink);
      lastAssistant.current = outcome.response;
      addItem('assistant', controller.activeModel().label, outcome.response);
      if (outcome.review) addItem('review', 'Adversarial review', reviewText(outcome.review));
      return;
    }
    if (lower === 'health') return addItem('system', 'Health', await controller.health(argument === '--deep' || argument === 'deep', eventSink));
    if (lower === 'review') {
      const review = await controller.explicitReview(eventSink);
      return addItem('review', 'Adversarial review', reviewText(review));
    }
    if (lower === 'ask') {
      const space = argument.indexOf(' ');
      if (space < 1) throw new Error('Usage: /ask <model> <task>');
      const modelQuery = argument.slice(0, space);
      const task = argument.slice(space + 1).trim();
      const outcome = await controller.ask(modelQuery, task, eventSink);
      lastAssistant.current = outcome.response;
      addItem('assistant', `Subagent · ${outcome.modelId}`, outcome.response);
      if (outcome.review) addItem('review', 'Adversarial review', reviewText(outcome.review));
      return;
    }
      throw new Error(`Unknown command: /${command}. Use /help.`);
    });
  }, [addItem, controller, eventSink, exit]);

  const submit = useCallback(async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setActivity('Starting');
    setLiveText('');
    setHistory((current) => [...current.filter((entry) => entry !== trimmed), trimmed].slice(-100));
    setHistoryIndex(-1);
    setValue('');
    setCursor(0);
    addItem('user', 'You', trimmed);
    try {
      if (trimmed.startsWith('/')) {
        await runCommand(trimmed);
      } else if (onboarding) {
        const answer = normalizeOnboardingAnswer(onboarding.step, trimmed);
        const values = [...onboarding.values];
        values[onboarding.step] = answer;
        const nextStep = onboarding.step + 1;
        if (nextStep < ONBOARDING_QUESTIONS.length) {
          setOnboarding({ step: nextStep, values });
          addItem('system', `Setup ${nextStep + 1}/${ONBOARDING_QUESTIONS.length}`, ONBOARDING_QUESTIONS[nextStep] ?? '');
        } else {
          const message = await controller.completeOnboarding(onboardingAnswers(values));
          setOnboarding(undefined);
          addItem('system', 'Onboarding complete', message);
        }
      } else {
        const outcome = await controller.send(trimmed, eventSink);
        lastAssistant.current = outcome.response;
        addItem('assistant', controller.activeModel().label, outcome.response);
        if (outcome.review) addItem('review', 'Adversarial review', reviewText(outcome.review));
      }
    } catch (error) {
      addItem('system', 'Error', error instanceof Error ? error.message : String(error));
    } finally {
      setLiveText('');
      setActivity('Ready');
      setBusy(false);
      setRenderTick((tick) => tick + 1);
    }
  }, [addItem, busy, controller, eventSink, onboarding, runCommand]);

  const pickerOptions = useMemo(() => {
    if (!picker) return [];
    const query = picker.query.trim().toLowerCase();
    if (picker.kind === 'models') return MODEL_CATALOG.filter((profile) => !query || `${profile.id} ${profile.label} ${profile.aliases.join(' ')}`.toLowerCase().includes(query));
    return picker.sessions.filter((session) => !query || `${session.id} ${session.title} ${session.cwd}`.toLowerCase().includes(query));
  }, [picker]);

  useInput((input, key) => {
    if (picker) {
      if (key.escape) return setPicker(undefined);
      if (key.upArrow) return setPicker({ ...picker, index: Math.max(0, picker.index - 1) });
      if (key.downArrow) return setPicker({ ...picker, index: Math.min(Math.max(0, pickerOptions.length - 1), picker.index + 1) });
      if (key.backspace || key.delete) return setPicker({ ...picker, query: picker.query.slice(0, -1), index: 0 });
      if (key.return) {
        const selected = pickerOptions[picker.index];
        if (!selected) return;
        setPicker(undefined);
        setBusy(true);
        setActivity(picker.kind === 'models' ? 'Switching model and compacting context' : 'Resuming session');
        const operation = picker.kind === 'models'
          ? controller.switchModel((selected as ModelProfile).id, eventSink)
          : controller.resume((selected as ZeuzSession).id).then((session) => `Session resumed: ${session.title} (${session.id})`);
        void operation.then((message) => addItem('system', picker.kind === 'models' ? 'Model' : 'Session', message)).catch((error: unknown) => addItem('system', 'Error', error instanceof Error ? error.message : String(error))).finally(() => {
          setBusy(false);
          setActivity('Ready');
          setRenderTick((tick) => tick + 1);
        });
        return;
      }
      if (input && !key.ctrl && !key.meta) setPicker({ ...picker, query: picker.query + input, index: 0 });
      return;
    }

    if (busy) return;
    const characters = Array.from(value);
    if (key.ctrl && input === 'c') {
      if (value) {
        setValue('');
        setCursor(0);
      } else exit();
      return;
    }
    if (key.return) {
      if (key.shift || key.ctrl) {
        characters.splice(cursor, 0, '\n');
        setValue(characters.join(''));
        setCursor(cursor + 1);
      } else void submit(value);
      return;
    }
    if (key.leftArrow) return setCursor(Math.max(0, cursor - 1));
    if (key.rightArrow) return setCursor(Math.min(characters.length, cursor + 1));
    if (key.upArrow && !value.includes('\n')) {
      const next = Math.min(history.length - 1, historyIndex + 1);
      if (next >= 0) {
        const entry = history[history.length - 1 - next] ?? '';
        setHistoryIndex(next);
        setValue(entry);
        setCursor(Array.from(entry).length);
      }
      return;
    }
    if (key.downArrow && !value.includes('\n')) {
      const next = historyIndex - 1;
      const entry = next >= 0 ? (history[history.length - 1 - next] ?? '') : '';
      setHistoryIndex(next);
      setValue(entry);
      setCursor(Array.from(entry).length);
      return;
    }
    if (key.backspace) {
      if (cursor > 0) characters.splice(cursor - 1, 1);
      setValue(characters.join(''));
      setCursor(Math.max(0, cursor - 1));
      return;
    }
    if (key.delete) {
      characters.splice(cursor, 1);
      setValue(characters.join(''));
      return;
    }
    if (key.ctrl && input === 'a') return setCursor(0);
    if (key.ctrl && input === 'e') return setCursor(characters.length);
    if (key.ctrl && input === 'u') {
      characters.splice(0, cursor);
      setValue(characters.join(''));
      setCursor(0);
      return;
    }
    if (key.ctrl && input === 'k') {
      characters.splice(cursor);
      setValue(characters.join(''));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const inserted = Array.from(input);
      characters.splice(cursor, 0, ...inserted);
      setValue(characters.join(''));
      setCursor(cursor + inserted.length);
    }
  });

  const model = controller.activeModel();
  void renderTick;

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => <MessageBlock key={item.id} item={item} />}</Static>
      {liveText ? <Box flexDirection="column" marginBottom={1}><Text bold color="green">{model.label}</Text><Text>{liveText}</Text></Box> : null}
      {busy ? <Spinner label={activity} /> : null}
      {picker?.kind === 'models' ? <ModelPicker state={picker} /> : null}
      {picker?.kind === 'sessions' ? <SessionPicker state={picker} /> : null}
      {!busy && !picker ? <Composer value={value} cursor={cursor} model={model} cwd={controller.session.cwd} mode={controller.session.permissionMode} /> : null}
    </Box>
  );
}
