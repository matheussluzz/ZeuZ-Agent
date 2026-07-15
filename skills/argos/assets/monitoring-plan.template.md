# Monitoring plan: <model/system name>

## Operating contract

- Owner / on-call / business decision owner:
- Model and pipeline version:
- Serving cadence, SLO, expected volume, and label delay:
- Fallback and rollback target:
- Dashboard / logs / runbook / incident links:

## Signals and actions

| Layer | Signal and segment | Window/cadence | Reference | Warning threshold | Action threshold | Response and owner |
| --- | --- | --- | --- | --- | --- | --- |
| Data | Schema/range/missingness/lateness |  |  |  |  |  |
| Service | Availability/latency/cost/version |  |  |  |  |  |
| Prediction | Distribution/coverage/interval width/fallback |  |  |  |  |  |
| Outcome | Primary metric/bias/calibration/business utility |  |  |  |  |  |
| Harm | Critical subgroup or constraint guardrail |  |  |  |  |  |

## Delayed outcomes

- Label source and maturity rule:
- Backfill/correction handling:
- Earliest trustworthy evaluation window:
- Coverage bias for missing/unobserved outcomes:
- Reconciliation between online and offline metrics:

## Response protocol

1. Validate telemetry, schema, label pipeline, and version identity.
2. Identify affected windows, entities, decisions, and downstream harm.
3. Invoke fallback/rollback or pause when an action threshold is crossed.
4. Preserve inputs, predictions, outcomes, logs, and versions for replay without secrets.
5. Diagnose instrumentation, target/policy change, data shift, and model failure separately.
6. Retrain only through a new charter version, temporal evaluation, final test, and independent review.

## Review cadence

- Threshold calibration review:
- Model card / data contract review:
- Access/privacy/license review:
- Disaster-recovery and rollback exercise:
- Retirement criteria:
