#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith('--'));
const finalGate = args.includes('--final');
if (!path || args.includes('--help')) {
  process.stdout.write('Usage: node check-source-ledger.mjs <research-ledger.json> [--final]\n');
  process.exit(args.includes('--help') ? 0 : 2);
}
for (const arg of args) if (arg.startsWith('--') && arg !== '--final') throw new Error(`Unknown option: ${arg}`);

const ledger = JSON.parse(await readFile(resolve(path), 'utf8'));
const errors = [];
const allowedClassification = new Set(['VERIFIED', 'PARTIALLY_SUPPORTED', 'CONFLICTING', 'UNVERIFIABLE', 'INFERENCE', 'OUTDATED']);
const allowedClaimType = new Set(['fact', 'inference', 'recommendation']);
const allowedImportance = new Set(['MATERIAL', 'SUPPORTING']);
const allowedRelation = new Set(['SUPPORTS', 'CONTRADICTS', 'CONTEXT']);
const allowedEntailment = new Set(['EXACT', 'PARTIAL', 'NONE']);
const allowedSourceRole = new Set(['PRIMARY', 'SECONDARY', 'DISCOVERY']);
const allowedAccessStatus = new Set(['ACCESSIBLE', 'PAYWALLED', 'BLOCKED', 'REMOVED', 'AUTH_REQUIRED', 'UNSTABLE']);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isDate = (value) => {
  if (!isText(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};
const asArray = (value) => Array.isArray(value) ? value : [];

function requireText(object, field, label) {
  if (!isText(object?.[field])) errors.push(`${label}: missing ${field}`);
}

function collectIds(items, label) {
  const ids = new Set();
  if (!Array.isArray(items)) {
    errors.push(`${label}: must be an array`);
    return ids;
  }
  for (const [index, item] of items.entries()) {
    const at = `${label} ${index + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at}: must be an object`);
      continue;
    }
    if (!isText(item.id)) errors.push(`${at}: missing id`);
    else if (ids.has(item.id)) errors.push(`${label}: duplicate id ${item.id}`);
    else ids.add(item.id);
  }
  return ids;
}

if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw new Error('Ledger root must be an object.');
if (ledger.schemaVersion !== '1.0') errors.push('ledger: schemaVersion must be 1.0');
for (const field of ['question', 'decision', 'scope', 'materialityRule']) requireText(ledger.brief, field, 'brief');
for (const field of ['cutoffDate', 'accessedAt']) if (!isDate(ledger.brief?.[field])) errors.push(`brief: ${field} must be YYYY-MM-DD`);
if (asArray(ledger.brief?.completionCriteria).length === 0) errors.push('brief: completionCriteria must be non-empty');
else if (asArray(ledger.brief?.completionCriteria).some((item) => !isText(item))) errors.push('brief: completionCriteria must contain only non-empty strings');
for (const field of ['exclusions', 'jurisdictions', 'versions', 'assumptions', 'unresolvedQuestions']) if (!Array.isArray(ledger.brief?.[field])) errors.push(`brief: ${field} must be an array`);
for (const field of ['provider', 'model', 'family']) requireText(ledger.researcher, field, 'researcher');
if (!Array.isArray(ledger.limitations) || asArray(ledger.limitations).some((item) => !isText(item))) errors.push('ledger: limitations must be an array of non-empty strings');

const sourceIds = collectIds(ledger.sources, 'source');
const claimIds = collectIds(ledger.claims, 'claim');
const sectionIds = collectIds(ledger.sections, 'section');
const canonicalUrls = new Map();

for (const source of asArray(ledger.sources)) {
  const label = `source ${source.id ?? '?'}`;
  for (const field of ['title', 'publisher', 'sourceType', 'accessStatus', 'independenceGroup']) requireText(source, field, label);
  if (!allowedAccessStatus.has(source.accessStatus)) errors.push(`${label}: invalid accessStatus ${source.accessStatus}`);
  if (!isText(source.canonicalUrl) || !/^https:\/\/[^\s]+$/.test(source.canonicalUrl)) errors.push(`${label}: canonicalUrl must be HTTPS`);
  else {
    if (canonicalUrls.has(source.canonicalUrl)) errors.push(`${label}: duplicate canonicalUrl also used by ${canonicalUrls.get(source.canonicalUrl)}`);
    canonicalUrls.set(source.canonicalUrl, source.id);
  }
  if (!isDate(source.accessedAt)) errors.push(`${label}: accessedAt must be YYYY-MM-DD`);
  if (source.publicationDate != null && !isDate(source.publicationDate)) errors.push(`${label}: publicationDate must be null or YYYY-MM-DD`);
  if (source.eventDate != null && !isDate(source.eventDate)) errors.push(`${label}: eventDate must be null or YYYY-MM-DD`);
  if (typeof source.selfReported !== 'boolean') errors.push(`${label}: selfReported must be boolean`);
  requireText(source, 'correctionStatus', label);
  if (!Array.isArray(source.limitations) || asArray(source.limitations).some((item) => !isText(item))) errors.push(`${label}: limitations must be an array of non-empty strings`);
  if (isDate(source.accessedAt) && isDate(ledger.brief?.accessedAt) && source.accessedAt > ledger.brief.accessedAt) errors.push(`${label}: accessedAt is after brief.accessedAt`);
}

for (const claim of asArray(ledger.claims)) {
  const label = `claim ${claim.id ?? '?'}`;
  requireText(claim, 'text', label);
  if (!allowedClaimType.has(claim.claimType)) errors.push(`${label}: invalid claimType ${claim.claimType}`);
  if (!allowedImportance.has(claim.importance)) errors.push(`${label}: invalid importance ${claim.importance}`);
  if (!allowedClassification.has(claim.classification)) errors.push(`${label}: invalid classification ${claim.classification}`);
  if (!Array.isArray(claim.citations)) errors.push(`${label}: citations must be an array`);
  if (!Array.isArray(claim.basisClaimIds)) errors.push(`${label}: basisClaimIds must be an array`);
  if (!Array.isArray(claim.limitations) || asArray(claim.limitations).some((item) => !isText(item))) errors.push(`${label}: limitations must be an array of non-empty strings`);
  if (claim.importance === 'MATERIAL' && claim.claimType === 'fact') {
    for (const field of ['targetSourceClass', 'stopCondition']) requireText(claim.searchPlan, field, `${label} searchPlan`);
    if (asArray(claim.searchPlan?.queryVariants).length === 0 || asArray(claim.searchPlan?.queryVariants).some((item) => !isText(item))) errors.push(`${label} searchPlan: queryVariants must contain non-empty strings`);
    if (!Array.isArray(claim.searchPlan?.adverseTerms)) errors.push(`${label} searchPlan: adverseTerms must be an array`);
  }
  for (const [index, citation] of asArray(claim.citations).entries()) {
    const edge = `${label} citation ${index + 1}`;
    if (!sourceIds.has(citation.sourceId)) errors.push(`${edge}: unknown sourceId ${citation.sourceId}`);
    if (!allowedRelation.has(citation.relation)) errors.push(`${edge}: invalid relation ${citation.relation}`);
    if (!allowedEntailment.has(citation.entailment)) errors.push(`${edge}: invalid entailment ${citation.entailment}`);
    if (!allowedSourceRole.has(citation.sourceRole)) errors.push(`${edge}: invalid sourceRole ${citation.sourceRole}`);
    requireText(citation, 'location', edge);
    requireText(citation, 'sourceProposition', edge);
    requireText(citation, 'rationale', edge);
    if (citation.relation === 'SUPPORTS' && citation.entailment === 'NONE') errors.push(`${edge}: SUPPORTS cannot have NONE entailment`);
  }
  const supports = asArray(claim.citations).filter((citation) => citation.relation === 'SUPPORTS');
  const isAccessible = (citation) => ledger.sources?.find((source) => source.id === citation.sourceId)?.accessStatus === 'ACCESSIBLE';
  const accessibleSupports = supports.filter(isAccessible);
  const accessibleContradictions = asArray(claim.citations).filter((citation) => citation.relation === 'CONTRADICTS' && isAccessible(citation));
  const exactAccessible = accessibleSupports.some((citation) => citation.entailment === 'EXACT');
  if (claim.claimType === 'fact' && claim.classification === 'VERIFIED' && !exactAccessible) errors.push(`${label}: VERIFIED fact needs accessible EXACT supporting evidence`);
  if (claim.classification === 'PARTIALLY_SUPPORTED' && !accessibleSupports.some((citation) => citation.entailment === 'PARTIAL' || citation.entailment === 'EXACT')) errors.push(`${label}: PARTIALLY_SUPPORTED needs accessible supporting evidence`);
  if (claim.classification === 'CONFLICTING' && (!accessibleSupports.length || !accessibleContradictions.length)) errors.push(`${label}: CONFLICTING needs accessible supporting and contradicting edges`);
  if (claim.claimType === 'inference') {
    if (claim.classification !== 'INFERENCE') errors.push(`${label}: inference claimType requires INFERENCE classification`);
    if (asArray(claim.basisClaimIds).length === 0) errors.push(`${label}: inference needs basisClaimIds`);
    requireText(claim, 'reasoning', label);
  }
  if (claim.classification === 'INFERENCE' && !['inference', 'recommendation'].includes(claim.claimType)) errors.push(`${label}: INFERENCE classification requires inference or recommendation claimType`);
  if (claim.claimType === 'recommendation') {
    if (claim.classification !== 'INFERENCE') errors.push(`${label}: recommendation requires INFERENCE classification`);
    if (asArray(claim.basisClaimIds).length === 0) errors.push(`${label}: recommendation needs basisClaimIds`);
    requireText(claim, 'reasoning', label);
    requireText(claim, 'decisionCriteria', label);
  }
  for (const basisId of asArray(claim.basisClaimIds)) {
    if (!claimIds.has(basisId)) errors.push(`${label}: unknown basisClaimId ${basisId}`);
    if (basisId === claim.id) errors.push(`${label}: cannot cite itself as a basis`);
  }
  if (claim.importance === 'MATERIAL' && claim.claimType === 'fact' && claim.classification !== 'UNVERIFIABLE' && asArray(claim.citations).length === 0) errors.push(`${label}: material fact needs at least one citation edge`);
  if (['PARTIALLY_SUPPORTED', 'CONFLICTING', 'UNVERIFIABLE', 'OUTDATED'].includes(claim.classification) && asArray(claim.limitations).length === 0) errors.push(`${label}: ${claim.classification} needs limitations`);
}

const basisGraph = new Map(asArray(ledger.claims).map((claim) => [claim.id, asArray(claim.basisClaimIds)]));
const visiting = new Set();
const visited = new Set();
function visitBasis(id, path = []) {
  if (visiting.has(id)) {
    errors.push(`claim basis cycle: ${[...path, id].join(' -> ')}`);
    return;
  }
  if (visited.has(id)) return;
  visiting.add(id);
  for (const next of basisGraph.get(id) ?? []) visitBasis(next, [...path, id]);
  visiting.delete(id);
  visited.add(id);
}
for (const id of claimIds) visitBasis(id);
for (const claim of asArray(ledger.claims).filter((item) => ['inference', 'recommendation'].includes(item.claimType))) {
  for (const basisId of asArray(claim.basisClaimIds)) {
    const basis = ledger.claims.find((item) => item.id === basisId);
    if (basis && claim.claimType === 'inference' && ['CONFLICTING', 'UNVERIFIABLE', 'OUTDATED'].includes(basis.classification)) errors.push(`claim ${claim.id}: unresolved basis ${basisId} cannot establish an inference`);
    if (basis && claim.claimType === 'recommendation' && ['CONFLICTING', 'UNVERIFIABLE', 'OUTDATED'].includes(basis.classification) && asArray(claim.limitations).length === 0) errors.push(`claim ${claim.id}: recommendation based on unresolved ${basisId} needs limitations`);
  }
}

const coveredClaims = new Set();
for (const section of asArray(ledger.sections)) {
  const label = `section ${section.id ?? '?'}`;
  requireText(section, 'title', label);
  if (!['PLANNED', 'READY', 'BLOCKED'].includes(section.status)) errors.push(`${label}: invalid status ${section.status}`);
  if (finalGate && section.status === 'PLANNED') errors.push(`${label}: final gate does not allow PLANNED status`);
  if (asArray(section.claimIds).length === 0) errors.push(`${label}: claimIds must be non-empty`);
  if (!Array.isArray(section.limitations) || asArray(section.limitations).some((item) => !isText(item))) errors.push(`${label}: limitations must be an array of non-empty strings`);
  if (section.status === 'BLOCKED' && asArray(section.limitations).length === 0) errors.push(`${label}: BLOCKED section needs limitations`);
  for (const id of asArray(section.claimIds)) {
    if (!claimIds.has(id)) errors.push(`${label}: unknown claimId ${id}`);
    coveredClaims.add(id);
  }
  if (section.status === 'READY') {
    const unresolved = asArray(section.claimIds).map((id) => ledger.claims?.find((claim) => claim.id === id)).filter((claim) => claim?.importance === 'MATERIAL' && ['UNVERIFIABLE', 'CONFLICTING'].includes(claim.classification));
    if (unresolved.length && asArray(section.limitations).length === 0) errors.push(`${label}: READY section with unresolved material claims needs limitations`);
  }
}
for (const claim of asArray(ledger.claims).filter((item) => item.importance === 'MATERIAL')) if (!coveredClaims.has(claim.id)) errors.push(`claim ${claim.id}: material claim is not covered by a section`);
if (sectionIds.size === 0) errors.push('ledger: at least one synthesis section is required');

if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}
const materialCount = asArray(ledger.claims).filter((claim) => claim.importance === 'MATERIAL').length;
if (finalGate && materialCount === 0) {
  process.stderr.write('ledger: final gate requires at least one material claim\n');
  process.exit(1);
}
process.stdout.write(`PASS: ledger${finalGate ? ' final gate' : ''} is structurally consistent (${sourceIds.size} sources, ${claimIds.size} claims, ${materialCount} material). Source existence and entailment still require independent replay.\n`);
