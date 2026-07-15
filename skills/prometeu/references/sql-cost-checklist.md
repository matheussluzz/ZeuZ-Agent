# SQL correctness and cost verification

## Contract before query

- Define one output row in plain language and its unique key.
- Define population, denominator, exclusions, time zone, inclusive/exclusive boundaries, late-arriving data, freshness, and comparison period.
- Record schema source/version, key constraints (verified rather than assumed), parameter values, and data snapshot.
- State null, duplicate, tie, overflow/precision, and empty-input behavior.
- Decide whether ordering is part of the contract. SQL results are unordered without `ORDER BY`.

## Correctness traps

| Area | Failure to test |
| --- | --- |
| Joins | duplicate keys causing fanout; dropped unmatched rows; null keys; type/collation mismatch |
| Aggregation | wrong pre/post-join grain; average of averages; denominator drift; double counting |
| Time | UTC/local boundary; daylight-saving transition; partition date differs from event time; late records |
| Nulls | `NOT IN` with null; three-valued logic; missing converted to zero; null ordering |
| Windows | nondeterministic ties; wrong frame (`ROWS` vs `RANGE`); filter before/after window |
| Deduplication | arbitrary survivor; event-time versus ingestion-time winner; changed payload |
| Set operations | `UNION` hiding duplicates; type coercion; branch grain mismatch |
| Numerics | integer division; decimal scale; floating comparison; divide-by-zero |

Build adversarial fixtures or checks for empty input, one row, duplicates on each join side, null keys/values, boundary timestamps, out-of-order arrivals, extreme values, and ties. Row-count equality alone does not prove equivalence.

## Optimization evidence

- Verify dialect, schema, grain, time range, freshness, and uniqueness assumptions.
- Select required columns only; no `SELECT *` in production analysis.
- Filter partition keys directly and cover both event timestamp and date partition when required.
- Predict and test join cardinality; avoid accidental many-to-many joins.
- Put the larger probe relation left and smaller build relation right for Athena hash joins.
- Avoid cross/non-equi joins, repeated wide windows, unnecessary sorts, and `UNION` when `UNION ALL` is correct.
- Use top-N instead of full sort where possible. Consider `max_by`, `min_by`, and `arbitrary` only with correct semantics.
- Treat result reuse as potentially stale and require an accepted staleness window.
- Recommend Parquet/ORC, compression, compact files, and query-oriented partitioning when layout dominates cost.
- Compare actual bytes and duration with a baseline before claiming optimization.
- Keep workload, parameters, data snapshot, engine/workgroup, cache/reuse settings, concurrency, and output semantics comparable. If not comparable, label the result directional only.
- `LIMIT` bounds returned rows but normally does not guarantee a lower Athena scan. Use partition projection/pruning, column projection, layout, and workgroup cutoffs.
- Separate engine time, queue time, and wall time. A faster wall time under different concurrency is weak optimization evidence.
- Record regressions as well as gains: bytes, latency, memory/spill, precision, freshness, maintainability, and portability.

## Verification-gap trace

For every requirement or optimization, identify an artifact and a failing check:

| Contract/change | Evidence | Check that would fail on regression |
| --- | --- | --- |
| one row per customer/day | final key columns and grain note | duplicate-key count equals zero |
| exclude cancelled orders | status rule/source | fixture/control total for cancelled population |
| partition pruning | direct partition predicate and EXPLAIN | plan shows intended partitions; measured bytes |
| pre-aggregate before join | before/after grain | totals, nulls, fanout, representative records |

If no check could distinguish the candidate from a wrong result, the verification plan has a gap.

Primary AWS references:

- Query optimization: https://docs.aws.amazon.com/athena/latest/ug/performance-tuning-query-optimization-techniques.html
- Data layout: https://docs.aws.amazon.com/athena/latest/ug/performance-tuning-data-optimization-techniques.html
- Result reuse: https://docs.aws.amazon.com/athena/latest/ug/reusing-query-results.html
- Partitioning: https://docs.aws.amazon.com/athena/latest/ug/ctas-partitioning-and-bucketing-what-is-partitioning.html
- Athena EXPLAIN: https://docs.aws.amazon.com/athena/latest/ug/athena-explain-statement.html
- Trino SELECT semantics: https://trino.io/docs/current/sql/select.html
