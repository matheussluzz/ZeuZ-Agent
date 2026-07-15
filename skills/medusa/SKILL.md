---
name: medusa
description: Adversarially review code, configuration, documents, dashboards, queries, models, research, migrations, releases, or generated assets against the frozen request using an independent model family, requirement traceability, verification-gap analysis, and reproducible evidence. Use after every material artifact, after remediation, for release gates, for explicit review requests, and with Metis for source replay and citation validation.
---

# Medusa

Assume each delivery claim may be wrong until an attempt to falsify it fails. Review the artifact and observable behavior, never the producer's confidence.

## Load progressively

1. Read [references/review-contract.md](references/review-contract.md) for every review.
2. Read [references/review-rubric.md](references/review-rubric.md) only when selecting lenses, severity, or verdict.
3. For research, load Metis and its source protocol before replaying sources.
4. Use the scripts without loading their source unless they fail or need modification.

## Execute the review

### 1. Freeze the contract

Capture the original request, explicit and derived acceptance criteria, delivery claims, artifact paths, repository state, and current verification output. Start criteria from `assets/criteria.template.json`, generate the packet with `scripts/evidence-packet.mjs`, then securely initialize the report with `scripts/init-review-report.mjs <packet>`; do not silently reconstruct missing requirements from the delivery.

Return `REVIEW_BLOCKED` when a material input is absent, the artifact cannot be inspected, or no comparable reviewer from a different model family is available. Reviewer diversity reduces correlated error; it does not prove independence.

### 2. Establish deterministic evidence

Re-run applicable tests, types, schemas, links, permissions, secret scans, and workspace-boundary checks. Record exact commands, exit status, and relevant output. Treat stale logs, screenshots without provenance, and producer summaries as claims rather than proof.

### 3. Build the trace

Map every criterion to `MET`, `NOT_MET`, or `UNVERIFIED`, with direct evidence. Trace each changed behavior to a test or observation capable of failing when that behavior breaks. A test that only executes code is not necessarily a behavioral assertion.

### 4. Falsify in independent passes

Keep passes distinct to reduce anchoring:

1. **Contract pass** — omissions, contradictions, hidden derived requirements, misleading delivery claims.
2. **Mechanical pass** — enumerate inputs, states, paths, boundaries, permissions, timeouts, cancellation, concurrency, and recovery.
3. **Security pass** — secrets, injection, path escape, unsafe defaults, authorization, dependency and supply-chain exposure.
4. **Verification-gap pass** — changed behavior without a meaningful assertion, mocks proving themselves, missing negative cases, stale evidence.
5. **Surroundings pass** — staged, unstaged, untracked, generated, and adjacent files; compatibility and regression surface.
6. **Source-replay pass** — for research, reopen material sources and verify identity, recency, quotation accuracy, and claim entailment.

Do not require a minimum number of findings. Deduplicate observations, try to disprove each candidate finding, and retain only reproducible issues.

### 5. Decide and validate

Emit the report shape in [references/review-contract.md](references/review-contract.md). Validate it with:

```bash
node scripts/validate-review-report.mjs .agents/reviews/review-packet.json .agents/reviews/review-report.json
```

The validator checks structure, traceability, verdict consistency, reviewer-family separation, and packet freshness. It cannot prove that a finding or `PASS` is substantively correct.

Use exactly one verdict:

- `PASS` — all required criteria are `MET`; no actionable finding, failed/blocked required check, open verification gap, or stale packet remains.
- `CHANGES_REQUIRED` — at least one reproducible actionable defect or unmet criterion remains.
- `REVIEW_BLOCKED` — missing evidence, unsafe verification, inaccessible critical source/artifact, or unavailable independent reviewer prevents a defensible verdict.

Any artifact change invalidates the verdict. After remediation, create a new packet and run a fresh independent review.
