import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MODEL_ID, MODEL_CATALOG, requireModel, resolveModel } from '../src/catalog.js';

test('catalog contains every authorized route', () => {
  assert.equal(MODEL_CATALOG.length, 51);
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
