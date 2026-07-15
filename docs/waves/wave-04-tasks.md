# Wave 04 task list — Durable task engine and editing isolation

Status: in progress

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
- [ ] Commit the green characterization checkpoint separately.
- [ ] Open the Wave 04 draft PR from that first revisable commit.

## Engineering — schemas and repository

- [ ] Define current versioned schemas and validators for sessions, tasks, leases, results, artifacts, transitions, and migration manifests.
- [ ] Implement named safe errors and structured diagnostics.
- [ ] Add strict read-only v0 importers for sessions/tasks.
- [ ] Implement verified unique backups, migration manifests/lock/fencing, idempotent recovery, and quarantine.
- [ ] Add root maintenance epoch/fence, claim pause, worker drain, and old-epoch write rejection around migration.
- [ ] Upgrade state writes to canonical-root capability, quotas, exclusive create, expected-revision CAS, injected failure seams, proportional flush, and safe temp recovery.
- [ ] Integrate SessionStore snapshot/CAS migration and diagnostics without breaking healthy load/list/fork semantics.
- [ ] Cover v0 valid/invalid, current/future, truncated/mismatch, collision/interruption/concurrency, permissions, and symlinks.

## Engineering — task policy and ownership

- [ ] Implement exact six-state transition policy, bounded redacted history, idempotent terminal intent, and typed blocked reasons.
- [ ] Implement durable correlation/depth, immutable dependency DAG validation, readiness propagation, and permanent dependency blocks.
- [ ] Implement opt-in maximum-three retry policy, typed retryability, injected backoff, and writable-workspace replay gate.
- [ ] Implement versioned lease policy, owner probe semantics, heartbeat validation, reclaim, fencing, and max-three scheduler contract.
- [ ] Cover all valid/invalid transitions, cancel races, dependency shapes, retry boundaries, liveness states, reclaim races, and stale-fence writes.

## Engineering — results, artifacts, and isolation

- [ ] Implement private bounded result store with redaction, hash/size verification, restart retrieval, and tamper detection.
- [ ] Implement safe artifact manifests and derivation from workspace evidence.
- [ ] Reject absolute/traversal/external symlink/credential/private/out-of-root artifacts and oversize/unsafe completion.
- [ ] Implement canonical workspace/repository identity.
- [ ] Implement pure Git preflight classification for clean/dirty/ahead/behind/diverged/detached/unborn/no-upstream/collisions/existing worktrees.
- [ ] Implement a narrow sanitized/hook-disabled Git runner, owner-only managed worktrees/branches, requested/execution workspace separation, and exclusive leases for non-Git editing.
- [ ] Implement non-destructive preservation/cleanup policy and cancel/retry/recovery reuse.
- [ ] Cover artifact create/modify/remove, symlinks/private paths, Git matrix, aliases, two repositories, non-Git serialization, and cleanup refusal.

## Engineering — asynchronous engine and CLI

- [ ] Implement scheduler/engine claim, heartbeat, persisted cross-process cancel observation, maintenance-epoch checks, startup/sweep, worker lifecycle, and handle cleanup.
- [ ] Add internal `TaskExecutionOutcome` and make fenced `TaskStore.complete(...)` the sole completion path.
- [ ] Implement sanitized detached launcher and internal worker entry point that survive caller exit.
- [ ] Make `delegate` asynchronous and add `--wait` through the same engine.
- [ ] Add `task list|status|result|cancel|wait` with exact/unique prefix resolution and named failures.
- [ ] Update `/tasks`, help, command metadata/autocomplete, README, and AGENTS operational syntax if changed.
- [ ] Cover launch failure/crash boundaries, restart recovery, three plan tasks + queued fourth, plan-write violation, caller exit, CLI paths, and handle leaks.

## Reviewer

- [ ] Run focused state/migration/restore/quarantine validators and temporary-repository macOS integration tests.
- [ ] Run `pnpm secrets:check`, `pnpm check`, `pnpm build`, `node bin/zeuz health`, and `git diff --check`.
- [ ] Inspect staged, unstaged, and untracked scope before every commit/push.
- [ ] Keep draft PR description/commits/checks current and confirm GitHub Actions green.
- [ ] Create a fresh Medusa request/criteria/delivery/verification packet over the final artifact.
- [ ] Obtain read-only fresh-context cross-family review from Composer 2.5; use GLM 5.2 only if healthy and independently effective.
- [ ] Remediate every valid `CHANGES_REQUIRED` finding and repeat independent review until `PASS`; treat unavailable/stale/invalid review as `REVIEW_BLOCKED`.

## Optimizer and delivery

- [ ] Reinspect module boundaries, duplicated state mutation, unnecessary public surface, budgets, error metadata, and portability after correctness is proven.
- [ ] Any optimizer change triggers focused verification and a fresh Medusa packet/report.
- [ ] Record characterization and implementation commits, migration/rollback instructions, concurrency/isolation evidence, restart/cancel/retry/dependency/result evidence, reviewer verdict/fingerprint, and remaining risks.
- [ ] Compact/rewrite private `handoff.md` under the configured bounds.
- [ ] Deliver branch and draft PR link without merging.
