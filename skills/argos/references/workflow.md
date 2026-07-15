# Experiment workflow and decision gates

Argos uses a progressive, evidence-preserving workflow. Complete one stage and record its artifact before loading the next. Do not let later results rewrite earlier success criteria.

## G0: decision framing

Answer these questions in plain language:

1. What action will change because of the output?
2. Who makes that action, at what cadence, and with what lead time?
3. What is one prediction row/entity/time pair?
4. What exactly is the target, and when does it become final enough to evaluate?
5. At what timestamp must every input have been knowable?
6. What do false positives, false negatives, overforecasting, and underforecasting cost?
7. What is the current rule/baseline and its measured performance?
8. What improvement is large enough to change a decision after operational costs?

If any answer changes target construction, temporal cutoff, evaluation unit, or metric, stop and confirm it.

## Experiment charter freeze

The charter is the compact source of truth. Version changes rather than silently editing it. Each change after first results must explain why it is not outcome-driven and whether prior results remain comparable.

Minimum freeze:

- `prediction_unit`, `target`, `forecast_origin_definition`, `horizon`, `lead_time`, and `label_maturity_delay`;
- train/validation/final-test boundaries and production-realistic gap;
- primary metric, direction, minimum useful improvement, guardrails, subgroup/regime views;
- candidate tiers and per-candidate trial/time/compute limits;
- data/privacy/license/deployment approvals;
- stop, rollback, and final-selection rules.

The deterministic validator checks required structure, not the truth of the entries.

## G1: data readiness

Produce:

- a data contract with owner, source, key, grain, timestamps, revision behavior, units, ranges, and missingness semantics;
- target provenance from raw event through label and maturity delay;
- feature inventory with transformation and `available_at` derivation;
- coverage/history table by entity/regime;
- leakage threat model and prohibited feature paths.

Do not proceed while a material feature's availability is guessed.

## G2: evaluation readiness

Draw the actual timeline. Show train end, gap, validation origin, forecast horizon, label-maturity boundary, and final-test block. For panel data, show whether entities recur across folds and why that matches deployment.

Reject a design that cannot be replayed from explicit cutoff timestamps.

## G3: tournament execution

Run the frozen pipeline for each candidate/fold. Persist:

- configuration and environment fingerprint;
- train/validation row counts and date/entity ranges;
- point/quantile/probability predictions keyed to observation IDs;
- fold metrics, calibration diagnostics, runtime, peak memory when available, cost, warnings, and exceptions;
- an outcome-independent reason for every elimination.

Failed trials are evidence. Do not delete them from the registry.

## G4: recommendation and handoff

The evidence packet must let an independent reviewer trace:

`decision → charter → data/availability → split → pipeline → predictions → metrics → comparison → recommendation → monitoring`

Any broken link is a verification gap. Name it and downgrade the status rather than filling it with confidence.

## Change-control rules

- Before results: charter changes are allowed with a dated rationale.
- During validation: a necessary correction invalidates affected comparisons; rerun all affected candidates.
- After final-test reveal: no tuning. Report the failure and wait for future data or initiate a new explicitly exploratory study.
- In production: a material feature, target, policy, population, dependency, or threshold change creates a new model version and review.
