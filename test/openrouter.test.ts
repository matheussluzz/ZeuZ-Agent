import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenRouterAdapter } from '../src/adapters/openrouter.js';
import { createDefaultAdapterRuntime, type AdapterRuntime } from '../src/adapters/runtime.js';
import { requireModel } from '../src/catalog.js';
import type { HttpRequestInput, HttpTransportResponse } from '../src/http-transport.js';
import { UnsupportedCapabilityError, permissionCapability } from '../src/permissions.js';
import type { AgentEvent, ModelProfile } from '../src/types.js';

function response(payload: unknown, status = 200): HttpTransportResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Fixture error',
    chunks: (async function* (): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode(JSON.stringify(payload));
    })(),
  };
}

function fixtureModel(): ModelProfile {
  return requireModel('openrouter:stealth/ox-alpha');
}

function fixtureRuntime(
  httpRequest: AdapterRuntime['httpRequest'],
  values: Record<string, string | undefined> = {},
): AdapterRuntime {
  const base = createDefaultAdapterRuntime();
  return {
    ...base,
    envGet: (name) => values[name],
    httpRequest,
  };
}

test('OpenRouter sends an OpenAI-compatible tool-capable request and returns text', async () => {
  const requests: HttpRequestInput[] = [];
  const events: AgentEvent[] = [];
  const runtime = fixtureRuntime(
    async (input) => {
      requests.push(input);
      return response({
        id: 'fixture-completion',
        choices: [{ message: { role: 'assistant', content: 'fixture response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    },
    {
      OPENROUTER_API_KEY: 'fixture-openrouter-key',
      OPENROUTER_API_BASE_URL: 'https://example.invalid/api/v1',
      OPENROUTER_HTTP_REFERER: 'https://example.invalid/zeuz',
      OPENROUTER_X_TITLE: 'ZeuZ fixture',
      OPENROUTER_MODEL_OX_ALPHA: 'stealth/ox-alpha',
    },
  );

  const result = await new OpenRouterAdapter({ runtime }).run({
    model: fixtureModel(),
    prompt: 'Inspect this fixture and summarize it.',
    cwd: '/fixture-workspace',
    mode: 'plan',
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.text, 'fixture response');
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  assert.deepEqual(events, [{ type: 'delta', text: 'fixture response' }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://example.invalid/api/v1/chat/completions');
  assert.equal(requests[0]?.headers.Authorization, 'Bearer fixture-openrouter-key');
  assert.equal(requests[0]?.headers['HTTP-Referer'], 'https://example.invalid/zeuz');
  assert.equal(requests[0]?.headers['X-Title'], 'ZeuZ fixture');
  const body = JSON.parse(requests[0]?.body ?? '{}') as {
    model?: string;
    messages?: Array<{ role?: string; content?: string }>;
    tools?: unknown[];
    tool_choice?: string;
    parallel_tool_calls?: boolean;
    max_tokens?: number;
    stream?: boolean;
  };
  assert.equal(body.model, 'stealth/ox-alpha');
  assert.equal(body.messages?.at(-1)?.content, 'Inspect this fixture and summarize it.');
  assert.equal(body.tools?.some((item) => (item as { function?: { name?: string } }).function?.name === 'read_file'), true);
  assert.equal(body.tools?.some((item) => (item as { function?: { name?: string } }).function?.name === 'write_file'), false);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.max_tokens, 16_384);
  assert.equal(body.stream, false);
});

test('OpenRouter executes sequential tool calls and keeps plan mode read-only', async () => {
  const requests: HttpRequestInput[] = [];
  let callCount = 0;
  const runtime = fixtureRuntime(
    async (input) => {
      requests.push(input);
      callCount += 1;
      if (callCount === 1) {
        return response({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/types.ts', start: 1, end: 4 }) } }],
            },
          }],
        });
      }
      return response({ choices: [{ message: { role: 'assistant', content: 'plan complete' } }] });
    },
    { OPENROUTER_API_KEY: 'fixture-openrouter-key' },
  );

  const result = await new OpenRouterAdapter({ runtime }).run({
    model: fixtureModel(),
    prompt: 'Use a read-only inspection tool, then summarize.',
    cwd: process.cwd(),
    mode: 'plan',
  });

  assert.equal(result.text, 'plan complete');
  assert.equal(requests.length, 2);
  const secondBody = JSON.parse(requests[1]?.body ?? '{}') as { messages?: Array<{ role?: string; content?: string; tool_call_id?: string }> };
  assert.equal(secondBody.messages?.some((message) => message.role === 'tool' && message.tool_call_id === 'call-1' && message.content?.includes('ProviderId')), true);
});

test('OpenRouter fails closed when credentials are missing or native resume is requested', async () => {
  let calls = 0;
  const missingRuntime = fixtureRuntime(async () => {
    calls += 1;
    return response({});
  });
  await assert.rejects(
    () => new OpenRouterAdapter({ runtime: missingRuntime }).run({ model: fixtureModel(), prompt: 'fixture', cwd: process.cwd(), mode: 'plan' }),
    /Missing OPENROUTER_API_KEY/,
  );
  assert.equal(calls, 0);

  const runtime = fixtureRuntime(async () => response({ choices: [{ message: { content: 'unused' } }] }), { OPENROUTER_API_KEY: 'fixture-openrouter-key' });
  await assert.rejects(
    () => new OpenRouterAdapter({ runtime }).run({ model: fixtureModel(), prompt: 'fixture', cwd: process.cwd(), mode: 'plan', resumeId: 'native-session' }),
    UnsupportedCapabilityError,
  );
});

test('OpenRouter preserves a safe provider diagnostic for unavailable models', async () => {
  const runtime = fixtureRuntime(
    async () => response({ error: { message: 'Model not found: stealth/ox-alpha', code: 404 } }, 404),
    { OPENROUTER_API_KEY: 'fixture-openrouter-key' },
  );
  await assert.rejects(
    () => new OpenRouterAdapter({ runtime }).run({ model: fixtureModel(), prompt: 'fixture', cwd: process.cwd(), mode: 'plan' }),
    /OpenRouter HTTP 404: Model not found: stealth\/ox-alpha/,
  );
});

test('OpenRouter health reports configuration without making a network request', async () => {
  let calls = 0;
  const runtime = fixtureRuntime(async () => {
    calls += 1;
    return response({});
  }, { OPENROUTER_API_KEY: 'fixture-openrouter-key' });
  const health = await new OpenRouterAdapter({ runtime }).health();
  assert.equal(health.ok, true);
  assert.match(health.detail ?? '', /deep/);
  assert.equal(calls, 0);
  assert.equal(permissionCapability('openrouter', 'agent').filesystem, 'workspace-write');
  assert.equal(permissionCapability('openrouter', 'agent').resume, 'unsupported');
});
