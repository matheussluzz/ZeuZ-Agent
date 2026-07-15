import type { ModelProfile, ProviderId } from './types.js';

export const DEFAULT_MODEL_ID = 'codex:gpt-5.6-sol@medium';

const codexModels: ModelProfile[] = [
  {
    slug: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    family: 'GPT-5.6 Sol',
    description: 'Frontier primary agent for ambiguous, complex, repository-scale work.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    slug: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    family: 'GPT-5.6 Terra',
    description: 'Balanced architecture, implementation, and adversarial analysis.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    slug: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    family: 'GPT-5.6 Luna',
    description: 'Fast scoped implementation, triage, and verification.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
].flatMap(({ slug, label, family, description, efforts }) =>
  efforts.map((effort) => ({
    id: `codex:${slug}@${effort}`,
    provider: 'codex' as const,
    model: slug,
    label: `${label} · ${effort}`,
    family,
    description,
    reasoningEffort: effort,
    aliases: [
      `${slug}@${effort}`,
      `${slug}-${effort}`,
      `${slug.replace('gpt-5.6-', '')}-${effort}`,
      ...(effort === 'medium' ? [slug, slug.replace('gpt-5.6-', '')] : []),
    ],
  })),
);

const cursorEntries = [
  ['composer-2.5', 'Composer 2.5', 'Cursor Composer', 'Fast repository-native implementation and routine refactors.'],
  ['composer-2.5-fast', 'Composer 2.5 Fast', 'Cursor Composer', 'Lowest-latency repository-native implementation.'],
  ['cursor-grok-4.5-low', 'Grok 4.5 · low', 'Cursor Grok', 'Fast blunt triage and unconventional second opinions.'],
  ['cursor-grok-4.5-low-fast', 'Grok 4.5 · low fast', 'Cursor Grok', 'Very fast triage and exploration.'],
  ['cursor-grok-4.5-medium', 'Grok 4.5 · medium', 'Cursor Grok', 'Opinionated debugging and pragmatic implementation.'],
  ['cursor-grok-4.5-medium-fast', 'Grok 4.5 · medium fast', 'Cursor Grok', 'Fast debugging and pragmatic implementation.'],
  ['cursor-grok-4.5-high', 'Grok 4.5 · high', 'Cursor Grok', 'Adversarial ideation, debugging, and architecture alternatives.'],
  ['cursor-grok-4.5-high-fast', 'Grok 4.5 · high fast', 'Cursor Grok', 'Fast adversarial ideation and debugging.'],
  ['claude-fable-5-low', 'Fable 5 · low', 'Cursor Fable', 'Careful multi-file work at lower reasoning depth.'],
  ['claude-fable-5-medium', 'Fable 5 · medium', 'Cursor Fable', 'Careful multi-file implementation and debugging.'],
  ['claude-fable-5-high', 'Fable 5 · high', 'Cursor Fable', 'Deep multi-file implementation and review.'],
  ['claude-fable-5-xhigh', 'Fable 5 · xhigh', 'Cursor Fable', 'Deep long-horizon implementation and review.'],
  ['claude-fable-5-max', 'Fable 5 · max', 'Cursor Fable', 'Maximum-depth multi-file implementation and review.'],
  ['claude-fable-5-thinking-low', 'Fable 5 Thinking · low', 'Cursor Fable', 'Explicit reasoning for bounded refactors.'],
  ['claude-fable-5-thinking-medium', 'Fable 5 Thinking · medium', 'Cursor Fable', 'Explicit reasoning for debugging and refactors.'],
  ['claude-fable-5-thinking-high', 'Fable 5 Thinking · high', 'Cursor Fable', 'Strong evidence-led debugging and adversarial review.'],
  ['claude-fable-5-thinking-xhigh', 'Fable 5 Thinking · xhigh', 'Cursor Fable', 'Very deep evidence-led debugging and review.'],
  ['claude-fable-5-thinking-max', 'Fable 5 Thinking · max', 'Cursor Fable', 'Maximum-depth evidence-led debugging and review.'],
] as const;

const cursorModels: ModelProfile[] = cursorEntries.map(([model, label, family, description]) => ({
  id: `cursor:${model}`,
  provider: 'cursor',
  model,
  label,
  family,
  description,
  aliases: [model, model.replace(/^cursor-/, ''), ...(model === 'composer-2.5' ? ['composer'] : []), ...(model === 'cursor-grok-4.5-high' ? ['grok'] : []), ...(model === 'claude-fable-5-thinking-high' ? ['fable'] : [])],
}));

const claudeEntries = [
  ['fable', 'fable', 'Claude Fable 5', 'Claude Fable', 'Primary fallback for the hardest, longest-running tasks through Claude Code.'],
  ['claude-opus-4-8', 'opus', 'Claude Opus 4.8', 'Claude Opus', 'Complex reasoning, architecture, and demanding execution.'],
  ['claude-sonnet-5', 'sonnet', 'Claude Sonnet 5', 'Claude Sonnet', 'Medium-complexity implementation, orchestration, and careful review.'],
  ['claude-haiku-4-5', 'haiku', 'Claude Haiku 4.5', 'Claude Haiku', 'Fast bounded execution and lightweight verification.'],
] as const;

const claudeModels: ModelProfile[] = claudeEntries.map(([slug, model, label, family, description]) => ({
  id: `claude:${slug}`,
  provider: 'claude',
  model,
  label,
  family,
  description,
  aliases: [
    `claude-${slug}`,
    `${slug}-claude`,
    ...(slug === 'fable' ? ['claude-fable', 'fable-claude'] : []),
    ...(slug === 'claude-opus-4-8' ? ['opus-4.8'] : []),
    ...(slug === 'claude-sonnet-5' ? ['claude-sonnet', 'sonnet-5-claude'] : []),
    ...(slug === 'claude-haiku-4-5' ? ['claude-haiku', 'haiku-claude'] : []),
  ],
}));

const copilotEntries = [
  ['claude-sonnet-5', 'Claude Sonnet 5', 'Default careful implementation, orchestration, and adversarial review.'],
  ['claude-sonnet-4.6', 'Claude Sonnet 4.6', 'Architecture, complex refactors, and nuanced tradeoff analysis.'],
  ['claude-sonnet-4.5', 'Claude Sonnet 4.5', 'Debugging, legacy work, and maintainability review.'],
  ['claude-haiku-4.5', 'Claude Haiku 4.5', 'Fast bounded execution and lightweight review.'],
] as const;

const copilotModels: ModelProfile[] = copilotEntries.map(([model, label, description]) => ({
  id: `copilot:${model}`,
  provider: 'copilot',
  model,
  label,
  family: model.includes('haiku') ? 'Claude Haiku' : 'Claude Sonnet',
  description,
  aliases: [model, model.replace('claude-', ''), ...(model === 'claude-sonnet-5' ? ['sonnet', 'sonnet5', 'claude'] : [])],
}));

const agyModels: ModelProfile[] = ['Low', 'Medium', 'High'].map((effort) => ({
  id: `agy:gemini-3.5-flash@${effort.toLowerCase()}`,
  provider: 'agy',
  model: `Gemini 3.5 Flash (${effort})`,
  label: `Gemini 3.5 Flash · ${effort.toLowerCase()}`,
  family: 'Gemini 3.5 Flash',
  description: effort === 'High' ? 'Fast higher-effort prototyping, tests, and code navigation.' : 'Low-latency scoped edits, tests, and code exploration.',
  aliases: [`gemini-${effort.toLowerCase()}`, `gemini-3.5-${effort.toLowerCase()}`, ...(effort === 'Medium' ? ['gemini', 'agy'] : [])],
}));

const nvidiaEntries = [
  ['glm-5.2', 'GLM 5.2', 'z-ai/glm-5.2', 'NVIDIA_API_KEY_GLM_52', 'NVIDIA_MODEL_GLM_52', 'Structured transformations, boilerplate, and utility work.'],
  ['deepseek-v4', 'DeepSeek V4 Pro', 'deepseek-ai/deepseek-v4-pro', 'NVIDIA_API_KEY_DEEPSEEK_V4', 'NVIDIA_MODEL_DEEPSEEK_V4', 'Long-context analysis, architecture, and thorough code generation.'],
  ['kimi-k2.6', 'Kimi K2.6', 'moonshotai/kimi-k2.6', 'NVIDIA_API_KEY_KIMI_26', 'NVIDIA_MODEL_KIMI_26', 'Long-context coding when the configured NVIDIA endpoint is healthy.'],
  ['minimax-m3', 'MiniMax M3', 'minimaxai/minimax-m3', 'NVIDIA_API_KEY_MINIMAX_M3', 'NVIDIA_MODEL_MINIMAX_M3', 'Scoped backend implementation, SQL, debugging, and technical drafts.'],
  ['qwen-3.5', 'Qwen 3.5 397B', 'qwen/qwen3.5-397b-a17b', 'NVIDIA_API_KEY_QWEN', 'NVIDIA_MODEL_QWEN', 'Documentation synthesis, tests, boilerplate, and architectural brainstorming.'],
] as const;

const nvidiaModels: ModelProfile[] = nvidiaEntries.map(([slug, label, model, apiKeyEnv, modelEnv, description]) => ({
  id: `nvidia:${slug}`,
  provider: 'nvidia',
  model,
  label,
  family: label,
  description,
  apiKeyEnv,
  modelEnv,
  defaultApiModel: model,
  aliases: [slug, label.toLowerCase(), slug.split('-')[0] ?? slug],
}));

export const MODEL_CATALOG: readonly ModelProfile[] = [
  ...codexModels,
  ...cursorModels,
  ...claudeModels,
  ...copilotModels,
  ...agyModels,
  ...nvidiaModels,
];

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export function resolveModel(query: string): ModelProfile | undefined {
  const wanted = normalize(query);
  const exact = MODEL_CATALOG.find((profile) =>
    [profile.id, profile.model, profile.label, ...profile.aliases].some((candidate) => normalize(candidate) === wanted),
  );
  if (exact) return exact;

  const partial = MODEL_CATALOG.filter((profile) =>
    [profile.id, profile.model, profile.label, ...profile.aliases].some((candidate) => normalize(candidate).includes(wanted)),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

export function requireModel(query: string): ModelProfile {
  const model = resolveModel(query);
  if (!model) throw new Error(`Unknown or ambiguous model: ${query}`);
  return model;
}

export function modelsByProvider(): Map<ProviderId, ModelProfile[]> {
  const groups = new Map<ProviderId, ModelProfile[]>();
  for (const profile of MODEL_CATALOG) {
    const group = groups.get(profile.provider) ?? [];
    group.push(profile);
    groups.set(profile.provider, group);
  }
  return groups;
}

export function isConfigured(profile: ModelProfile): boolean {
  if (profile.provider !== 'nvidia') return true;
  if (!profile.apiKeyEnv) return false;
  const value = process.env[profile.apiKeyEnv];
  return Boolean(value && !value.startsWith('nvapi-your-'));
}
