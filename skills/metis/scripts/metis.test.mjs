import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const templatePath = resolve(scriptsDirectory, '../assets/source-ledger.template.json');

function runNode(script, args) {
  return spawnSync(process.execPath, [resolve(scriptsDirectory, script), ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 5_000_000 });
}

function mustPass(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

async function loadTemplate() {
  return JSON.parse(await readFile(templatePath, 'utf8'));
}

async function writeLedger(t, ledger) {
  const directory = await mkdtemp(join(tmpdir(), 'zeuz-metis-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.json');
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`);
  return path;
}

test('accepts the final ledger and emits a replay item for its material edge', async (t) => {
  const ledgerPath = await writeLedger(t, await loadTemplate());
  const validation = runNode('check-source-ledger.mjs', [ledgerPath, '--final']);
  mustPass(validation, 'validate final ledger');
  assert.match(validation.stdout, /ledger final gate is structurally consistent/);

  const replay = runNode('create-replay-plan.mjs', [ledgerPath]);
  mustPass(replay, 'create replay plan');
  const plan = JSON.parse(replay.stdout);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].claimId, 'CLM-001');
  assert.equal(plan.items[0].recordedEntailment, 'EXACT');
  assert.ok(plan.items[0].recordedSourceProposition);
});

test('rejects an unknown source and invalid claim-relative source role', async (t) => {
  const ledger = await loadTemplate();
  ledger.claims[0].citations[0].sourceId = 'SRC-MISSING';
  ledger.claims[0].citations[0].sourceRole = 'UNKNOWN';
  const ledgerPath = await writeLedger(t, ledger);
  const result = runNode('check-source-ledger.mjs', [ledgerPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown sourceId SRC-MISSING/);
  assert.match(result.stderr, /invalid sourceRole UNKNOWN/);
});

test('rejects a cyclic inference basis graph', async (t) => {
  const ledger = await loadTemplate();
  ledger.claims = [
    {
      id: 'CLM-001', text: 'Inference one.', claimType: 'inference', importance: 'MATERIAL', classification: 'INFERENCE',
      citations: [], basisClaimIds: ['CLM-002'], reasoning: 'Depends on inference two.', decisionCriteria: null, limitations: [],
    },
    {
      id: 'CLM-002', text: 'Inference two.', claimType: 'inference', importance: 'MATERIAL', classification: 'INFERENCE',
      citations: [], basisClaimIds: ['CLM-001'], reasoning: 'Depends on inference one.', decisionCriteria: null, limitations: [],
    },
  ];
  ledger.sections[0].claimIds = ['CLM-001', 'CLM-002'];
  const ledgerPath = await writeLedger(t, ledger);
  const result = runNode('check-source-ledger.mjs', [ledgerPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claim basis cycle: CLM-001 -> CLM-002 -> CLM-001/);
});
