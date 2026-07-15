# Prometeu query contract

## Purpose and environment

- Business question and decision:
- Dialect and engine version:
- Authorized catalog/database/workgroup:
- Schema evidence and verified date:
- Data snapshot/freshness:
- Cost ceiling and runtime SLA:

## Output contract

- One row per:
- Unique key:
- Population, exclusions, and denominator:
- Time column, zone, and interval boundaries:
- Required columns/types/units:
- Null, duplicate, tie, and empty-input policy:
- Ordering and result bound:
- Approximation/error tolerance:

## Join and grain ledger

| Stage | Input grain/key | Join/filter/aggregation | Expected output grain | Fanout/row-count check |
| --- | --- | --- | --- | --- |

## Verification cases

| ID | Requirement or edge case | Fixture/control | Expected result | Executable check |
| --- | --- | --- | --- | --- |
| Q-01 | output key is unique | full candidate result | zero duplicate keys |  |

## Optimization hypothesis

- Suspected dominant cost:
- Proposed single change:
- Predicted metric effect:
- Correctness check that detects drift:
- Rollback/fallback:

## Approval and evidence

- Exact SQL hash:
- Plan result/limitations:
- Execution approver and timestamp:
- Baseline/candidate metric records:
- Known limitations:
