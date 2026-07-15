# Model card: <model/system name>

## Status and ownership

- Version:
- Owner / approver:
- Date / repository commit / data snapshot:
- Status: experimental | shadow | production | retired
- Independent review verdict and evidence packet:

## Decision and intended use

- Decision or action supported:
- Prediction unit, forecast origin, horizon, and lead time:
- Intended users and operating context:
- Required human judgment / override:
- Explicit non-uses and prohibited populations/actions:

## Data and labels

- Sources, owners, licenses, privacy classification:
- Entity/grain/time-zone contract:
- Target construction, maturity delay, corrections, censoring:
- Feature availability rules and leakage-audit result:
- Training / validation / untouched-test boundaries:
- Missingness, selection bias, coverage gaps, known shifts:

## Model and pipeline

- Candidate family, implementation, pinned revisions:
- Preprocessing and inference information boundary:
- Hyperparameters / search budget / seeds:
- Point, quantile, probability, or simulation outputs:
- External services, data transfer, cost, latency, compute:

## Evaluation evidence

| Candidate | Fold/origin evidence | Primary metric | Guardrails | Calibration | Latency/cost | Decision |
| --- | --- | ---: | --- | --- | --- | --- |
| Current process / baseline |  |  |  |  |  |  |
| Selected candidate |  |  |  |  |  |  |

- Minimum useful improvement and whether it was cleared:
- Paired uncertainty / sensitivity result:
- Performance by horizon, entity/group, scale, and regime:
- Untouched final-test result and reveal timestamp:
- Negative/failed candidates preserved at:

## Limitations and failure modes

- Assumptions the evidence depends on:
- Known blind spots, unsupported extrapolations, cold-start behavior:
- Privacy, fairness, safety, feedback-loop, and misuse risks:
- Uncertainty/calibration limits:
- Foundation-model pretraining uncertainty or hosted-service reproducibility limits:
- Conditions that invalidate the evaluation:

## Operational controls

- Runtime dependencies and environment fingerprint:
- Input validation / abstention / fallback behavior:
- Versioning, access, logging (without secrets), rollback:
- Monitoring plan link, owners, thresholds, incident path:
- Retraining and re-review trigger:

## Reproducibility manifest

- Commands and configuration:
- Repository/data/environment identifiers:
- Prediction/result artifact hashes:
- Nondeterministic operations and replay tolerance:
