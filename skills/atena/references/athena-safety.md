# Athena safety and cost controls

## Authority layers

Treat these as separate questions:

1. May this identity discover catalog/schema metadata?
2. May it read these rows and columns for this purpose?
3. May it disclose the bounded result to this audience/location?
4. May it incur the planned scan cost in this workgroup?

Model/tool approval never substitutes for IAM, Lake Formation, workgroup enforcement, data-owner authorization, or user confirmation.

## Required guards

- Allowlist account, region, catalog, database, workgroup, and dataset prefixes.
- Accept one statement only. Allow conservative `SELECT`, `WITH ... SELECT`, `SHOW`, `DESCRIBE`, and `EXPLAIN SELECT` paths.
- Reject DML, DDL, CTAS, UNLOAD, MSCK, VACUUM, OPTIMIZE, PREPARE, EXECUTE, CALL, `ANALYZE`, and `EXPLAIN ANALYZE`.
- Fail closed when the parser cannot prove compatibility with Athena/Trino grammar.
- Never accept model-supplied output locations or credentials.
- Limit duration, pages, rows, and returned bytes. Bind result query IDs to the current process/session.
- Log query hash, ID, state, scanned bytes, and duration; avoid raw SQL, parameters, and cells.
- Use workgroup limits and least-privilege IAM as hard boundaries. MCP annotations are only hints.
- Bind confirmation to a hash of the exact normalized request and visible SQL. Changing SQL, catalog, database, workgroup, output configuration, or reuse settings requires confirmation again.
- Deny credentials, output locations, role ARNs to assume, arbitrary S3 reads, DDL/DML, named-query administration, and query-history browsing as tool inputs.

Managed Athena results minimize S3 permissions, are encrypted, and expire after 24 hours, but do not support result reuse. A user bucket needs narrow prefixes, encryption, and lifecycle rules.

## Cost and plan evidence

- A result `LIMIT` bounds returned rows, not bytes scanned. It is not a substitute for partition pruning or a workgroup cutoff.
- `EXPLAIN (TYPE IO, FORMAT JSON)` can show read tables/columns and estimates, but estimates can be unavailable or inaccurate. Label any scan range and assumptions as heuristic.
- `EXPLAIN ANALYZE` executes the query and can incur charges. Keep it outside the safe planning path.
- Workgroup per-query scan limits and CloudWatch/budget controls are defense in depth; confirm whether client-side settings are overridden.
- Result reuse can return older data. Record maximum age and freshness acceptance. Managed query results do not support reuse.

## Execution state machine

Record submission, query ID, and each observed state. Bound polling and API pages. `FAILED` and `CANCELLED` are terminal failures, not empty results. On timeout, call cancellation when authorized and report whether the terminal state was actually observed. Do not infer cancellation success from the request alone.

For result validation, preserve Athena types and nulls, account for the header row returned by `GetQueryResults`, enforce result-page/row/byte limits, and bind retrieval to query IDs created by the current trusted session. Sanitize formula-leading cells (`=`, `+`, `-`, `@`, tab, carriage return) before spreadsheet-compatible export, while retaining an auditable raw-to-export transformation outside the vault.

## Evidence record

- identity: account, ARN, region
- scope: catalog, database, workgroup, source tables/columns/partitions
- governance: sensitivity, allowed audience, row/column filtering assumptions
- query: visible SQL, hash, dialect/engine, Prometeu spec and tests
- plan: EXPLAIN output/date, limitations, heuristic range, cutoff
- confirmation: approver, timestamp, hash, accepted exception
- outcome: query ID/state/reason, bytes, timings, reuse, rows/truncation
- verification: grain, duplicates, nulls, totals, schema drift, export handling

## Primary sources

- Athena IAM actions: https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonathena.html
- EXPLAIN: https://docs.aws.amazon.com/athena/latest/ug/athena-explain-statement.html
- Managed results: https://docs.aws.amazon.com/athena/latest/ug/managed-results.html
- Start query: https://docs.aws.amazon.com/athena/latest/APIReference/API_StartQueryExecution.html
- Results: https://docs.aws.amazon.com/athena/latest/APIReference/API_GetQueryResults.html
- Workgroup cost controls: https://docs.aws.amazon.com/athena/latest/ug/workgroups-manage-queries-control-costs.html
- Lake Formation filtering: https://docs.aws.amazon.com/lake-formation/latest/dg/data-filtering.html
- STS identity: https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html
- Query execution states: https://docs.aws.amazon.com/athena/latest/APIReference/API_QueryExecutionStatus.html
- Result reuse: https://docs.aws.amazon.com/athena/latest/ug/reusing-query-results.html
