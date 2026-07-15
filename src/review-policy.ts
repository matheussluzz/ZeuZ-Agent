import { createHash } from 'node:crypto';

import type { ModelProfile, ReviewFinding, ReviewResult } from './types.js';

export interface RuntimeReviewCriterion {
  id: string;
  text: string;
  required: true;
  source: 'user' | 'derived';
}

export interface RuntimeEvidencePacket {
  schemaVersion: '1.0';
  packetFingerprint: string;
  producer: { provider: string; model: string; family: string };
  expectedReviewer: { provider: string; model: string; family: string };
  workspace: { cwd: string; fingerprint: string; status: string; diff: string };
  request: string;
  delivery: string;
  verification: string;
  artifacts: string[];
  criteria: RuntimeReviewCriterion[];
}

export class ReviewGateError extends Error {
  readonly code = 'REVIEW_GATE_BLOCKED';
  readonly review: ReviewResult;

  constructor(review: ReviewResult) {
    super(`Delivery blocked by mandatory Medusa review: ${review.verdict} — ${review.summary}`);
    this.name = 'ReviewGateError';
    this.review = review;
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function duplicateIds(items: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (!text(item.id)) continue;
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}

export function createRuntimeEvidencePacket(input: {
  producer: ModelProfile;
  reviewer: ModelProfile;
  cwd: string;
  workspaceFingerprint: string;
  status: string;
  diff: string;
  artifacts: string[];
  request: string;
  delivery: string;
  verification: string;
  bootstrapContract: string;
}): RuntimeEvidencePacket {
  const criteria: RuntimeReviewCriterion[] = [
    { id: 'REQ-USER', text: `The changed artifacts satisfy the frozen original request: ${input.request}`, required: true, source: 'user' },
    { id: 'REQ-CONTRACT', text: `The changed artifacts preserve the bootstrapped repository contract: ${input.bootstrapContract}`, required: true, source: 'derived' },
  ];
  const unsigned = {
    schemaVersion: '1.0' as const,
    producer: { provider: input.producer.provider, model: input.producer.id, family: input.producer.family },
    expectedReviewer: { provider: input.reviewer.provider, model: input.reviewer.id, family: input.reviewer.family },
    workspace: { cwd: input.cwd, fingerprint: input.workspaceFingerprint, status: input.status, diff: input.diff },
    request: input.request,
    delivery: input.delivery,
    verification: input.verification,
    artifacts: input.artifacts,
    criteria,
  };
  return { ...unsigned, packetFingerprint: sha256(JSON.stringify(unsigned)) };
}

export function blockedReview(input: {
  packet?: RuntimeEvidencePacket;
  reviewer: ModelProfile;
  raw: string;
  reason: string;
}): ReviewResult {
  return {
    verdict: 'REVIEW_BLOCKED',
    summary: input.reason,
    findings: [],
    blockers: [input.reason],
    raw: input.raw,
    reviewerModelId: input.reviewer.id,
    reviewerFamily: input.reviewer.family,
    producerFamily: input.packet?.producer.family ?? 'unknown',
    ...(input.packet ? { packetFingerprint: input.packet.packetFingerprint, workspaceFingerprint: input.packet.workspace.fingerprint } : {}),
  };
}

export function parseRuntimeReview(raw: string, packet: RuntimeEvidencePacket, reviewer: ModelProfile): ReviewResult {
  try {
    const report = JSON.parse(raw.trim()) as Record<string, unknown>;
    const errors: string[] = [];
    if (report.schemaVersion !== '1.0') errors.push('unsupported schemaVersion');
    if (report.packetFingerprint !== packet.packetFingerprint) errors.push('packetFingerprint mismatch');
    const identity = report.reviewer as Record<string, unknown> | undefined;
    if (identity?.provider !== reviewer.provider || identity?.model !== reviewer.id || identity?.family !== reviewer.family) errors.push('reviewer identity does not match the assigned reviewer');
    if (reviewer.family === packet.producer.family) errors.push('reviewer family must differ from producer family');

    const verdict = report.verdict;
    if (!['PASS', 'CHANGES_REQUIRED', 'REVIEW_BLOCKED'].includes(String(verdict))) errors.push('invalid verdict');
    if (!text(report.summary)) errors.push('summary is required');
    const blockers = array(report.blockers).filter(text);
    if (blockers.length !== array(report.blockers).length) errors.push('blockers must be non-empty strings');

    const reportCriteria = array(report.criteria) as Array<Record<string, unknown>>;
    if (duplicateIds(reportCriteria).length) errors.push('duplicate criterion ids');
    for (const criterion of packet.criteria) {
      const item = reportCriteria.find((candidate) => candidate.id === criterion.id);
      if (!item) errors.push(`missing criterion ${criterion.id}`);
      else {
        if (!['MET', 'NOT_MET', 'UNVERIFIED'].includes(String(item.status))) errors.push(`criterion ${criterion.id} has invalid status`);
        if (!Array.isArray(item.evidence) || item.evidence.length === 0 || item.evidence.some((entry) => !text(entry))) errors.push(`criterion ${criterion.id} lacks evidence`);
        if (!Array.isArray(item.findingIds)) errors.push(`criterion ${criterion.id} lacks findingIds`);
        if (item.status === 'NOT_MET' && Array.isArray(item.findingIds) && item.findingIds.length === 0) errors.push(`criterion ${criterion.id} NOT_MET requires a finding`);
      }
    }
    if (reportCriteria.some((item) => !packet.criteria.some((criterion) => criterion.id === item.id))) errors.push('report contains unknown criteria');

    const checks = array(report.deterministicChecks) as Array<Record<string, unknown>>;
    if (duplicateIds(checks).length) errors.push('duplicate deterministic check ids');
    if (checks.length === 0) errors.push('deterministicChecks are required');
    for (const check of checks) {
      if (!text(check.id) || !text(check.command) || !text(check.evidence) || typeof check.required !== 'boolean' || !['PASS', 'FAIL', 'BLOCKED', 'NOT_APPLICABLE'].includes(String(check.status))) errors.push('invalid deterministic check');
    }
    const gaps = array(report.verificationGaps) as Array<Record<string, unknown>>;
    if (duplicateIds(gaps).length) errors.push('duplicate verification gap ids');
    if (gaps.length === 0) errors.push('verificationGaps are required');
    for (const gap of gaps) {
      if (!text(gap.id) || !text(gap.changedBehavior) || !text(gap.assertion) || !text(gap.evidence) || !['COVERED', 'GAP', 'NOT_APPLICABLE'].includes(String(gap.status))) errors.push('invalid verification gap');
    }

    const canonicalFindings = array(report.findings) as Array<Record<string, unknown>>;
    if (duplicateIds(canonicalFindings).length) errors.push('duplicate finding ids');
    const findingIds = new Set(canonicalFindings.filter((finding) => text(finding.id)).map((finding) => String(finding.id)));
    const findings: ReviewFinding[] = [];
    for (const finding of canonicalFindings) {
      if (!text(finding.id) || !['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(String(finding.severity)) || !text(finding.title) || !text(finding.location) || !text(finding.evidence) || !text(finding.reproduction) || !text(finding.expectedCorrection) || !Array.isArray(finding.criterionIds) || finding.criterionIds.length === 0) {
        errors.push('invalid actionable finding');
        continue;
      }
      findings.push({
        severity: String(finding.severity).toLowerCase() as ReviewFinding['severity'],
        title: String(finding.title),
        detail: `${String(finding.evidence)} Correction: ${String(finding.expectedCorrection)}`,
        file: String(finding.location),
      });
      for (const criterionId of finding.criterionIds) {
        const criterion = reportCriteria.find((item) => item.id === criterionId);
        if (!criterion || criterion.status !== 'NOT_MET' || !array(criterion.findingIds).includes(finding.id)) errors.push(`finding ${String(finding.id)} is not linked to NOT_MET criterion ${String(criterionId)}`);
      }
    }
    for (const criterion of reportCriteria) {
      for (const id of array(criterion.findingIds)) if (!findingIds.has(String(id))) errors.push(`criterion ${String(criterion.id)} references unknown finding ${String(id)}`);
    }

    const requiredCriteria = packet.criteria.map((criterion) => reportCriteria.find((item) => item.id === criterion.id));
    const requiredChecks = checks.filter((check) => check.required === true);
    const openGaps = gaps.filter((gap) => gap.status === 'GAP');
    if (verdict === 'PASS') {
      if (blockers.length || findings.length || requiredCriteria.some((criterion) => criterion?.status !== 'MET') || requiredChecks.some((check) => !['PASS', 'NOT_APPLICABLE'].includes(String(check.status))) || checks.some((check) => check.status === 'FAIL') || openGaps.length) errors.push('PASS is inconsistent with unresolved review evidence');
    } else if (verdict === 'CHANGES_REQUIRED') {
      if (!findings.length && !requiredCriteria.some((criterion) => criterion?.status === 'NOT_MET') && !requiredChecks.some((check) => check.status === 'FAIL') && !openGaps.length) errors.push('CHANGES_REQUIRED lacks actionable evidence');
    } else if (verdict === 'REVIEW_BLOCKED') {
      if (!blockers.length && !requiredCriteria.some((criterion) => criterion?.status === 'UNVERIFIED') && !requiredChecks.some((check) => check.status === 'BLOCKED')) errors.push('REVIEW_BLOCKED lacks blocker evidence');
    }
    if (errors.length) throw new Error([...new Set(errors)].join('; '));

    return {
      verdict: verdict as ReviewResult['verdict'],
      summary: String(report.summary),
      findings,
      blockers,
      raw,
      reviewerModelId: reviewer.id,
      reviewerFamily: reviewer.family,
      producerFamily: packet.producer.family,
      packetFingerprint: packet.packetFingerprint,
      workspaceFingerprint: packet.workspace.fingerprint,
    };
  } catch (error) {
    return blockedReview({
      packet,
      reviewer,
      raw,
      reason: `Reviewer report is invalid; completion cannot be certified (${error instanceof Error ? error.message : String(error)}).`,
    });
  }
}

export function assertReviewPass(review: ReviewResult, currentWorkspaceFingerprint: string | undefined): void {
  if (review.verdict !== 'PASS') throw new ReviewGateError(review);
  if (!currentWorkspaceFingerprint || !review.workspaceFingerprint || currentWorkspaceFingerprint !== review.workspaceFingerprint) {
    throw new ReviewGateError({ ...review, verdict: 'REVIEW_BLOCKED', summary: 'Review evidence is stale or workspace freshness is unprovable.', blockers: [...review.blockers, 'Workspace fingerprint changed or is unavailable.'] });
  }
}
