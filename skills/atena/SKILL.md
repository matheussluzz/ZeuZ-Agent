---
name: atena
description: Plan and execute dataset-read-only AWS Athena analysis through a constrained MCP server, using verified Glue schemas, partition filters, bounded results, workgroup cost controls, and explicit confirmation before chargeable queries. Use for AWS Athena, Glue catalog discovery, lakehouse analysis, query results, or scan-cost investigations.
---

# Atena

Treat Athena `SELECT` as a chargeable side effect: it calls the IAM write-classified `StartQueryExecution` action and creates results even though it does not mutate source datasets.

## Progressive workflow

### 1. Freeze purpose and authority

Read Clio's glossary, rules, schemas, sensitivity notes, and source verification dates. Confirm business question, output grain, period/time zone, freshness, approximation tolerance, result limit, intended recipients, region, expected account, catalog, database, and workgroup.

**Gate:** distinguish authority to inspect metadata from authority to expose row data. Stop if purpose, audience, sensitivity, or access basis is unclear.

### 2. Verify runtime identity and boundaries

Call STS identity first and compare account, ARN/role, region, and workgroup with the frozen scope. Inspect workgroup enforcement, result configuration, encryption, engine version, and bytes-scanned cutoff. Stop on an unexpected boundary or a permissive configuration that exceeds the approved task.

### 3. Resolve metadata and policy

Resolve every catalog, database, table, column, partition, and type through Glue. Never invent identifiers. Confirm Lake Formation/IAM row, column, and location controls with the target owner when sensitive data is involved. Retrieve results through Athena; do not add a generic S3 read path that could bypass those controls.

**Gate:** record schema evidence, partitions, sensitivity, stale/conflicting metadata, and allowed output fields. Remove direct identifiers and small-cell disclosures unless explicitly authorized.

### 4. Specify and plan the query

Delegate SQL, grain/cardinality proof, test cases, and cost rationale to Prometeu. Require direct partition predicates when partitions exist unless the approver accepts a documented exception. Run `EXPLAIN (TYPE IO, FORMAT JSON)` for the exact `SELECT`; treat estimates as incomplete/heuristic. Never substitute `EXPLAIN ANALYZE`, which executes and charges.

### 5. Present the consequential checkpoint

Create a self-contained record from [assets/preflight.example.json](assets/preflight.example.json). Show the business question, SQL/hash, identity, workgroup cutoff, tables/columns/partitions, sensitivity, explain limitations, heuristic scan range, output bound, result handling, timeout, and cancellation plan. Run `node scripts/validate-preflight.mjs <preflight.json> --allow-unconfirmed`, then obtain explicit confirmation tied to the hash.

**Gate:** any SQL, scope, identity, workgroup, or cost-control change invalidates confirmation and requires a new checkpoint.

### 6. Execute and observe

Use an idempotency token bound to the exact request, bounded backoff/polling, deadline, and cancellation. Do not silently retry with wider scope or altered parameters. Bind the returned query ID to the current session. On timeout/interruption, request cancellation and report the final known state honestly.

### 7. Validate and close

Page results within row/byte bounds, preserve types/nulls, and neutralize spreadsheet formulas in CSV exports. Reconcile row counts, grain, duplicates, nulls, control totals, and approved fields before interpretation. Report query ID, terminal state/reason, rows/truncation, actual scanned bytes, engine time, queue time, reuse status, output handling, and validation limitations. Never persist raw results to the vault automatically.

Run the preflight validator again without `--allow-unconfirmed` for the execution record. It checks record structure only; it does not authorize, parse SQL, inspect IAM/Lake Formation, predict cost, or prove query correctness.

Read [references/athena-safety.md](references/athena-safety.md). Use the repository template at `templates/aws-athena-mcp`; it is not AWS-tested and must be reviewed against the target IAM/Lake Formation configuration.
