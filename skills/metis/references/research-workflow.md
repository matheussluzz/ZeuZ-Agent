# Research workflow and ledger contract

## 1. Brief gate

Copy `assets/research-brief.template.json`. Freeze:

- question and intended decision;
- audience and required depth;
- `cutoffDate` and `accessedAt` as ISO dates;
- scope, exclusions, jurisdictions, products/versions;
- completion criteria;
- materiality rule: which claims could change the decision or central conclusion;
- allowed assumptions and unresolved questions.

Do not let search results silently redefine the question. Version the brief if the user expands scope.

## 2. Claim plan

Create atomic claim IDs before synthesis. A claim is atomic when one evidence edge can support or contradict it without also needing to prove an unrelated clause.

Use `claimType`:

- `fact`: externally verifiable statement;
- `inference`: reasoned conclusion from ledger claims;
- `recommendation`: advice based on premises and decision criteria.

Use `importance: "MATERIAL"` when changing the claim could change the answer, decision, risk, or core narrative; otherwise use `SUPPORTING`.

## 3. Search matrix

For each material claim, record:

| Field | Purpose |
| --- | --- |
| target source class | prevents convenient-source bias |
| query variants | terminology, version, jurisdiction, adverse/correction terms |
| stop condition | defines enough evidence before searching |
| known conflicts | preserves disagreement |

Do not use a fixed source count. One governing primary source may be decisive; many dependent secondary pages may add no evidence.

## 4. Ledger schema

Copy `assets/source-ledger.template.json`. The root contains:

- `schemaVersion: "1.0"`;
- embedded frozen `brief`;
- `sources`: identity/provenance records;
- `claims`: claim classifications and citation edges; classify source role on each edge because “primary” is claim-relative;
- `sections`: planned synthesis sections with claim coverage;
- `limitations`: cross-cutting gaps;
- `researcher`: provider/model/family, when available.

The deterministic validator enforces IDs, references, dates, URL form, classification/claim-type consistency, material-claim search plans, section coverage, inference premises, and supporting-edge requirements. The `--final` gate also rejects synthesis sections left `PLANNED`. It deliberately does not fetch URLs or judge source semantics.

## 5. Synthesis gate

Before drafting, require:

- every material fact classified;
- every `VERIFIED` material fact linked to an accessible source with a `SUPPORTS` edge and `EXACT` entailment;
- every inference linked to verified/partially supported basis claims with reasoning;
- every recommendation linked to premise claims and explicit decision criteria;
- contradictions and limitations included in planned sections;
- every planned section marked `READY` or `BLOCKED`.

If a central section is `BLOCKED`, answer what can be established and name the gap. Do not fill it from memory.

## 6. Medusa replay

`create-replay-plan.mjs` selects every source edge used by a material claim and all contradictory edges. The independent reviewer should receive no desired verdict and should:

1. reopen the canonical source rather than trust ledger excerpts;
2. confirm identity, dates, version/jurisdiction, and access state;
3. navigate to the recorded location;
4. independently restate the source proposition;
5. compare it to the exact claim using the entailment dimensions;
6. record `CONFIRMED`, `MISMATCH`, or `BLOCKED` with evidence;
7. trace every material answer clause back to a ledger claim.

The replay plan is a queue, not proof. An inaccessible critical source makes the independent review `REVIEW_BLOCKED` unless the claim can be re-established from appropriate accessible evidence and the ledger is regenerated.
