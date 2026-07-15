# Wave 02 PRD — Fail-closed trust, review, permissions, and secret boundary

Status: characterization baseline

Branch: `agent/wave-02-fail-closed-trust`

Frozen contracts: `AGENTS.md`, `docs/roadmap_candidate.md`, `docs/waves/wave-01-prd.md`, and `docs/waves/wave-01-tasks.md`.

## Problem and outcome

ZeuZ has deterministic Wave 01 seams but no single enforceable completion contract across Medusa review, adapter permissions, resumed sessions, direct NVIDIA tools, and private state/secret roots. Wave 02 must make every unprovable trust state fail closed and allow changed-artifact completion only after a fresh integrity-bound cross-family `PASS`.

## Requirements

- Freeze request, criteria, delivery, verification, diff/artifacts, producer/reviewer identity and family, verdict, integrity, and freshness in the Medusa lifecycle.
- Require remediation plus a new independent review after `CHANGES_REQUIRED`; map reviewer absence/failure, invalid output, same family, tampering, and stale evidence to `REVIEW_BLOCKED`.
- Allow only the three frozen public templates after exact path classification and content scanning.
- Apply one capability matrix to Codex, Cursor, Claude, Copilot, Agy, and NVIDIA in `plan`, `agent`, and `yolo`, including resume monotonicity and named unsupported errors.
- Sanitize subprocess environments and block credential filenames, plan-mode shell composition, symlinks, and workspace escape in direct NVIDIA tools.
- Harden session/task/review roots and files for ownership, modes, symlinks, paths, and temporary writes.
- Use deterministic tests without real providers or secrets.

## Non-objectives

Do not implement Wave 03 process deadlines/cancellation/streaming, Wave 04 async state engine/worktrees/migrations, or later skills, UI, memory, MCP, Telegram, telemetry, contributor, and release work. Do not broadly refactor adapters/controller or store real credentials.

## Risks and controls

- Template false trust: exact allowlist plus negative content/path tests.
- Provider semantic drift: shared policy plus six-adapter conformance matrix.
- Review deadlock: surface `REVIEW_BLOCKED` honestly.
- State migration creep: additive validation only, no schema migration.
- Rollback bypass: reviewed Git revert; any compatibility path must remain fail closed.

## Acceptance and rollback

Characterization tests precede contract edits. `pnpm check`, `pnpm build`, and `node bin/zeuz health` pass under bundled Node 24. A fresh comparable cross-family reviewer must return a structurally valid current `PASS`; otherwise the outcome is `REVIEW_BLOCKED`. Rollback is a reviewed revert of Wave 02 commits and may never restore unreviewed delivery.
