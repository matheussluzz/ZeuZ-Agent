---
name: argos
description: Design, compare, validate, and monitor reproducible machine-learning, forecasting, econometric, and simulation systems. Use for temporal or tabular prediction, Chronos-2, TimeGPT, PatchTST, LightGBM, neural networks, VAR/VECM, Monte Carlo, backtests, leakage audits, uncertainty, model cards, or production monitoring.
---

# Argos

Treat modeling as a falsifiable decision process, not a search for an impressive algorithm. Prefer the simplest candidate that clears a predeclared, business-relevant threshold on honest out-of-sample evidence.

## Non-negotiable rules

- Define the real prediction time before touching features or splits.
- Never let the final test influence preprocessing, feature selection, tuning, stopping, threshold selection, or candidate choice.
- Fit every learned transformation inside each training fold.
- Require point-in-time availability evidence for every feature.
- Compare against a decision-relevant naïve or simple baseline.
- Report failures, negative results, cost, latency, uncertainty, and subgroup/regime behavior.
- A foundation-model benchmark or vendor claim is a hypothesis, never project evidence.
- Monte Carlo propagates assumptions; it does not manufacture knowledge about an unknown data-generating process.
- Do not send data to TimeGPT or another hosted service without explicit privacy, legal, cost, and access approval.

## Progressive workflow

Load only the reference needed for the current stage. Preserve each stage artifact so another reviewer can replay the decision.

### Stage 0 — Decision framing

Read [references/workflow.md](references/workflow.md), then create an experiment charter from `assets/experiment-charter.template.json`.

Define:

- decision owner, action, prediction unit, target, forecast origin, horizon, cadence, and lead time;
- asymmetric error costs, capacity or policy constraints, and the current decision process;
- acceptable data use, compute, latency, budget, interpretability, and deployment boundaries;
- primary metric, guardrail metrics, minimum useful improvement, and stop conditions.

**Gate G0:** stop with `NOT_READY` when the target, decision time, evaluation unit, or action is ambiguous. Ask only the questions needed to clear the gate.

### Stage 1 — Data readiness and leakage threat model

Read [references/data-readiness.md](references/data-readiness.md). Build a data contract, target provenance note, feature inventory, and leakage threat model. For temporal work, include event time, ingestion time, correction/revision behavior, and the earliest reliable `available_at` timestamp.

Run:

```bash
python3 scripts/leakage_audit.py feature-inventory.csv
```

**Gate G1:** stop with `DATA_BLOCKED` on unresolved target leakage, unknown availability for a material feature, an invalid label window, insufficient history for the requested split, or prohibited data use. Do not “fix” leakage by merely dropping suspicious columns without explaining the causal path.

### Stage 2 — Evaluation design

Read [references/evaluation-monitoring.md](references/evaluation-monitoring.md). Freeze:

- an untouched final test block;
- expanding or sliding rolling-origin folds with production-realistic horizon and gap;
- entity/group isolation when the same subject can occur across rows;
- metrics, aggregation weights, uncertainty method, comparison rule, and tie-breaker;
- a reproducible pipeline boundary covering all learned transforms.

Use a random split only when records are genuinely exchangeable at deployment. State and defend that assumption.

**Gate G2:** stop with `DESIGN_BLOCKED` when the split cannot emulate deployment or the sample cannot support both tuning and an untouched test.

### Stage 3 — Candidate tournament

Read [references/model-selection.md](references/model-selection.md), then populate `assets/candidate-registry.template.json`. Every candidate must state its hypothesis, preprocessing, search budget, expected resource use, known risks, and elimination rule before results are seen.

Run candidates in tiers:

1. current operational rule, seasonal naïve, mean/median/dummy, and simple statistical or linear baseline;
2. regularized linear/logistic models and LightGBM for tabular/global lag features;
3. domain-justified specialist models: VAR/VECM, Chronos-2, TimeGPT, PatchTST or another RNA;
4. Monte Carlo only for explicit uncertainty propagation or policy/risk simulation.

Do not tune every model equally. Eliminate dominated candidates early using the frozen rule. Carry forward fold-level predictions, timings, warnings, seeds, and environment fingerprints—not just average metrics.

**Gate G3:** a challenger advances only if it clears all guardrails and the predeclared improvement threshold without a material cost, latency, fairness, stability, or privacy regression.

### Stage 4 — Freeze and one-time final test

Lock code, features, hyperparameters, thresholds, ensemble weights, seeds, dependency versions, and the evaluation script. Record the Git commit and data snapshot. Then evaluate the frozen winner once on the untouched block.

If the final result fails, report `FINAL_TEST_FAILED`. Do not iterate on that block or quietly relabel it validation data. A new final test requires genuinely new future data or a newly justified study.

### Stage 5 — Delivery and monitoring

Complete `assets/model-card.template.md` and `assets/monitoring-plan.template.md`. Include:

- intended use and explicit non-uses;
- data lineage, split boundaries, candidates rejected, and evidence table;
- point and probabilistic performance by horizon, entity/group, and regime;
- calibration, uncertainty limitations, operational cost, latency, and rollback;
- input/label drift, delayed outcome quality, coverage, service health, thresholds, owners, and retraining triggers.

**Gate G4:** return `REVIEW_BLOCKED` rather than “production ready” if independent adversarial review cannot inspect the charter, code, data contract, predictions, fold results, and model card.

## Required output contract

Return these headings even when blocked:

1. **Decision and status** — `NOT_READY`, `DATA_BLOCKED`, `DESIGN_BLOCKED`, `EXPERIMENT_READY`, `FINAL_TEST_FAILED`, or `RECOMMENDATION_READY`.
2. **Verified facts / assumptions / unknowns** — clearly separated.
3. **Experiment charter** — frozen choices and unresolved approvals.
4. **Leakage threat model** — feature and label paths plus audit result.
5. **Evaluation design** — cutoffs, folds, gap, horizon, metrics, comparison rule.
6. **Candidate registry** — hypotheses, budgets, results, eliminations.
7. **Recommendation** — baseline is valid; complexity requires evidence.
8. **Limitations and failure modes**.
9. **Reproducibility manifest**.
10. **Model card and monitoring plan**.
11. **Independent review verdict**.

## Deterministic checks

Validate the charter and candidate registry before training:

```bash
python3 scripts/validate_experiment.py \
  --charter experiment-charter.json \
  --registry candidate-registry.json
```

The validators catch structural omissions and obvious temporal contradictions. They do not prove causal validity, statistical power, fairness, or absence of leakage. A human/model reviewer must inspect the actual pipeline and data-generating process.
