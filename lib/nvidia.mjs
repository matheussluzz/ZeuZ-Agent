const PLACEHOLDER = 'nvapi-your-key-here';
const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export const NVIDIA_MODELS = {
  glm_52: {
    id: 'glm_52',
    label: 'GLM 5.2',
    aliases: ['glm', 'glm52', 'glm-5.2', 'glm_5.2'],
    apiKeyEnv: 'NVIDIA_API_KEY_GLM_52',
    modelEnv: 'NVIDIA_MODEL_GLM_52',
    defaultModel: 'z-ai/glm-5.2',
    stream: true,
    temperature: 1,
    top_p: 1,
    max_tokens: 4096,
    seed: 42,
    healthMaxTokens: 32,
  },
  deepseek_v4: {
    id: 'deepseek_v4',
    label: 'DeepSeek V4 Pro',
    aliases: ['deepseek', 'deepseek-v4', 'deepseek_v4_pro'],
    apiKeyEnv: 'NVIDIA_API_KEY_DEEPSEEK_V4',
    modelEnv: 'NVIDIA_MODEL_DEEPSEEK_V4',
    defaultModel: 'deepseek-ai/deepseek-v4-pro',
    stream: false,
    temperature: 1,
    top_p: 0.95,
    max_tokens: 16384,
    chat_template_kwargs: { thinking: false },
    healthMaxTokens: 32,
  },
  kimi_26: {
    id: 'kimi_26',
    label: 'Kimi K2.6',
    aliases: ['kimi', 'kimi26', 'kimi-k2.6', 'kimi_2.6'],
    apiKeyEnv: 'NVIDIA_API_KEY_KIMI_26',
    modelEnv: 'NVIDIA_MODEL_KIMI_26',
    defaultModel: 'moonshotai/kimi-k2.6',
    stream: false,
    temperature: 1,
    top_p: 1,
    max_tokens: 16384,
    healthMaxTokens: 32,
  },
  minimax_m3: {
    id: 'minimax_m3',
    label: 'MiniMax M3',
    aliases: ['minimax', 'minimax-m3', 'm3'],
    apiKeyEnv: 'NVIDIA_API_KEY_MINIMAX_M3',
    modelEnv: 'NVIDIA_MODEL_MINIMAX_M3',
    defaultModel: 'minimaxai/minimax-m3',
    stream: false,
    temperature: 1,
    top_p: 0.95,
    max_tokens: 8192,
    healthMaxTokens: 32,
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen 3.5 397B',
    aliases: ['qwen3', 'qwen-3.5', 'qwen3.5'],
    apiKeyEnv: 'NVIDIA_API_KEY_QWEN',
    modelEnv: 'NVIDIA_MODEL_QWEN',
    defaultModel: 'qwen/qwen3.5-397b-a17b',
    stream: false,
    temperature: 0.6,
    top_p: 0.95,
    top_k: 20,
    presence_penalty: 0,
    repetition_penalty: 1,
    max_tokens: 16384,
    healthMaxTokens: 32,
  },
};

export const DEFAULT_MODEL_ID = 'glm_52';

export function getBaseUrl() {
  return (process.env.NVIDIA_API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

export function listConfiguredModels() {
  return Object.values(NVIDIA_MODELS).filter((profile) => {
    const apiKey = process.env[profile.apiKeyEnv];
    return apiKey && apiKey !== PLACEHOLDER;
  });
}

export function resolveModelId(input) {
  if (!input) return null;

  const normalized = input.trim().toLowerCase();
  if (NVIDIA_MODELS[normalized]) return normalized;

  for (const profile of Object.values(NVIDIA_MODELS)) {
    if (profile.aliases.includes(normalized)) return profile.id;
    if (profile.label.toLowerCase() === normalized) return profile.id;
    if (profile.defaultModel.toLowerCase() === normalized) return profile.id;
  }

  return null;
}

export function resolveModelConfig(id) {
  const profile = NVIDIA_MODELS[id];
  if (!profile) {
    throw new Error(`Modelo desconhecido: ${id}`);
  }

  const apiKey = process.env[profile.apiKeyEnv];
  const model = process.env[profile.modelEnv] ?? profile.defaultModel;

  if (!apiKey || apiKey === PLACEHOLDER) {
    throw new Error(`Chave ausente: defina ${profile.apiKeyEnv} no .env`);
  }

  return { ...profile, apiKey, model };
}

export function buildBody(profile, prompt, { maxTokens } = {}) {
  const body = {
    model: profile.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: profile.temperature,
    top_p: profile.top_p,
    max_tokens: maxTokens ?? profile.max_tokens,
    stream: profile.stream,
  };

  if (profile.seed !== undefined) body.seed = profile.seed;
  if (profile.top_k !== undefined) body.top_k = profile.top_k;
  if (profile.presence_penalty !== undefined) body.presence_penalty = profile.presence_penalty;
  if (profile.repetition_penalty !== undefined) body.repetition_penalty = profile.repetition_penalty;
  if (profile.chat_template_kwargs) body.chat_template_kwargs = profile.chat_template_kwargs;

  return body;
}

async function readStream(response) {
  let output = '';
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) output += content;
      } catch {
        // ignora linhas parciais
      }
    }
  }

  return output;
}

export async function chatCompletion(profile, promptOrMessages, options = {}) {
  const messages = Array.isArray(promptOrMessages)
    ? promptOrMessages
    : [{ role: 'user', content: promptOrMessages }];

  const response = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
      Accept: profile.stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify({
      ...buildBody(profile, messages.at(-1)?.content ?? '', options),
      messages,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorBody}`);
  }

  if (!profile.stream) {
    const json = await response.json();
    return json.choices?.[0]?.message?.content ?? '';
  }

  if (!response.body) {
    throw new Error('Streaming indisponível');
  }

  return readStream(response);
}

export async function healthCheck(profile, { timeoutMs = 45000, signal } = {}) {
  const started = Date.now();

  try {
    const content = await chatCompletion(
      profile,
      'Responda apenas: ok',
      { maxTokens: profile.healthMaxTokens, signal },
    );

    return {
      id: profile.id,
      label: profile.label,
      model: profile.model,
      ok: Boolean(content?.trim()),
      latencyMs: Date.now() - started,
      preview: content?.trim().slice(0, 40) ?? '',
    };
  } catch (error) {
    return {
      id: profile.id,
      label: profile.label,
      model: profile.model,
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runHealthChecks(models = listConfiguredModels()) {
  const results = await Promise.all(
    models.map(async (profile) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);

      try {
        const config = resolveModelConfig(profile.id);
        return await healthCheck(config, { signal: controller.signal });
      } catch (error) {
        return {
          id: profile.id,
          label: profile.label,
          model: profile.defaultModel,
          ok: false,
          latencyMs: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return results;
}
