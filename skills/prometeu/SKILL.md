---
name: prometeu
description: Design, explain, and validate efficient SQL with verified schemas, explicit grain, correctness checks, and measurable scan/runtime cost controls. Use for SQL generation, query optimization, Athena/Trino analysis, expensive scans, partition strategy, joins, window functions, or data extraction plans.
---

# Prometeu

Correctness precedes cost; measured improvement precedes the word “optimized.” Never invent schemas or claim savings without before/after evidence.

## Progressive workflow

### 1. Freeze the query contract

Use [assets/query-contract.md](assets/query-contract.md). Record dialect/engine version, verified schema evidence, business question, output grain/key, population, time semantics/time zone, freshness, parameters, required fields, ordering, null/duplicate policy, expected scale, SLA, cost ceiling, and authorized execution environment.

**Gate:** every ambiguous business term, join key, time boundary, and denominator is resolved or explicitly marked as an assumption requiring approval.

### 2. Design correctness checks before SQL

Create executable or independently recomputable checks for grain uniqueness, row counts, control totals, nulls, duplicates, join fanout, boundary dates, excluded populations, and representative records. Specify what would falsify the query. A sample that only covers happy paths is insufficient.

### 3. Build a legible baseline

Write the simplest query that implements the contract. Select only required columns; filter the event timestamp and its partition key where both matter. Make join cardinality and deduplication choice explicit. Prefer deterministic tie-breaking. Separate semantic transformations into named common table expressions when that makes grain changes auditable.

### 4. Optimize one hypothesis at a time

Estimate the dominant cost from evidence: scan/layout, join build/fanout, shuffle, sort/window, aggregation cardinality, or repeated work. For Athena hash joins, normally keep the large probe relation left and the smaller build relation right. Prefer pre-aggregation, top-N, `max_by`/`min_by`, projection, or `UNION ALL` only when the contract and checks preserve semantics. Approximation requires an accepted error bound and stakeholder approval.

**Gate:** map each rewrite to a predicted metric change and a correctness check that would detect semantic drift. Do not stack unmeasured rewrites.

### 5. Plan safely, then checkpoint execution

Run `node scripts/sql-policy.mjs <file.sql>` as a conservative lexical preflight. Use a dialect-compatible parser/formatter and safe `EXPLAIN`; for Atena, never replace `EXPLAIN` with chargeable `EXPLAIN ANALYZE`. Show the exact SQL/hash, environment, scan cutoff, exceptions, and test plan before execution.

### 6. Measure comparable runs

Run only after authorization. Capture data snapshot/parameters, engine/workgroup, query hash, scanned bytes, engine/wall/queue time, returned rows, spill/resource signals when available, and all correctness checks. Compare like with like using `node scripts/compare-query-metrics.mjs <baseline.json> <candidate.json> [--require-scan-improvement]`.

### 7. Deliver evidence, not an adjective

Return the query, contract, schema evidence, assumptions, correctness proof, cost hypothesis, safe-plan result, comparable before/after metrics, limitations, and rollback/fallback. Say “optimized” only for measured dimensions that improved without failed correctness checks or material regression elsewhere.

Materialization, CTAS, UNLOAD, file compaction, partition redesign, and Parquet/ORC may be architecture recommendations; Atena's safe execution path must not run them.

The bundled scripts do not parse SQL completely, establish authorization, prove result equivalence, or make two executions comparable on their own. Read [references/sql-cost-checklist.md](references/sql-cost-checklist.md) for correctness traps, dialect-specific cost controls, and the evidence matrix.
