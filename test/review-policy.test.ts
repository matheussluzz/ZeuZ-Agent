import assert from 'node:assert/strict';
import test from 'node:test';

import { assertReviewPass, createRuntimeEvidencePacket, parseRuntimeReview, ReviewGateError } from '../src/review-policy.js';
import type { ModelProfile } from '../src/types.js';

const producer: ModelProfile = {
  id: 'codex:producer', provider: 'codex', model: 'producer', label: 'Producer', family: 'OpenAI', description: 'fixture', aliases: [],
};
const reviewer: ModelProfile = {
  id: 'cursor:reviewer', provider: 'cursor', model: 'reviewer', label: 'Reviewer', family: 'Anthropic', description: 'fixture', aliases: [],
};

function packet(assignedReviewer = reviewer) {
  return createRuntimeEvidencePacket({
    producer,
    reviewer: assignedReviewer,
    cwd: '/workspace',
    workspaceFingerprint: 'workspace-fingerprint',
    status: ' M artifact.ts',
    diff: 'fixture diff',
    artifacts: ['artifact.ts'],
    request: 'Change the artifact.',
    delivery: 'Changed the artifact.',
    verification: 'Run fixture test.',
    bootstrapContract: 'Frozen fixture contract.',
  });
}

function passingReport(input = packet()): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    packetFingerprint: input.packetFingerprint,
    reviewer: input.expectedReviewer,
    deterministicChecks: [{ id: 'CHK-001', command: 'fixture test', status: 'PASS', required: true, evidence: 'exit 0' }],
    criteria: input.criteria.map((criterion) => ({ id: criterion.id, status: 'MET', evidence: ['fixture evidence'], findingIds: [] })),
    verificationGaps: [{ id: 'GAP-001', changedBehavior: 'artifact', assertion: 'fixture assertion', status: 'COVERED', evidence: 'fixture test' }],
    findings: [],
    blockers: [],
    verdict: 'PASS',
    summary: 'Fresh cross-family fixture pass.',
  });
}

test('accepts a structurally valid fresh cross-family runtime PASS', () => {
  const evidence = packet();
  const result = parseRuntimeReview(passingReport(evidence), evidence, reviewer);
  assert.equal(result.verdict, 'PASS');
  assert.doesNotThrow(() => assertReviewPass(result, 'workspace-fingerprint'));
});

test('invalid or tampered runtime reviewer output becomes REVIEW_BLOCKED', () => {
  const evidence = packet();
  for (const raw of ['not json', passingReport(evidence).replace(evidence.packetFingerprint, 'tampered')]) {
    const result = parseRuntimeReview(raw, evidence, reviewer);
    assert.equal(result.verdict, 'REVIEW_BLOCKED');
    assert.throws(() => assertReviewPass(result, 'workspace-fingerprint'), ReviewGateError);
  }
});

test('same-family runtime review cannot produce PASS', () => {
  const sameFamilyReviewer = { ...reviewer, family: producer.family };
  const evidence = packet(sameFamilyReviewer);
  const result = parseRuntimeReview(passingReport(evidence), evidence, sameFamilyReviewer);
  assert.equal(result.verdict, 'REVIEW_BLOCKED');
  assert.match(result.summary, /reviewer family must differ/);
});

test('a valid report becomes stale after the workspace fingerprint changes', () => {
  const evidence = packet();
  const result = parseRuntimeReview(passingReport(evidence), evidence, reviewer);
  assert.throws(
    () => assertReviewPass(result, 'changed-fingerprint'),
    (error: Error & { review?: { verdict?: string } }) => error instanceof ReviewGateError && error.review.verdict === 'REVIEW_BLOCKED',
  );
});
