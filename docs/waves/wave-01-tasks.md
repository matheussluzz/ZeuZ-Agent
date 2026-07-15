# Wave 01 task list

This checklist is the persistent execution record for Wave 01. Check an item only after inspecting evidence.

## Brainstorming

- [x] Bootstrap repository context in the required order.
- [x] Verify clean starting worktree and create the Wave 01 branch from updated `main`.
- [x] Read the frozen Wave 01 contract and characterize controller, adapters, stores, command handling, and existing tests.
- [x] Run provider health before delegation and record route degradation honestly.
- [x] Freeze requirements, non-goals, risks, acceptance criteria, and rollback in the PRD.

## Architecture

- [x] Add deterministic clock, ID, and fingerprint interfaces with production defaults.
- [x] Add injectable adapter registry/factory and process boundaries without changing zero-argument behavior.
- [x] Add injectable session/task stores and controller dependencies without a state migration.
- [x] Extract the UI-independent command parser/dispatcher foundation only.
- [x] Define sanitized fixture formats and an explicitly gated real-smoke entry point.

## Engineering

- [x] Add characterization tests before production seam changes.
- [x] Cover default primary and explicit session-model selection.
- [x] Cover safe primary fallback and prove changed/unmeasurable workspaces are never replayed.
- [x] Cover mandatory review, remediation/re-review, and persistence.
- [x] Add valid, invalid, alias, and ambiguous command parser/dispatcher tests.
- [x] Add sanitized fixtures/tests for Codex, Cursor, Claude, Copilot, Agy, and NVIDIA.
- [x] Add compatibility-wrapper and rollback tests/documentation.
- [x] Add opt-in real adapter smokes outside deterministic CI.
- [x] Open the draft PR after the first reviewed commit; keep body, commits, and checks current.

## Reviewer

- [x] Run focused deterministic tests.
- [x] Run `pnpm secrets:check` before every commit and push, recording policy blockers.
- [x] Run `pnpm check`, `pnpm build`, and `node bin/zeuz health` without bypassing supply-chain policy.
- [x] Run proportional opt-in real smokes only after a fresh health check and report them separately.
- [ ] Attempt the official Medusa flow and preserve formal `REVIEW_BLOCKED` if sensitive-template classification blocks it.
- [ ] Obtain a fresh read-only adversarial review from a different model family.
- [ ] Remediate every valid finding and obtain a second review when required.

## Optimizer

- [ ] Remove duplicated test harness code and unnecessary abstractions.
- [ ] Confirm unit/CI paths do not start Ink, providers, network, credential reads, or quota-consuming calls.
- [ ] Inspect staged, unstaged, and untracked files for scope and private data.
- [ ] Update the draft PR description/checks and compact `handoff.md` before delivery.
- [ ] Deliver branch, commits, PR link, executed evidence, review verdict, degradations, and blockers.
