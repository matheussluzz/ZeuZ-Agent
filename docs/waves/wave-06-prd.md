# Wave 06 PRD — Specialist agent lifecycle and command surface

Status: review blocked

Branch: `agent/wave-06-specialist-agent-lifecycle`

Frozen contract: `AGENTS.md` and `docs/roadmap_candidate.md`, especially D03, the specialist profile contract, the terminal event contract, and the Wave 06 exit criteria.

## Outcome

Make the reviewed Pantheon and explicitly installed capabilities observable and controllable without creating a second authority or bypassing Wave 04/05 safety guarantees.

## Requirements

1. **Persona catalog.** Keep the eight built-in Pantheon personas provider-neutral: Argos, Hefesto, Metis, Medusa, Atena, Clio, Prometeu, and Hermes. Each profile declares purpose, composable skill names, intent triggers, execution policy, capability requirements, and reviewer separation.
2. **Deterministic routing.** Explicit persona commands take precedence. Automatic routing is metadata-only, deterministic, and reports the selected persona, reason, execution mode, model, and reviewer family. Ambiguous automatic matches are not silently combined.
3. **In-process versus spawn.** Short automatic intents may run in the current controller. Explicit persona invocation defaults to a durable spawned task. Spawned tasks use the existing versioned task engine and remain cancellable and retrievable.
4. **Root ownership.** Only the root orchestrator can create specialist tasks. A worker/persona can return a typed capability request to the root; it cannot recursively spawn a persona or silently elevate permissions.
5. **Skill command surface.** `/argos`, `/hefesto`, `/metis`, `/medusa`, `/atena`, `/clio`, `/prometeu`, and `/hermes` are the only top-level persona commands. `/skill` searches the complete non-Pantheon catalog by metadata; `/skill <id> [task]` activates a selected non-Pantheon skill. Non-Pantheon skills receive no top-level aliases.
6. **Dependency activation.** Explicit persona/skill activation goes through the Wave 05 resolver so dependency closure, trust, enablement, budget, path, and integrity checks remain authoritative.
7. **Messages and lifecycle.** Follow-ups are redacted, versioned, atomically persisted, consumed only by the owning task turn, and remain queued when provider-native live input is unavailable. A live-input adapter hook is opt-in and never inferred from a provider name.
8. **Documentation and tests.** New commands have help text, README documentation, parser/controller/task tests, and failure coverage for ambiguity, disabled/quarantined skills, root-only spawn, duplicate message delivery, cancellation, and result retrieval.

## Non-goals

- Interactive startup/model-picker redesign, workflow tree rendering, or Assistant UI integration (Wave 07).
- Health-aware dynamic model catalogs and quota telemetry (Wave 10).
- MCP transport/catalog and external integration authority (Wave 11).
- Telegram remote messaging (Wave 12).
- Automatic enablement or execution of quarantined third-party skills.

## Safety invariants

- The controller, task engine, permission policy, review gate, and private state repository remain the sole authorities.
- Persona instructions are untrusted reference context. They cannot override `AGENTS.md`, permission mode, secret redaction, reviewer separation, or writable boundaries.
- A worker capability request is data routed back to the root, not a provider command.
- A queued follow-up is not reported as live-delivered unless an executor explicitly proves support and successful delivery.
- Existing `REVIEW_BLOCKED` and workspace evidence rules remain fail-closed.

## Rollback

Disable automatic/explicit specialist routing and leave the existing controller, Wave 05 in-process skill activation, and `zeuz delegate` task commands available. Follow-up records can be retained for inspection; no catalog files or user data are deleted.

## Acceptance evidence

- Unit tests cover persona profiles/routing, command exclusivity, catalog search/activation, root gating, durable message semantics, and task integration.
- `pnpm check`, `pnpm build`, `node bin/zeuz health`, and `git diff --check` pass.
- A fresh read-only independent review returns `PASS`; unavailable reviewer surfaces remain `REVIEW_BLOCKED`. Implementation and technical checks are complete, but the Cursor Grok 4.6 and Composer 2.5 review attempts did not return a final verdict in this run.
