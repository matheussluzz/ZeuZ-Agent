#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const path = process.argv[2];
if (!path || path === '--help') {
  process.stdout.write('Usage: node create-replay-plan.mjs <research-ledger.json>\n');
  process.exit(path === '--help' ? 0 : 2);
}

const raw = await readFile(resolve(path), 'utf8');
const ledger = JSON.parse(raw);
if (ledger.schemaVersion !== '1.0' || !Array.isArray(ledger.sources) || !Array.isArray(ledger.claims)) throw new Error('Expected a validated Metis 1.0 ledger.');
const sourceById = new Map(ledger.sources.map((source) => [source.id, source]));
const items = [];
for (const claim of ledger.claims) {
  const replayAll = claim.importance === 'MATERIAL';
  for (const citation of claim.citations ?? []) {
    if (!replayAll && citation.relation !== 'CONTRADICTS') continue;
    const source = sourceById.get(citation.sourceId);
    if (!source) throw new Error(`Unknown source ${citation.sourceId}`);
    items.push({
      claimId: claim.id,
      exactClaim: claim.text,
      classification: claim.classification,
      relation: citation.relation,
      recordedEntailment: citation.entailment,
      sourceId: source.id,
      canonicalUrl: source.canonicalUrl,
      sourceIdentity: { title: source.title, publisher: source.publisher, publicationDate: source.publicationDate, version: source.version ?? null, jurisdiction: source.jurisdiction ?? null },
      recordedLocation: citation.location,
      recordedSourceProposition: citation.sourceProposition,
      recordedRationale: citation.rationale,
      replayChecks: ['source identity', 'applicable date/version/jurisdiction', 'recorded location', 'exact-claim entailment', 'correction/retraction/supersession'],
    });
  }
}
items.sort((a, b) => a.claimId.localeCompare(b.claimId) || a.sourceId.localeCompare(b.sourceId) || a.relation.localeCompare(b.relation));
const plan = {
  schemaVersion: '1.0',
  ledgerSha256: createHash('sha256').update(raw).digest('hex'),
  generatedAt: new Date().toISOString(),
  reviewerInstruction: 'Reopen each source independently. Record CONFIRMED, MISMATCH, or BLOCKED with direct evidence; do not trust ledger excerpts.',
  items,
};
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
