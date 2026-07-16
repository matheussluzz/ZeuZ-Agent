# Wave 04 task list — Durable task engine and editing isolation

Status: independent re-review

Branch: `agent/wave-04-durable-task-engine`

## Brainstorming

- [x] Complete repository bootstrap and read the Wave 04 session prompt.
- [x] Verify clean baseline, GitHub host authentication, merge ancestry, Node 24, baseline checks, and adapter health.
- [x] Fast-forward `main` and create the Wave 04 branch without deleting prior branches.
- [x] Inspect baseline task/session stores, state policy, CLI, workspace measurement, roadmap, and Waves 01–03 contracts.
- [x] Select narrow module boundaries and explicit non-objectives.

## Architecture

- [x] Draft PRD with outcome, baseline gaps, state machine, schemas, migration/rollback, leases/fencing, result/artifact policy, scheduler, isolation, risks, tests, and exit gate.
- [x] Terra read-only architecture/adversarial pre-implementation review (`CHANGES_REQUIRED`).
- [x] Luna read-only characterization/seam audit.
- [x] Integrate valid findings: cross-process cancel, maintenance epoch, fenced outcome, requested/execution workspace split, plan fail-closed rule, canonical state root/quota, sanitized Git runner, and SessionStore CAS.

## Characterization checkpoint

- [x] Add green tests for legacy task/session shape and runtime acceptance beyond the four typed task states.
- [x] Characterize silent corrupt-record skipping and parseable incomplete-record acceptance in both stores; preserve the observed distinction from the prompt claim.
- [x] Characterize duplicate-ID replacement and stale snapshot save without create/CAS/fencing.
- [x] Characterize three lock filenames, mtime stale reclamation, broad lock-inspection catch, and blocking delegate execution.
- [x] Characterize env-based depth, 500-character preview/error-only persistence, and flat `/tasks` behavior.
- [x] Run 9 focused characterization cases, `pnpm secrets:check`, full `pnpm check` (239 TypeScript tests), and `git diff --check`.
- [x] Commit the green characterization checkpoint separately (`799e076`).
- [x] Open the Wave 04 draft PR from the first revisable commits (PR #5).

## Engineering — schemas and repository

- [x] Define current versioned schemas and validators for sessions, tasks, leases, results, artifacts, transitions, scheduler, and migration manifests.
- [x] Implement named safe errors and structured diagnostics.
- [x] Add strict read-only v0 importers for sessions/tasks.
- [x] Implement content-addressed backups, migration manifests/record locks, concurrent/idempotent recovery, future-version preservation, and quarantine.
- [x] Add root maintenance epoch/fence, claim pause, worker drain, and old-epoch write rejection around task migration.
- [x] Upgrade state writes to canonical-root capability, quotas, exclusive create, expected-revision CAS, injected failure seams, proportional file/directory flush, and safe temp recovery.
- [x] Integrate SessionStore snapshot/CAS migration and diagnostics without breaking healthy load/list/fork semantics.
- [x] Cover v0/current/future, malformed/mismatch, collision/failure/concurrency, permissions, quota, and symlinks in temporary roots.

## Engineering — task policy and ownership

- [x] Implement exact six-state transition policy, bounded redacted history, idempotent terminal intent, and typed blocked reasons.
- [x] Implement durable correlation/depth, immutable post-claim dependency DAG, readiness propagation, and permanent dependency blocks.
- [x] Implement opt-in maximum-three retry policy, typed retryability, bounded backoff, and writable-workspace replay gate.
- [x] Implement versioned lease policy, conservative owner probe semantics, heartbeat validation, reclaim, fencing, maintenance epoch, and max-three scheduler contract.
- [x] Cover valid/invalid transitions, cancel/completion ordering, dependency chain/fan-in/cycle, retry boundaries, liveness states, reclaim, and stale-fence writes.

## Engineering — results, artifacts, and isolation

- [x] Implement private bounded idempotent result store with redaction, hash/size verification, restart retrieval, and tamper detection.
- [x] Implement safe artifact manifests and Git status/evidence derivation.
- [x] Reject absolute/traversal/external symlink/credential/private/out-of-root artifacts and oversize/unsafe completion.
- [x] Implement canonical workspace/repository identity.
- [x] Implement pure Git preflight classification for clean/dirty/ahead/behind/diverged/detached/unborn/no-upstream/collisions/existing worktrees.
- [x] Implement a narrow sanitized/hook-disabled Git runner, owner-only managed worktrees/branches, requested/execution workspace separation, and exclusive canonical leases for non-Git editing.
- [x] Preserve managed worktrees after success/failure/cancel or ambiguous state; no destructive cleanup command is exposed by this wave.
- [x] Cover artifact create/remove/modified references, internal/external symlinks/private paths, Git matrix, aliases, parallel Git worktrees, non-Git serialization, and preservation.

## Engineering — asynchronous engine and CLI

- [x] Implement scheduler/engine claim, heartbeat, persisted cross-process cancel observation, maintenance-epoch checks, startup recovery/sweep, worker lifecycle, and timer/slot/lock cleanup.
- [x] Add internal execution outcome and make fenced `TaskStore.complete(...)` the sole completion path with final workspace/review matching.
- [x] Implement sanitized detached launcher and guarded internal worker entry point.
- [x] Make `delegate` asynchronous and add `--wait` through the same record/result path.
- [x] Add `task list|status|result|cancel|wait|recover` with exact/unique prefix resolution and named failures.
- [x] Update `/tasks`, CLI help, README, and AGENTS operational syntax.
- [x] Cover launch degradation, execution crash/retry, restart/orphan recovery, three plan tasks + queued fourth, plan-write violation, cross-process cancel polling, canonical non-Git serialization, Git isolation, and compiled CLI paths.

## Reviewer

- [x] Run focused state/migration/restore/quarantine validators and temporary-repository macOS integration tests.
- [x] Run `pnpm secrets:check`, `pnpm check`, `pnpm build`, `node bin/zeuz health`, and `git diff --check`.
- [ ] Inspect staged, unstaged, and untracked scope before every commit/push.
- [ ] Keep draft PR description/commits/checks current and confirm GitHub Actions green.
- [ ] Create a fresh Medusa request/criteria/delivery/verification packet over the final artifact.
- [ ] Obtain read-only fresh-context cross-family reviews from Composer 2.5 and GLM 5.2 as selected for this session.
- [ ] Remediate every valid `CHANGES_REQUIRED` finding and repeat independent review until `PASS`; treat unavailable/stale/invalid review as `REVIEW_BLOCKED`.
- [x] First final packet `5fb82a3a...` reviewed by Composer 2.5 as `CHANGES_REQUIRED`; two GLM 5.2 attempts failed in the existing Copilot harness and were retained as `REVIEW_BLOCKED`, not converted to success.
- [x] Replace crash-leaking non-Git lock files with versioned CAS leases, heartbeat, conservative dead/ambiguous reclaim, and stale-owner-safe release; add maintenance-resume, oversized artifact, cancel/completion race, and restart lock regressions.

## Optimizer and delivery

- [x] Reinspect module boundaries, duplicated state mutation, unnecessary public surface, budgets, error metadata, and portability after correctness is proven (Luna High optimizer audit: `CHANGES_REQUIRED`).
- [x] Remediate valid optimizer findings around atomic maintenance fencing, current-attempt recovery evidence, result/artifact verification, worktree preflight, stale record-lock leases, scheduler release, queued wait recovery, and exact schemas; repeat focused and full verification.
- [x] Any optimizer change triggers focused verification and a fresh Medusa packet/report.
- [ ] Record characterization and implementation commits, migration/rollback instructions, concurrency/isolation evidence, restart/cancel/retry/dependency/result evidence, reviewer verdict/fingerprint, and remaining risks.
- [ ] Compact/rewrite private `handoff.md` under the configured bounds.
- [ ] Deliver branch and draft PR link without merging.
