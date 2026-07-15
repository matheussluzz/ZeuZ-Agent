# BMAD adaptation review

Reviewed on 2026-07-14 at upstream commit `1cd4a7f5c06421727d779cbb3f3b5953b4c7282d`.

Upstream: https://github.com/bmad-code-org/bmad-method

License: MIT, copyright BMad Code, LLC. BMAD names are trademarks; ZeuZ does not use them as product branding. This repository adapts workflow ideas and does not vendor BMAD source code.

## Patterns adopted

| ZeuZ skill | Adapted pattern | ZeuZ-specific constraint |
| --- | --- | --- |
| Medusa | Fresh-context adversarial posture, mechanical edge-path pass, verification-gap tracing, layered review | No forced issue quota; evidence-backed `PASS` remains possible; cross-family reviewer and fingerprint are mandatory |
| Hermes | Audience-first concept explanation with examples/diagrams | Semantic invariants prevent business-language simplification from changing facts or uncertainty |
| Hefesto | Checkpoint preview: orientation, walkthrough, detail, testing, wrap-up | Data reconciliation, security, accessibility, offline mode, and Highcharts licensing gates are mandatory |
| Atena | Ordered micro-steps and a human checkpoint before consequential action | Athena `SELECT` is explicitly treated as chargeable and IAM write-classified |
| Clio | Lean project context containing non-obvious implementation rules; indexed documentation | Obsidian wikilink validation, privacy, sensitivity, and source citations are added |
| Prometeu | Spec-first workflow and verification-gap thinking | Query grain/schema/cost evidence and Athena-specific scan controls are mandatory |
| Argos | Clarify → plan → execute → review with readiness gates | Temporal leakage, untouched test data, baseline tournament, privacy, and model-card evidence are mandatory |
| Metis | Confirm research scope, load steps progressively, synthesize after section completion | Primary-source hierarchy, claim ledger, entailment validation, uncertainty labels, and Medusa source replay are mandatory |

## Patterns deliberately rejected

- A mandatory minimum number of findings. It can manufacture noise or hallucinated defects.
- Loading all workflow files at once. ZeuZ uses skill metadata, then `SKILL.md`, then only relevant references/scripts.
- Checkpoints for every minor action. ZeuZ pauses only for choices that materially change scope, cost, privacy, external effects, or risk.
- Framework-specific project folders and trademarks. ZeuZ keeps its own `users/`, `vault/`, `skills/`, and provider-neutral orchestration.

Relevant upstream documents:

- https://github.com/bmad-code-org/bmad-method/blob/main/docs/explanation/adversarial-review.md
- https://github.com/bmad-code-org/bmad-method/blob/main/docs/explanation/advanced-elicitation.md
- https://github.com/bmad-code-org/bmad-method/blob/main/docs/explanation/project-context.md
- https://github.com/bmad-code-org/bmad-method/blob/main/docs/explanation/preventing-agent-conflicts.md
- https://github.com/bmad-code-org/bmad-method/tree/main/src/core-skills
