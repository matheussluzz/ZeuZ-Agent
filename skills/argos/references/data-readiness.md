# Data readiness and leakage threat modeling

Leakage is any path by which training or evaluation uses information unavailable under the real deployment process. It can produce excellent metrics and a useless system.

## Four clocks

Track these separately where relevant:

- **event time** — when the real-world fact occurred;
- **observation/ingestion time** — when the system first received it;
- **available time** — when the value was reliable and queryable for the prediction pipeline;
- **label maturity time** — when the outcome became sufficiently complete for evaluation.

`event_time <= forecast_origin` is insufficient if the data arrived, was corrected, or became reliable later. Use the most conservative reproducible `available_at` rule.

## Data contract

For each source record:

- owner, authority, location, version/snapshot method, retention, and access classification;
- primary/entity keys, row grain, time zone, units, valid range, and duplicate rule;
- event/ingestion/available/correction timestamps and backfill behavior;
- missingness meanings: not observed, not applicable, delayed, suppressed, or truly zero;
- schema evolution and late-arriving-data policy;
- permitted training, hosted inference, storage, and derived-data use.

## Target provenance

Document the label from raw events to final target:

1. raw source and authority;
2. inclusion/exclusion rules;
3. aggregation window relative to forecast origin;
4. censoring, reversals, corrections, and maturity delay;
5. entities without observable labels and selection bias;
6. proxy-label limitations and feedback from prior decisions.

Never let the target window overlap a feature window unless the value would truly be known at prediction time.

## Leakage threat checklist

Inspect these paths explicitly:

- post-outcome statuses, cancellations, recoveries, case closures, or manually entered resolutions;
- aggregate features computed over the full dataset or centered windows;
- imputation, scaling, encoders, target encoding, decomposition, selection, and resampling fit before splitting;
- rolling features not shifted before aggregation;
- revised historical records queried as if their corrected value existed originally;
- entity duplicates, near-duplicates, households/customers/devices, or future visits crossing folds;
- IDs, filenames, timestamps, row ordering, data-source flags, or missingness that encode outcome workflow;
- target-derived features, labels embedded in text, and external model scores trained with unknown cutoffs;
- forecast covariates that are actually forecasts or plans and are replaced by realized future values during evaluation;
- feedback loops where prior model decisions alter who receives labels or treatment.

## Feature inventory schema

The bundled audit accepts CSV with required columns:

```text
feature,forecast_origin,available_at
```

Recommended additional columns:

```text
entity_id,event_time,source,transformation,availability_rule,known_future,owner
```

Every row represents one feature observation at one forecast origin. Use UTC offsets in ISO-8601 timestamps. A blank or unparsable required timestamp fails closed.

## Readiness evidence

Before G1 passes, report:

- history length and usable origins after gaps/label maturity;
- entities/rows by split candidate, missingness, duplicates, and target prevalence/distribution;
- seasonal/regime coverage and known structural breaks;
- feature availability audit counts and representative failures;
- approved privacy/data-transfer boundary;
- unresolved unknowns and their effect on validity.

## Sources

- scikit-learn common pitfalls (inconsistent preprocessing and data leakage): https://scikit-learn.org/stable/common_pitfalls.html
- scikit-learn time-series split behavior: https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html
