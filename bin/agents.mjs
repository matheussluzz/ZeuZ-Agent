#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  DEFAULT_MODEL_ID,
  NVIDIA_MODELS,
  buildBody,
  chatCompletion,
  getBaseUrl,
  listConfiguredModels,
  resolveModelConfig,
  resolveModelId,
  runHealthChecks,
} from '../lib/nvidia.mjs';

const healthOnly = process.argv.includes('--health-only');

function printHelp(currentId) {
  const current = NVIDIA_MODELS[currentId];
  output.write('\nComandos:\n');
  output.write('  /model              lista modelos e mostra o ativo\n');
  output.write('  /model <id>         troca de modelo (ex: /model glm_52, /model deepseek)\n');
  output.write('  /health             roda health check de novo\n');
  output.write('  /clear              limpa histórico da conversa\n');
  output.write('  /help               mostra esta ajuda\n');
  output.write('  /quit ou /exit      sai\n');
  output.write(`\nModelo ativo: ${current.label} (${current.id})\n\n`);
}

function printModelList(currentId, healthById = new Map()) {
  output.write('\nModelos disponíveis:\n');
  for (const profile of Object.values(NVIDIA_MODELS)) {
    const marker = profile.id === currentId ? '→' : ' ';
    const health = healthById.get(profile.id);
    const status = health ? (health.ok ? '✅' : '❌') : '·';
    output.write(
      `  ${marker} ${status} ${profile.id.padEnd(14)} ${profile.label}  (${profile.defaultModel})\n`,
    );
  }
  output.write('\nTroque com: /model <id>  (ex: /model kimi_26)\n\n');
}

function printHealthReport(results) {
  output.write('\nHealth check NVIDIA Integrate API\n');
  output.write('─'.repeat(56) + '\n');

  for (const result of results) {
    const status = result.ok ? '✅ OK' : '❌ FAIL';
    const latency = result.latencyMs ? `${result.latencyMs}ms` : '—';
    output.write(`${status.padEnd(8)} ${result.label.padEnd(18)} ${latency.padStart(7)}  ${result.model}\n`);
    if (!result.ok && result.error) {
      const short = result.error.replace(/\s+/g, ' ').slice(0, 100);
      output.write(`         ↳ ${short}\n`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  output.write('─'.repeat(56) + '\n');
  output.write(`${okCount}/${results.length} modelos respondendo\n\n`);
}

async function bootstrap() {
  const configured = listConfiguredModels();

  if (configured.length === 0) {
    throw new Error('Nenhuma chave NVIDIA configurada. Copie .env.example para .env e preencha as keys.');
  }

  output.write('agents — terminal NVIDIA LLM\n');
  output.write('Bootstrap: health check...\n');

  const health = await runHealthChecks(configured);
  printHealthReport(health);

  const healthById = new Map(health.map((item) => [item.id, item]));
  let currentId = DEFAULT_MODEL_ID;

  if (!resolveModelId(currentId) || !process.env[NVIDIA_MODELS[currentId].apiKeyEnv]) {
    currentId = configured[0].id;
  }

  const defaultHealth = healthById.get(currentId);
  if (defaultHealth && !defaultHealth.ok) {
    const firstOk = health.find((item) => item.ok);
    if (firstOk) {
      output.write(`Aviso: ${NVIDIA_MODELS[DEFAULT_MODEL_ID].label} indisponível; usando ${firstOk.label}.\n`);
      currentId = firstOk.id;
    }
  }

  if (healthOnly) {
    process.exit(health.some((item) => item.ok) ? 0 : 1);
  }

  const current = NVIDIA_MODELS[currentId];
  output.write(`Modelo padrão: ${current.label} (${current.id})\n`);
  output.write('Digite /help para comandos. Comece a conversar ou use /model para trocar.\n\n');

  return { currentId, healthById, messages: [] };
}

async function handleSlashCommand(line, state) {
  const [command, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (command.toLowerCase()) {
    case 'help':
      printHelp(state.currentId);
      return state;

    case 'quit':
    case 'exit':
      output.write('Até logo.\n');
      process.exit(0);

    case 'clear':
      state.messages = [];
      output.write('Histórico limpo.\n\n');
      return state;

    case 'health': {
      const configured = listConfiguredModels();
      const health = await runHealthChecks(configured);
      printHealthReport(health);
      state.healthById = new Map(health.map((item) => [item.id, item]));
      return state;
    }

    case 'model':
      if (!arg) {
        printModelList(state.currentId, state.healthById);
        return state;
      }

      {
        const nextId = resolveModelId(arg);
        if (!nextId) {
          output.write(`Modelo não encontrado: ${arg}\n`);
          printModelList(state.currentId, state.healthById);
          return state;
        }

        try {
          resolveModelConfig(nextId);
        } catch (error) {
          output.write(`${error.message}\n`);
          return state;
        }

        state.currentId = nextId;
        const profile = NVIDIA_MODELS[nextId];
        const health = state.healthById.get(nextId);
        const healthNote = health ? (health.ok ? '✅' : '❌') : '';
        output.write(`Modelo ativo: ${profile.label} (${profile.id}) ${healthNote}\n\n`);
        return state;
      }

    default:
      output.write(`Comando desconhecido: /${command}. Use /help.\n\n`);
      return state;
  }
}

async function sendMessage(state, userText) {
  const profile = resolveModelConfig(state.currentId);
  state.messages.push({ role: 'user', content: userText });

  output.write(`\n${profile.label}: `);

  try {
    if (profile.stream) {
      const response = await fetch(`${getBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${profile.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          ...buildBody(profile, userText, {}),
          messages: state.messages,
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }

      let assistantText = '';
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
            if (content) {
              assistantText += content;
              output.write(content);
            }
          } catch {
            // ignora
          }
        }
      }

      output.write('\n\n');
      state.messages.push({ role: 'assistant', content: assistantText });
      return state;
    }

    const content = await chatCompletion(profile, state.messages);
    output.write(`${content}\n\n`);
    state.messages.push({ role: 'assistant', content });
    return state;
  } catch (error) {
    state.messages.pop();
    output.write(`\nErro: ${error instanceof Error ? error.message : String(error)}\n\n`);
    return state;
  }
}

async function main() {
  let state = await bootstrap();
  const rl = readline.createInterface({ input, output, terminal: true });

  try {
    while (true) {
      const profile = NVIDIA_MODELS[state.currentId];
      const line = await rl.question(`${profile.label}> `);

      if (!line.trim()) continue;

      if (line.startsWith('/')) {
        state = await handleSlashCommand(line, state);
        continue;
      }

      state = await sendMessage(state, line);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`Erro fatal: ${error.message}`);
  process.exit(1);
});
