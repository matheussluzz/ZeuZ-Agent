import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MODEL_ID, MODEL_CATALOG, isConfigured, requireModel, resolveModel } from '../src/catalog.js';

test('catalog contains every authorized route', () => {
  assert.equal(MODEL_CATALOG.length, 54);
  assert.equal(new Set(MODEL_CATALOG.map((model) => model.id)).size, MODEL_CATALOG.length);
  assert.equal(requireModel(DEFAULT_MODEL_ID).label, 'GPT-5.6 Sol · medium');
});

test('aliases resolve to the recommended family defaults', () => {
  assert.equal(requireModel('sol').id, 'codex:gpt-5.6-sol@medium');
  assert.equal(requireModel('composer').id, 'cursor:composer-2.5');
  assert.equal(requireModel('fable').id, 'cursor:claude-fable-5-thinking-high');
  assert.equal(requireModel('grok').id, 'cursor:cursor-grok-4.5-high');
  assert.equal(requireModel('sonnet5').id, 'copilot:claude-sonnet-5');
  assert.equal(requireModel('gemini').id, 'agy:gemini-3.5-flash@medium');
  assert.equal(requireModel('deepseek').id, 'nvidia:deepseek-v4');
  assert.equal(requireModel('deepseek-v4-flash').id, 'nvidia:deepseek-v4-flash');
  assert.equal(requireModel('deepseek-v4-flash').model, 'deepseek-ai/deepseek-v4-flash-0731');
  assert.equal(requireModel('ox').id, 'openrouter:stealth/ox-alpha');
  assert.equal(requireModel('gpt-4o').id, 'openrouter:openai/gpt-4o');
});

test('OpenRouter configuration rejects example placeholders', () => {
  const keyName = 'OPENROUTER_API_KEY';
  const previous = process.env[keyName];
  try {
    for (const value of ['replace-with-your-openrouter-key', 'example-key', '<your-key>']) {
      process.env[keyName] = value;
      assert.equal(isConfigured(requireModel('openrouter:stealth/ox-alpha')), false);
    }
    process.env[keyName] = 'fixture-key';
    assert.equal(isConfigured(requireModel('openrouter:stealth/ox-alpha')), true);
  } finally {
    if (previous === undefined) delete process.env[keyName];
    else process.env[keyName] = previous;
  }
});

test('ambiguous partial routes do not silently select a model', () => {
  assert.equal(resolveModel('gpt-5.6'), undefined);
  assert.throws(() => requireModel('fable-5'), /Unknown or ambiguous/);
});

test('direct Claude aliases do not change the recommended bare Fable route', () => {
  assert.equal(requireModel('fable').id, 'cursor:claude-fable-5-thinking-high');
  assert.equal(requireModel('claude-fable').id, 'claude:fable');
  assert.equal(requireModel('claude-fable').model, 'fable');
  assert.equal(requireModel('opus-4.8').id, 'claude:claude-opus-4-8');
  assert.equal(requireModel('opus-4.8').model, 'opus');
  assert.equal(requireModel('sonnet-5-claude').id, 'claude:claude-sonnet-5');
  assert.equal(requireModel('sonnet-5-claude').model, 'sonnet');
});
