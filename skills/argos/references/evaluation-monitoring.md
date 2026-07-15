# Evaluation, uncertainty, calibration, and monitoring

## Split design

Choose splits that simulate the actual information boundary.

### Temporal forecasting

- Use rolling origins with the production horizon.
- Add a gap for feature latency, label overlap, embargo, or operational lead time.
- Use expanding windows when all older history remains relevant; use sliding windows when drift or bounded retention makes old data inappropriate.
- Keep a final contiguous future block untouched until the pipeline and winner are frozen.
- For panels, define minimum history and cold-start policy per series.

### Non-temporal tabular work

Random splits require exchangeability. Use group splits for repeated people/accounts/devices/sites and temporal/out-of-time splits when deployment sees future cohorts. For policy/treatment questions, predictive validation does not establish causal effect.

## Metrics by decision

Predeclare metric direction and aggregation.

- Regression/point forecasts: MAE for absolute error, RMSE when large errors carry extra cost, MASE/RMSSE for scale comparison, bias for systematic direction. Avoid MAPE when actuals can be zero or near zero.
- Quantiles/distributions: pinball loss or CRPS where implemented correctly; report empirical interval coverage, width, and calibration by nominal level.
- Classification: log loss/Brier score for probability quality, discrimination such as ROC-AUC or PR-AUC only when relevant, and precision/recall/cost at a threshold chosen without final-test access.
- Risk/simulation: decision-specific expected loss, quantiles, expected shortfall, constraint-violation probability, and simulation error.

Always report sample counts and metric distribution by horizon, high-value subgroup, scale/volume band, geography/site when lawful, and known regime. Do not average away a deployment-critical failure.

## Comparisons and uncertainty

- Compare candidate and baseline on the same origins/observations.
- Preserve paired loss deltas; quantify their uncertainty with a method appropriate to temporal/group dependence.
- Avoid treating highly overlapping rolling windows as independent observations.
- Distinguish statistical uncertainty, practical relevance, and operational risk.
- Do not promote a challenger based on one favorable seed, one horizon, or one unplanned subgroup.

## Calibration

- For probability estimates, inspect reliability/calibration curves and proper scores on held-out predictions.
- For forecast intervals, compare nominal to empirical coverage and interval width across horizon/regime.
- Fit any calibration mapping using training/validation only and serialize it as part of the pipeline.
- Under shift, historical calibration can fail; monitoring must observe both prediction distribution and delayed realized coverage.

## Reproducibility manifest

Record:

- repository commit and dirty-state note;
- data snapshot/content hash and extraction query/version;
- environment/lockfile, library/model revisions, OS, hardware, dtype/device;
- seeds and nondeterministic operations;
- exact charter/registry versions and command line;
- artifact hashes for fold predictions and final report.

PyTorch documents that complete reproducibility is not guaranteed across releases, commits, platforms, or CPU/GPU execution. Promise replayability within a pinned environment, not universal bit identity.

## Monitoring plan

Monitor four layers:

1. **Data/service:** schema, ranges, missingness, category novelty, lateness, row volume, feature availability, dependency/service latency and errors.
2. **Predictions:** distribution, abstention/fallback rate, interval width, confidence, policy constraints, and segment coverage.
3. **Outcomes:** delayed primary/guardrail metrics, bias, calibration/coverage, business utility, overrides, and harm indicators.
4. **System:** inference latency/cost, memory, version skew, model/API availability, and rollback health.

Every signal needs an owner, cadence, window, baseline, warning/action threshold, response, and escalation path. Prefer sustained or evidence-based triggers over hypersensitive one-point alerts.

Retraining is not the automatic response to drift. Investigate instrumentation, target definition, label delay, policy change, and data-generating shifts first. A retrained model re-enters the evaluation and review gates.

## Sources

- scikit-learn `TimeSeriesSplit`: https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html
- scikit-learn probability calibration: https://scikit-learn.org/stable/modules/calibration.html
- PyTorch reproducibility notes: https://docs.pytorch.org/docs/stable/notes/randomness.html
