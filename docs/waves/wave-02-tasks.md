# Wave 02 task list

Status legend: `[ ]` pending, `[~]` in progress, `[x]` complete, `[!]` blocked.

## Brainstorming

- [x] Complete repository bootstrap and freeze `AGENTS.md` plus `docs/roadmap_candidate.md`.
- [x] Verify clean Wave 01 checkout, host GitHub auth, fast-forward `main`, merge ancestry, and create the Wave 02 branch.
- [x] Run baseline health/tests and record provider degradation honestly.
- [x] Delegate a bounded read-only audit after health checks; GLM degraded on the long task, Cursor Fable completed the fallback audit.
- [x] Trace candidates 1–5 and the state/secret foundation of candidate 20 to current seams.

## Architecture

- [x] Write the Wave 02 PRD with requirements, non-objectives, risks, acceptance, and rollback.
- [x] Commit characterization tests separately as `e382d3c` before production policy changes.
- [x] Define narrow shared policy types/errors for review, capabilities, resumes, state roots, and credential paths.
- [x] Keep rollback as a reviewed Git revert; no compatibility wrapper is retained because the legacy review driver cannot satisfy the fail-closed invariant.

## Engineering

- [x] Implement the complete Medusa evidence packet/report lifecycle and integrity/freshness validation.
- [x] Fix tracked public template handling without trusting generic filenames or weakening content scans.
- [x] Enforce the controller delivery gate: fresh cross-family `PASS` only; remediation always receives a new independent review.
- [x] Implement shared permission capability decisions for all six adapters.
- [x] Enforce resume monotonicity for modes, environment, and authority.
- [x] Apply the shared secret/shell/workspace policy to direct NVIDIA tools.
- [x] Harden session, task, and review state roots and file modes.
- [x] Add deterministic conformance/negative tests without real providers or secrets.
- [x] Update public documentation only where behavior changes.

## Reviewer

- [x] Run focused tests, `pnpm secrets:check`, `pnpm check`, `pnpm build`, and `node bin/zeuz health` with bundled Node 24.
- [x] Run deep NVIDIA health; record mixed route results and the degraded GLM delegate honestly.
- [x] Generate private Medusa request, criteria, delivery, verification, packet, and initialized report.
- [x] Record the first cross-family outcome: `REVIEW_BLOCKED` only because characterization ordering lacked a replayable checkpoint.
- [~] Generate a fresh packet and obtain a second comparable cross-family review after the checkpoint remediation.
- [ ] Validate the final report structurally and confirm workspace freshness immediately before delivery.

## Optimizer and GitHub

- [x] Remove duplicated adapter policy and avoid abstractions beyond Wave 02.
- [x] Confirm rollback behavior remains fail-closed.
- [x] Run `pnpm secrets:check` immediately before the characterization commit and push.
- [x] Open draft PR #3 after the first reviewed checkpoint commit.
- [~] Keep PR description, commits, and checks current; do not merge.
- [ ] Compact `handoff.md` below the private continuity limits before final delivery.
