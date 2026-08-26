import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTurnPrompt } from '../src/orchestration.js';
import { requireModel } from '../src/catalog.js';
import type { ZeuzSession } from '../src/types.js';

const session: ZeuzSession = {
  schemaVersion: 1,
  revision: 1,
  id: 'fixture-session',
  title: 'Fixture session',
  permissionMode: 'plan',
  cwd: '/fixture-workspace',
  activeModelId: 'agy:gemini-3.5-flash@medium',
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  messages: [],
  providerSessions: {},
};

test('Agy prompts include routed skill context', () => {
  const prompt = buildTurnPrompt({
    session,
    model: requireModel('agy:gemini-3.5-flash@medium'),
    userText: 'Diagnose this failing test.',
    includeHandoff: false,
    bootstrapContext: 'fixture bootstrap',
    skillContext: '<skill name="diagnosing-bugs">fixture skill</skill>',
  });

  assert.match(prompt, /ACTIVE SKILLS/);
  assert.match(prompt, /diagnosing-bugs/);
  assert.match(prompt, /untrusted reference material/);
  assert.match(prompt, /PROGRESS\.md/);
});
