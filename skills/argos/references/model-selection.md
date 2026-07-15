# Candidate registry and selection rules

Use this reference only after the experiment charter, data readiness gate, and evaluation design are frozen. A candidate enters the tournament because it tests a concrete hypothesis, not because it is fashionable.

## Registry fields for every candidate

- stable candidate ID, family, implementation/library version, and license/deployment constraints;
- hypothesis: what structure should this candidate capture that a simpler baseline misses;
- required history, covariates, preprocessing, target transformation, and missing-data behavior;
- search space and hard trial/time/compute budget declared before results;
- output type: point, quantile, distribution, class probability, scenario, or policy metric;
- expected train/inference cost, memory, latency, external data transfer, and operational dependencies;
- known failure modes and the exact elimination/advance rule;
- fold-level artifact paths, warnings, failures, and reproducibility fingerprint.

## Candidate matrix

### Operational, naïve, and statistical baselines

Always include the current business rule when one exists. For forecasting, include last value and seasonal naïve when meaningful; add drift, moving average, exponential smoothing, or a simple autoregression when justified. For classification/regression, include dummy/mean/median and a regularized linear/logistic model.

Baselines establish whether predictability and operational value exist. Never omit them because their simplicity makes a complex result look less impressive.

### LightGBM

Use as a strong tabular/global-forecasting candidate for nonlinear interactions, mixed feature scales, lags, rolling statistics, calendar variables, and known covariates.

- Shift lags and rolling aggregates so their windows end before the forecast origin.
- Encode availability and missingness according to production behavior.
- Bound `num_leaves`, depth, minimum leaf data, feature/bagging fractions, and boosting rounds; leaf-wise growth can overfit small data.
- Perform early stopping only on the fold validation segment, never the final test.
- Prefer time-aware permutation/ablation and stable effects to unsupported causal claims from feature importance or SHAP.
- Verify the full serialized preprocessing-plus-model path and inference latency.

### Chronos-2

Treat Chronos-2 as a local zero-shot foundation-model challenger. The official project currently lists a 120M `amazon/chronos-2` model and supports univariate, multivariate, covariate-informed, and quantile forecasting. Its code and published weights are Apache-2.0 at the time of this review.

- Pin model revision, package version, device, dtype, context length, prediction length, quantiles, and batch behavior.
- Verify covariate availability separately for past and known-future covariates.
- Test on the private rolling-origin benchmark; upstream benchmarks are not evidence for the user's distribution.
- Record download/weight provenance and validate offline/deployment constraints.
- State that unknown pretraining overlap may contaminate a public-dataset comparison.
- Compare accuracy, calibration, inference cost, latency, memory, and failure behavior against simple baselines.

### TimeGPT-2 / TimeGPT-2.1

Treat these as hosted or enterprise-deployed closed-model challengers. Current Nixtla documentation says access must be confirmed, an API key is required, and client version 0.7.0 or newer is needed for the TimeGPT-2 family. Public technical-paper evidence commonly cited for TimeGPT may describe an earlier family member; do not transfer those claims without qualification.

Before any request, require recorded approval for:

- service/model access and API credits;
- data classification, region, retention, contractual/privacy review, and external transfer;
- experiment budget and retry policy;
- reproducible request payload schema with secrets excluded from logs.

Never serialize the API key into the charter, model card, prediction artifacts, notebook, or vault. Rate limits, service version changes, and closed weights reduce reproducibility; report them as such.

### PatchTST and other neural networks

PatchTST's paper describes patching subseries into tokens and channel-independent shared weights. Consider it or another RNA only when history, number of series, horizon, and compute can support a meaningful comparison.

- Declare context/patch/stride/horizon, architecture, initialization, optimizer, learning-rate schedule, batch size, epochs, early stopping, and maximum budget.
- Fit normalization and sampling inside each fold. Do not construct windows before the split if that lets labels or statistics cross the boundary.
- For global models, test cold-start/short-series behavior and series-identity leakage.
- Repeat enough seeded runs to expose material optimization variance; preserve failed runs.
- Compare against LightGBM and simple statistical baselines under the same information set.
- Use maintained libraries for production unless paper code is independently audited.

Other RNAs such as N-HiTS, TFT, recurrent networks, or MLPs need an explicit structural hypothesis. Attention weights are not automatically explanations.

### VAR and VECM

Use for a small multivariate system when joint dynamics and interpretation matter. VAR generally assumes a suitable stationary representation. A VECM is appropriate only when nonstationary variables and a defensible cointegration structure are supported.

- Choose variables from the decision problem, not a significance fishing expedition.
- Evaluate transformations, integration order, lags, deterministic terms, seasonality, structural breaks, and exogeneity assumptions inside each training window.
- Select cointegration rank inside the training fold; never use future observations to choose it.
- In statsmodels, `k_ar_diff` is the number of lagged differences and `coint_rank` is the rank of the cointegration matrix; deterministic terms inside/outside the relation are materially different specifications.
- Check stability, residual autocorrelation, heteroskedasticity/non-normality as relevant, parameter plausibility, and sensitivity to lag/rank/deterministic choices.
- Label impulse responses and variance decompositions as conditional on identification assumptions, not causal facts.

### Monte Carlo

Use Monte Carlo for propagating explicitly modeled aleatory, parameter, and scenario uncertainty into decision outcomes. It is not a substitute for a predictive model or missing evidence.

- Define every stochastic input, distribution, parameter source, dependence structure, tail assumption, and scenario weight.
- Separate process variability, parameter uncertainty, model uncertainty, and chosen stress scenarios.
- Preserve dependencies and temporal structure; independent marginal sampling can produce impossible worlds.
- Predeclare convergence diagnostics for the decision statistic, not merely a large round number.
- Use seeded random-number streams, record generator/version, and test sensitivity to seed, sample size, distributions, correlations, and tails.
- Report quantiles/expected shortfall or decision-relevant risk metrics with Monte Carlo standard error or repeated-run stability.
- Keep scenario probabilities distinct from narrative severity when probabilities are unknown.

## Tournament decision rule

Use paired fold/origin predictions wherever possible. Report the distribution of deltas against the baseline, not only separate averages. A model advances only when it:

1. clears the primary predeclared improvement threshold;
2. passes every guardrail and mandatory subgroup/regime check;
3. remains acceptable under sensitivity analysis;
4. fits the privacy, license, compute, latency, cost, and operational envelope;
5. offers sufficient value to justify its additional failure modes.

When evidence is tied or unstable, recommend the simpler baseline or a time-boxed data-collection experiment.

## Primary sources checked 2026-07-14

- Chronos official repository and model inventory: https://github.com/amazon-science/chronos-forecasting
- Chronos-2 technical report: https://arxiv.org/abs/2510.15821
- TimeGPT-2 family official documentation: https://www.nixtla.io/docs/forecasting/timegpt_2_family
- PatchTST paper (ICLR 2023): https://arxiv.org/abs/2211.14730
- LightGBM official parameter-tuning guide: https://lightgbm.readthedocs.io/en/latest/Parameters-Tuning.html
- statsmodels VECM API: https://www.statsmodels.org/stable/generated/statsmodels.tsa.vector_ar.vecm.VECM.html
