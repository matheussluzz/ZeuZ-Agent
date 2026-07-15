# Wave 01 task list

This checklist is the persistent execution record for Wave 01. Check an item only after inspecting evidence.

## Brainstorming

- [x] Bootstrap repository context in the required order.
- [x] Verify clean starting worktree and create the Wave 01 branch from updated `main`.
- [x] Read the frozen Wave 01 contract and characterize controller, adapters, stores, command handling, and existing tests.
- [x] Run provider health before delegation and record route degradation honestly.
- [x] Freeze requirements, non-goals, risks, acceptance criteria, and rollback in the PRD.

## Architecture

- [ ] Add deterministic clock, ID, and fingerprint interfaces with production defaults.
- [ ] Add injectable adapter registry/factory and process boundaries without changing zero-argument behavior.
- [ ] Add injectable session/task stores and controller dependencies without a state migration.
- [ ] Extract the UI-independent command parser/dispatcher foundation only.
- [ ] Define sanitized fixture formats and an explicitly gated real-smoke entry point.

## Engineering

- [ ] Add characterization tests before production seam changes.
- [ ] Cover default primary and explicit session-model selection.
- [ ] Cover safe primary fallback and prove changed/unmeasurable workspaces are never replayed.
- [ ] Cover mandatory review, remediation/re-review, and persistence.
- [ ] Add valid, invalid, alias, and ambiguous command parser/dispatcher tests.
- [ ] Add sanitized fixtures/tests for Codex, Cursor, Claude, Copilot, Agy, and NVIDIA.
- [ ] Add compatibility-wrapper and rollback tests/documentation.
- [ ] Add opt-in real adapter smokes outside deterministic CI.
- [ ] Open the draft PR after the first reviewed commit; keep body, commits, and checks current.

## Reviewer

- [ ] Run focused deterministic tests.
- [ ] Run `pnpm secrets:check` before every commit and push, recording policy blockers.
- [ ] Run `pnpm check`, `pnpm build`, and `node bin/zeuz health` without bypassing supply-chain policy.
- [ ] Run proportional opt-in real smokes only after a fresh health check and report them separately.
- [ ] Attempt the official Medusa flow and preserve formal `REVIEW_BLOCKED` if sensitive-template classification blocks it.
- [ ] Obtain a fresh read-only adversarial review from a different model family.
- [ ] Remediate every valid finding and obtain a second review when required.

## Optimizer

- [ ] Remove duplicated test harness code and unnecessary abstractions.
- [ ] Confirm unit/CI paths do not start Ink, providers, network, credential reads, or quota-consuming calls.
- [ ] Inspect staged, unstaged, and untracked files for scope and private data.
- [ ] Update the draft PR description/checks and compact `handoff.md` before delivery.
- [ ] Deliver branch, commits, PR link, executed evidence, review verdict, degradations, and blockers.
