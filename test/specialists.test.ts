import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseSpecialistExecution,
  isRootOrchestrator,
  PANTHEON_PERSONA_IDS,
  parseCapabilityRequests,
  routeCapabilityRequest,
  routeSpecialistIntent,
} from '../src/specialists.js';

test('Pantheon catalog exposes exactly the eight built-in persona commands', () => {
  assert.deepEqual(PANTHEON_PERSONA_IDS, ['argos', 'hefesto', 'metis', 'medusa', 'atena', 'clio', 'prometeu', 'hermes']);
  for (const id of PANTHEON_PERSONA_IDS) {
    const route = routeSpecialistIntent(`/${id} do the bounded task`);
    assert.equal(route.status, 'matched');
    if (route.status === 'matched') assert.equal(route.source, 'explicit');
  }
});

test('automatic routing is deterministic, reports ambiguity, and chooses execution conservatively', () => {
  const automatic = routeSpecialistIntent('Please produce a forecast for the next period.');
  assert.equal(automatic.status, 'matched');
  if (automatic.status === 'matched') {
    assert.equal(automatic.persona.id, 'argos');
    assert.equal(chooseSpecialistExecution(automatic.persona, { source: automatic.source, mode: 'plan', task: 'Please produce a forecast.' }), 'in-process');
    assert.equal(chooseSpecialistExecution(automatic.persona, { source: automatic.source, mode: 'agent', task: 'Please produce a forecast.' }), 'spawn');
  }

  const ambiguous = routeSpecialistIntent('Run a query for the dashboard data.');
  assert.equal(ambiguous.status, 'ambiguous');
  if (ambiguous.status === 'ambiguous') assert.deepEqual(ambiguous.candidates, ['hefesto', 'prometeu']);

  const explicit = routeSpecialistIntent('/argos explain the forecast');
  assert.equal(explicit.status, 'matched');
  if (explicit.status === 'matched') assert.equal(chooseSpecialistExecution(explicit.persona, { source: explicit.source, mode: 'plan', task: 'explain' }), 'spawn');
});

test('root-only specialist spawning and typed capability routing fail closed', () => {
  assert.equal(isRootOrchestrator({ ZEUZ_INTERNAL_WORKER: '1', ZEUZ_DELEGATION_DEPTH: '0' }), false);
  assert.equal(isRootOrchestrator({ ZEUZ_DELEGATION_DEPTH: '1' }), false);
  assert.equal(isRootOrchestrator({ ZEUZ_DELEGATION_DEPTH: '0' }), true);
  assert.equal(isRootOrchestrator({ ZEUZ_DELEGATION_DEPTH: '0junk' }), false);

  const request = { requesterTaskId: 'task-1', rootCorrelationId: 'root-1', personaId: 'metis' as const, capability: 'current-research', reason: 'Need primary sources.' };
  assert.equal(routeCapabilityRequest(request, false).code, 'ROOT_REQUIRED');
  assert.equal(routeCapabilityRequest(request, true).code, 'SIBLING_SPAWN_AVAILABLE');
  assert.equal(routeCapabilityRequest({ ...request, capability: '' }, true).code, 'INVALID_CAPABILITY_REQUEST');

  const parsed = parseCapabilityRequests(`<zeuz_capability_request>${JSON.stringify(request)}</zeuz_capability_request>`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.request?.personaId, 'metis');
});
