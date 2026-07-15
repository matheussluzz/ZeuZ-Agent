# BMAD import and adaptation review

Reviewed on 2026-07-14 at upstream commit `1cd4a7f5c06421727d779cbb3f3b5953b4c7282d`.

Upstream: https://github.com/bmad-code-org/BMAD-METHOD

License: MIT, copyright BMad Code, LLC. BMAD names are trademarks; ZeuZ does not use them as product branding or imply upstream endorsement.

The earlier 2026-07-14 decision not to vendor BMAD source was superseded by Matheus on 2026-07-15. ZeuZ may import and adapt the complete public BMAD skill catalog. Every import must pin its upstream revision, retain the MIT copyright and permission notice, record provenance and prior/ZeuZ modifications, inventory file-level license overrides, remain disabled until validation, and arrive through an inspectable independently reviewed sync diff. Protected BMAD names may appear for factual attribution and provenance, not as ZeuZ product branding.

The import permission does not make upstream instructions trusted runtime policy. ZeuZ still validates manifests, dependencies, tools, scripts, network access, secrets, permissions, context budgets, and conflicts before enabling an imported skill.

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
- Replacing ZeuZ's own `users/`, `vault/`, runtime state, or provider-neutral orchestration with BMAD project-state conventions, and using protected BMAD marks as ZeuZ product branding. Vendored skill directories may retain or adapt their upstream structure under the import policy above.

Relevant upstream documents:

- https://github.com/bmad-code-org/BMAD-METHOD/blob/main/docs/explanation/adversarial-review.md
- https://github.com/bmad-code-org/BMAD-METHOD/blob/main/docs/explanation/advanced-elicitation.md
- https://github.com/bmad-code-org/BMAD-METHOD/blob/main/docs/explanation/project-context.md
- https://github.com/bmad-code-org/BMAD-METHOD/blob/main/docs/explanation/preventing-agent-conflicts.md
- https://github.com/bmad-code-org/BMAD-METHOD/tree/main/src/core-skills
