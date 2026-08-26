# Wave 06 tasks — Specialist agent lifecycle and command surface

Branch: `agent/wave-06-specialist-agent-lifecycle`

## Planning and characterization

- [x] Bootstrap AGENTS, user profile, handoff, vault Home, and on-demand progress history.
- [x] Confirm current Cursor model catalog: Grok 4.6 and Composer 2.5 are available for the independent review attempt.
- [x] Write the Wave 06 PRD and this task checklist.
- [x] Add characterization tests for baseline command, controller, and task behavior.

## Specialist catalog and routing

- [x] Add provider-neutral Pantheon persona profiles and deterministic intent routing.
- [x] Define in-process versus durable-spawn policy and routing evidence.
- [x] Enforce root-owned specialist spawning and typed capability requests.
- [x] Preserve cross-family reviewer selection for specialist execution.

## Skill command surface

- [x] Expose the complete non-Pantheon metadata catalog for search without loading bodies.
- [x] Add `/skill` search/selection and `/skill <id> [task]` activation.
- [x] Add only the eight Pantheon persona commands; reject non-Pantheon top-level aliases.
- [x] Reuse Wave 05 dependency, trust, enablement, budget, path, and integrity gates.

## Durable lifecycle and messaging

- [x] Add redacted, versioned follow-up message records with atomic claim/delivery.
- [x] Integrate queued follow-ups into task execution and expose task message CLI commands.
- [x] Support provider-native live input only through an explicit executor capability hook.
- [x] Preserve cancellation, result retrieval, and review/workspace evidence semantics.

## Docs, verification, and review

- [x] Update README and CLI/UI help with examples and failure behavior.
- [x] Run targeted tests, then `pnpm check`, `pnpm build`, `node bin/zeuz health`, and `git diff --check`.
- [ ] Obtain fresh Cursor Grok 4.6 read-only adversarial review; use Composer 2.5 only if Grok fails.
- [x] Remediate the initial Composer 2.5 `CHANGES_REQUIRED` findings; the required repeat review remains blocked because Cursor did not return a verdict.
- [x] Append the final progress checkpoint and rewrite the minimal handoff capsule.

Review state: `REVIEW_BLOCKED`. Grok 4.6 high, Grok 4.6 high-fast, Composer 2.5, and Composer 2.5-fast were attempted through Cursor without a final response; a direct Claude Fable attempt was also unavailable because its OAuth session had expired. No timeout or authentication failure was interpreted as approval.
