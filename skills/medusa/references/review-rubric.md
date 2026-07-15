# Review rubric and calibration

## Lens selection

Apply every core lens, then add artifact-specific checks.

| Artifact | Required additional checks |
| --- | --- |
| Code / CLI | error paths, cancellation, concurrency, portability, dependency behavior, user-visible claims |
| Configuration / installer | idempotence, permissions, platform detection, rollback, partial failure, secret handling |
| SQL / data | grain, join cardinality, nulls, temporal boundaries, scan cost, authorization |
| ML / forecast | leakage, split integrity, baseline, uncertainty, reproducibility, deployment skew |
| Document / dashboard | factual fidelity, accessibility, offline behavior, licensing, misleading visual encoding |
| Research | source identity, primary-source priority, recency, independence, contradiction, entailment |
| Migration / release | backward compatibility, rollback, state transitions, versioning, packaging, clean install |

## Severity

- `CRITICAL`: credible secret exposure, unauthorized destructive/external action, safety-critical falsehood, or release-blocking compromise with broad impact.
- `HIGH`: material requirement failure, privilege/path boundary violation, data loss/corruption, exploitable vulnerability, or a central unsupported conclusion.
- `MEDIUM`: real defect with bounded impact, important regression, portability/failure-handling gap, or materially misleading documentation.
- `LOW`: localized actionable defect whose correction improves correctness or maintainability without changing the central outcome.

Do not encode style preference as a finding unless it violates an explicit contract or creates observable risk.

## Evidence strength

Prefer evidence in this order:

1. reproducible failing command or minimal counterexample;
2. direct artifact inspection tied to an exact location and behavior;
3. authoritative specification/source applied to the artifact;
4. reasoned risk with explicit assumptions.

Label the fourth category as a hypothesis and use it to request verification, not to assert a defect. A model's confidence, majority vote, or repeated source origin does not raise evidence strength.

## Candidate-finding calibration

For each candidate:

1. State the violated criterion or invariant.
2. Produce the shortest reproduction or evidence path.
3. Search for evidence that the behavior is intentional, guarded, or already tested.
4. Distinguish current defect from speculative future risk.
5. Merge duplicates by root cause.
6. Drop the finding if it cannot survive this challenge; use `UNVERIFIED`/`REVIEW_BLOCKED` when missing access prevents resolution.

Calibrate judge prompts against human-labeled happy paths, edge cases, and real failures. Model judges can exhibit position, verbosity, and familiarity bias. Do not use the same producer output as both the artifact and the grading rubric.

## Verdict gates

`PASS` is prohibited by any of:

- a required criterion not marked `MET`;
- any retained actionable finding;
- a required deterministic check marked `FAIL` or `BLOCKED`;
- a changed behavior with an open verification gap;
- same-family reviewer or unknown producer/reviewer family;
- stale artifact fingerprint;
- exposed secret or workspace escape;
- nonexistent/inaccessible critical source, or citation that does not entail a material claim.

`CHANGES_REQUIRED` needs actionable evidence. `REVIEW_BLOCKED` is not a softer failure; it is the only honest verdict when evidence cannot support either pass or defect.

## Primary sources

- NIST AI RMF Core (measurement, documentation, independent assessors): https://airc.nist.gov/airmf-resources/airmf/5-sec-core/
- NIST Generative AI Profile: https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf
- OpenAI evaluation best practices (task-specific evals, criteria, edge cases): https://developers.openai.com/api/docs/guides/evaluation-best-practices
- Anthropic evaluation guidance (specific measurable criteria, code/human/model graders): https://platform.claude.com/docs/en/test-and-evaluate/develop-tests
