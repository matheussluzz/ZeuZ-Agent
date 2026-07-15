# Wave 02 PRD — Fail-closed trust, review, permissions, and secret boundary

Status: implementation complete; final review pending

Branch: `agent/wave-02-fail-closed-trust`

Frozen contracts: `AGENTS.md`, `docs/roadmap_candidate.md`, and the inherited seams documented in `docs/waves/wave-01-prd.md` and `docs/waves/wave-01-tasks.md`.

## Problem

ZeuZ has deterministic provider/controller seams and a standalone Medusa packet validator, but completion is not yet governed by one enforceable trust contract. Reviewer failure can be misclassified as producer defects, changed work can return without a valid fresh `PASS`, provider permission flags diverge, resumed sessions can lose the requested authority boundary, state roots are not uniformly hardened, and Medusa currently rejects three tracked public configuration templates as though their filenames alone proved secret content.

## Outcome

For any artifact-changing turn, ZeuZ completes only after a structurally valid, fresh, integrity-bound, cross-family Medusa `PASS`. `CHANGES_REQUIRED` requires remediation and a new independent review. Missing, failed, invalid, same-family, stale, or tampered review evidence produces `REVIEW_BLOCKED`. The same fail-closed capability contract governs new and resumed adapter runs in `plan`, `agent`, and `yolo`, and the shared state/secret boundary protects local state and direct NVIDIA tools.

## Requirements

1. Freeze original request, criteria, delivery, verification, artifacts, producer identity/family, reviewer identity/family, workspace state, verdict, and integrity/freshness bindings in the Medusa packet/report lifecycle.
2. Validate packet/report structure and freshness before delivery; never parse malformed reviewer output as `CHANGES_REQUIRED` or silently degrade on reviewer failure.
3. Require a fresh cross-family `PASS` after every artifact change, including remediation. A second non-`PASS` blocks completion.
4. Permit the three tracked public templates `.env.example`, `lamine.example.yaml`, and `templates/aws-athena-mcp/.env.example` only after both an explicit path classification and content secret scan; continue to block real credential paths and secret-shaped content.
5. Centralize adapter capability/permission decisions for `plan`, `agent`, and `yolo`. Unsupported or unprovable semantics raise a named fail-closed error rather than being emulated.
6. Apply the current requested mode to both new and resumed sessions. Resume may not gain write authority, secret-bearing environment, or any capability absent from a new run in the same mode.
7. Prove conformance for Codex, Cursor, Claude, Copilot, Agy, and NVIDIA through deterministic injected runtimes/fixtures without real provider launches in unit tests or CI.
8. Harden direct NVIDIA tools against shell chaining, command substitution, redirects, workspace escape, symlinks, credential filenames, and secret-bearing subprocess environments.
9. Establish one private state-root policy for session/task/review state: real non-symlink directories/files, safe roots/IDs, active-user ownership, and owner-only private contents. Unsafe or unprovable state becomes a named failure.
10. Use a compatibility wrapper only if rollback needs it; every path must preserve the fail-closed invariant.

## Non-objectives

- Wave 03 process deadlines, cancellation/kill escalation, bounded streaming, or complete non-Git honesty.
- Wave 04 durable async engine, migrations, dependencies, retries, worktrees, or task ownership.
- Waves 05–14 skills registry/import, specialists, UI redesign, vault/memory, MCPs, Telegram, telemetry/catalog routing, contributor platform, or npm release.
- Real credential storage, secret-bearing fixtures, vault/profile access, broad controller/adapter refactors, or a generic shell parser.

## Architecture

- Pure policy modules define review verdict/gate decisions, capability descriptors, resume monotonicity, safe state roots, and credential/shell boundaries.
- Adapters translate an accepted shared capability decision into provider-native arguments; no adapter invents missing authority semantics.
- Medusa scripts remain the canonical persistent packet/report serialization and integrity validator; the controller uses the same strict report contract for runtime delivery.
- Existing Wave 01 runtime seams remain the injection boundary for deterministic tests.

## Risks and controls

- **False allowlist for templates:** authorize only frozen public template paths plus content scanning; test tracked real-secret paths and secret-shaped template content.
- **Provider flag drift:** conformance matrices assert exact new/resume behavior and named unsupported cases.
- **Review deadlock:** `REVIEW_BLOCKED` is an intentional outcome, surfaced distinctly from `CHANGES_REQUIRED` and producer failure.
- **State migration creep:** validate existing private roots in place; do not introduce schema migrations or a durable engine.
- **Rollback bypass:** no legacy compatibility wrapper is retained because it cannot satisfy the invariant; rollback is a reviewed Git revert.

## Acceptance criteria

- A distinct first commit proves characterization tests existed and passed before production policy changes.
- Unit/CI tests use no real providers or secrets and cover every requested negative case and resume transition.
- Medusa accepts safe tracked public templates but rejects real/tracked credentials, secret-shaped content, tampering, stale diffs, same-family review, unsafe paths, symlinks, and insecure modes.
- Controller delivery is impossible after any non-`PASS`, invalid, failed, unavailable, stale, or non-cross-family review.
- `pnpm check`, `pnpm build`, and `node bin/zeuz health` pass under bundled Node 24.
- A fresh comparable cross-family reviewer validates the final packet/report with `PASS`; otherwise the wave ends as `REVIEW_BLOCKED`.

## Rollback

Revert the Wave 02 implementation commit while retaining the characterization checkpoint if useful. No rollback mode may restore delivery without a fresh cross-family `PASS`.
