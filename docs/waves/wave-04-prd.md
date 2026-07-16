# Wave 04 PRD — Versioned durable task engine and editing isolation

Status: implementation complete; independent review pending

Branch: `agent/wave-04-durable-task-engine`

Frozen contracts: `AGENTS.md`, `docs/roadmap_candidate.md` (candidates 8 and 10–12 runtime foundation plus candidate 21), and the inherited deterministic, permission, review, deadline, cancellation, streaming, redaction, and workspace-evidence seams from Waves 01–03.

Baseline: Wave 03 merge `b3645f1aaa120f76c49f86a3d0b344520b6d8afa`; reviewed Wave 03 head `549ca79750db24ef7c468486ff7f6a4e8d913ba0` is an ancestor. Baseline verification on bundled Node 24.14.0 passed `pnpm check` (230 TypeScript tests, 18 skill tests, 6 Argos Python tests, 10 installer tests, 5 AWS MCP tests), `pnpm build`, and shallow health for all six adapter surfaces.

## Outcome

Replace synchronous delegation records and three mtime-based lock files with a local, file-backed, versioned asynchronous task engine. A task survives the submitting process, has observable and cancellable durable state, retains a bounded verified full result and safe artifact references, and cannot be completed by a stale owner. Read-only work may use three concurrent workers. Editing work uses a task-specific Git worktree/branch by default or an exclusive non-Git workspace lease; two workers never edit the same tree concurrently.

## Brainstorming record

The baseline couples task persistence, concurrency, provider execution, and CLI blocking in `TaskStore` and `cli.tsx`. Extending that record in place would preserve the unsafe ownership model and make migration, recovery, and testing inseparable. The selected direction is a set of narrow policy and storage modules around snapshot-and-CAS records:

- make schemas and transition policy pure and independently testable;
- make the filesystem repository the only writer of versioned snapshots and revisions;
- embed a versioned lease snapshot in each task so claim, heartbeat, cancellation, and terminal CAS share one fence;
- keep scheduling and execution orchestration outside stores;
- reuse the existing controller for provider work, Wave 03 cancellation/deadlines, workspace evidence, and Medusa gating;
- isolate Git editing before provider launch, and serialize non-Git editing;
- persist result bytes before the terminal task transition, then verify them on retrieval;
- retain v0 import as read-only compatibility, with explicit migration and rollback artifacts.

Generic event sourcing, a database, a daemon service, provider-specific task state, and terminal workflow-tree UX are rejected for this wave because they broaden authority or duplicate later waves without improving the local fenced ownership proof.

## Baseline characterization

Before production changes, green tests must freeze these facts without claiming them as capabilities:

1. `TaskRecord` has no schema version, revision, attempt/dependency/owner/lease/cancel/artifact/result/correlation/history fields and supports only `queued | running | completed | failed`.
2. `TaskStore.list()` and `SessionStore.list()` silently skip parse/assert failures. Structurally incomplete but parseable JSON is not validated and can be returned as if healthy; missing sort fields can also make listing fail. The prompt's statement that incomplete JSON is always skipped is therefore not true of the observed baseline.
3. store `save()` replaces by atomic rename but has no final create-if-absent, expected revision, CAS, or fencing.
4. `acquireSlot()` uses `delegate-0..2.lock`, PID, timestamp/mtime, a 30-minute stale threshold, wall-clock polling, and catches lock-inspection races broadly.
5. `zeuz delegate` claims a slot and blocks in the caller until provider completion; depth is primarily `ZEUZ_DELEGATION_DEPTH`.
6. tasks retain only a 500-character preview or an error string; `/tasks` only renders recent flat records.
7. no durable cancel, retry, dependency, restart recovery, artifact manifest, full-result retrieval, or editing isolation exists.
8. SessionStore and TaskStore accept valid unversioned v0 records and have no migration registry, backup, quarantine, or structured corruption diagnostics.

The characterization commit must pass against `b3645f1` and precede all production-contract edits.

## Requirements

### R1. Versioned schemas and safe migration

- Current persisted session, task, lease, result reference, artifact manifest, migration manifest, and transition records carry `schemaVersion`, validated ID, `revision`, timestamps, and narrow invariants.
- Existing unversioned sessions/tasks are legacy v0. A strict read-only importer validates v0 and deterministically produces the first current schema.
- Migration creates one owner-only content-addressed backup and manifest before replacement, validates the replacement, and is idempotent after interruption.
- Migration has its own lock plus fencing. Backup collision is accepted only when existing hash/metadata matches exactly.
- Malformed, truncated, schema-invalid, or incompatible records move to owner-only quarantine with a safe reason code and metadata. Healthy records remain accessible and list/load return structured diagnostics.
- Unknown future versions remain intact and fail with `UNSUPPORTED_STATE_VERSION`; they are never quarantined merely for being newer and never downgraded.
- Unit tests use only synthetic temporary roots and never inspect or mutate the real user state root.
- Migration acquires a root maintenance epoch/fence, pauses new claims, drains current workers, and makes claim/heartbeat/result/terminal writes refuse the old epoch while replacement is in progress.

### R2. Atomic create, CAS, and filesystem honesty

- Final create is exclusive and cannot overwrite an ID collision. Update requires `expectedRevision`; exactly one writer with a shared revision wins.
- Owner writes additionally require the current lease owner ID and fencing token.
- Temporary files are unique, private, no-follow, flushed at file level, renamed through a documented platform contract, and cleaned conservatively. Parent-directory flush is attempted where supported and reported honestly rather than advertised as guaranteed crash durability.
- Partial write, rename failure, leftover temporary, stale revision, duplicate create, and stale-fence behavior have deterministic injected tests.
- The state container remains realpath/owner checked and rejects group/world writes; every engine-owned collection is `0700`, every state file is `0600`, and symlink boundaries fail closed.
- Opening the repository yields one canonical realpath-backed `StateRoot` capability; every derived path stays under it and the low-level atomic writer is not a public bypass around CAS.
- Current records have explicit per-record budgets and the state root has a configurable bounded quota. Oversize current writes fail with `STATE_QUOTA_EXCEEDED`; oversize legacy records remain intact/read-only with diagnostics rather than being truncated or destroyed.
- Session mutation moves from mutable-object overwrite to snapshot-returning `create`/`replace(expectedRevision)` APIs; controller session writes participate in the same lost-update protection as tasks.

### R3. Durable task state machine

- Exactly six states exist: `queued | running | blocked | completed | failed | cancelled`.
- `queued -> running` is an atomic claim. Terminal transitions are exactly-once and idempotent only when the entire terminal intent matches.
- Current owner/fence is required for running heartbeat, result attachment, artifact finalization, and terminal transition.
- `running -> completed` requires a verified result reference, finalized artifacts, workspace evidence, and fresh cross-family Medusa PASS when artifacts changed.
- Queued/blocked cancellation is immediate. Running cancellation stores `cancelRequestedAt` and a redacted cause before aborting the Wave 03 execution signal.
- Cancellation is cross-process: `task cancel` persists the request by CAS; the owning worker observes task revision during heartbeat/polling and aborts its own Wave 03 signal within one heartbeat interval. An in-memory abort registry is only a latency optimization for same-process callers.
- Cancel-versus-completion uses record revision/CAS: the first valid terminal transition wins; the loser receives a named terminal/conflict error.
- Transition history is bounded and stores only timestamp, from/to, attempt, owner/fence fingerprint, and reason code—never prompt, result, raw events, or secrets.
- `blocked` uses typed safe reasons for dependency, review, workspace, ownership, migration, and preflight.

### R4. Leases, heartbeat, scheduler, and recovery

- A versioned lease contains unpredictable owner ID, PID, host/instance identity, monotonic fencing token, claim/heartbeat/expiry timestamps, and revision.
- Default policy: 30-second heartbeat, 120-second lease, maximum three active workers. Inputs reject negative, zero where disallowed, non-finite, inverted, and excessive values.
- Clock, scheduler, owner probe, host identity, and filesystem operations are injectable; unit tests do not depend on long sleeps or real PIDs.
- A late heartbeat never reclaims ownership. Expiry alone is insufficient when the owner is provably/potentially alive. Local `EPERM` is potentially alive, `ESRCH` is dead, and remote/unknown host probe is ambiguous.
- Expired + proven-dead ownership may be reclaimed atomically with a higher fencing token. Ambiguity transitions the task to `blocked` with an ownership reason.
- Startup/sweep is idempotent, launches runnable queued work, and handles orphaned running work through the retry/workspace policy without duplicate attempts.
- Worker launch failure and crashes before/after claim have named outcomes and release all owned timers/listeners/leases.
- Claim, heartbeat, result attachment, and terminal writes carry both the lease fencing token and the current root maintenance epoch.

### R5. Dependencies, correlation, and bounded retry

- Persist `parentTaskId`, `parentSessionId`, `rootCorrelationId`, and depth; depth maximum one is enforced from durable ancestry, with the environment variable retained only as defense in depth.
- Dependencies are immutable after claim and form a validated DAG: missing IDs, self-edge, direct/indirect cycles, and post-claim mutation fail by name.
- A task is runnable only when every dependency completed. Failed/cancelled/permanently blocked prerequisites block dependents with typed reason metadata.
- Retry is opt-in, maximum three attempts, with a validated bounded exponential schedule behind an injected scheduler.
- Retry classification uses typed error codes. Cancel, review block, permission denial, unsafe/migration/quarantine/stale-owner errors and workspace `changed | unmeasurable` are never automatic retries.
- Writable retry requires recorded `unchanged` evidence for the previous attempt. Crash/reclaim never permits concurrent attempts or unbounded retry consumption.

### R6. Full results and safe artifact manifests

- Result content is redacted and stored separately in an owner-only file with schema version, hash, byte count, byte budget, truncation flag, and unsafe-completion metadata.
- Default complete-result budget is 8 MiB. Oversize/unsafe reconstruction cannot become `completed` or be presented as complete.
- Retrieval revalidates size/hash after restart and fails by name on tampering.
- Artifact entries use only validated workspace/worktree-relative paths, kind (`created | modified | removed`), capture status, digest, size, and bounded evidence metadata.
- Absolute/traversal/external-symlink/credential/private-profile/vault/handoff/state-root paths are rejected. Workspace content is never copied into the ZeuZ state root.
- Artifact derivation uses measured Git/non-Git evidence. `unmeasurable` blocks artifact finalization and review freshness.

### R7. Asynchronous engine and CLI compatibility

- `zeuz delegate ...` persists/enqueues and returns a task ID after proving a worker was launched or the task remains durably queued. The caller does not run the provider inline.
- A narrow detached worker entry point survives caller exit without an external undocumented daemon. Its environment is allowlisted/sanitized and its stdio is ignored or routed only to bounded private metadata—not raw logs.
- `delegate --wait` submits through the same engine and polls/observes the same record/result.
- Implement `zeuz task list|status|result|cancel|wait`; prefix resolution is exact-or-unique and ambiguity fails.
- CLI parser/dispatch, help text, README, command metadata, and `/tasks` observation cover the six states without adding Wave 07 interactive UX.
- The engine invokes existing controller/adapters; it does not duplicate provider fallback, deadlines, permissions, streaming, cancellation, or Medusa policy.
- Provider execution is adapted to an internal `TaskExecutionOutcome` containing before/after workspace evidence, verified result reference, finalized artifact manifest, and validated review evidence. Only `TaskStore.complete(expectedRevision, ownerId, fence, maintenanceEpoch, outcome)` may enter `completed`.

### R8. Parallel read-only work and editing isolation

- Scheduler evidence demonstrates three `plan` tasks running in one workspace and a fourth queued until release.
- Every plan attempt measures before/after; any write is a named violation that blocks completion and replay.
- A plan attempt with `changed` becomes `PLAN_WRITE_VIOLATION`; `unmeasurable` blocks completion as unsafe. The engine does not inherit the controller baseline's more permissive plan inference.
- Workspace identity uses realpath and, for Git, common-dir/repository identity so aliases cannot bypass locks.
- Git editing defaults to a task-owned branch and worktree under an owner-only managed root, based on captured commit. The engine never merges, rebases, pushes, commits, stashes, resets, or discards automatically.
- Task state distinguishes `requestedWorkspace`, `repositoryIdentity`, `baseCommit`, and `executionWorkspace`. The controller receives only the isolated execution workspace for Git editing.
- Preflight distinguishes clean, staged, unstaged, untracked, ahead, behind, diverged, detached, unborn, no-upstream, branch collision, and existing worktree. Dirty/behind/diverged block automatic isolation; ahead-clean is allowed with explicit local-HEAD evidence; no-upstream is allowed without remote-sync claims; detached requires explicit base.
- Editing tasks in one Git repository receive distinct worktrees, while different repositories may proceed independently within the global limit.
- Non-Git editing uses an exclusive lease on canonical workspace identity and bounded snapshots.
- Cancellation, failure, ambiguous state, dirty worktree, or uncaptured artifacts preserve the worktree. Destructive cleanup requires a separate explicit command/consent and preflight.
- Worktree setup uses a narrow non-interactive Git runner with a sanitized environment, disabled hooks, and fail-closed detection of unsupported executable filters/configuration. It is not a generic Git command surface.

## Architecture

| Layer | Responsibility | Expected module boundary |
| --- | --- | --- |
| Schemas | current/v0 types, narrow validators, safe reason codes | `state-schema`, `state-migration` |
| Repository | canonical private-root capability, quota, atomic create, revision CAS, maintenance epoch, migration backup/quarantine | `state-repository`, existing `state-policy` |
| Task policy | transitions, dependencies, retry, liveness/reclaim decisions | pure `task-state`, `task-policy`, `lease-policy` |
| Task persistence | task snapshots, transition history, claim/cancel/terminal APIs | redesigned `task-store` |
| Results/artifacts | bounded result bytes and validated reference manifests | `task-result-store`, `artifact-policy` |
| Isolation | workspace identity, Git preflight/worktrees, non-Git versioned lease/CAS/heartbeat/reclaim | `worktree-manager`, `workspace-lock-store`, existing `workspace` |
| Runtime | scheduler, worker claim/heartbeat/sweep, cross-process cancel observation, execution outcome | `task-engine`, `task-worker` |
| Launch/CLI | detached child spawn and task subcommands/compatibility | `worker-launcher`, `cli` |

All inter-layer mutation occurs through validated snapshots and expected revisions. Stores do not execute providers; policy modules do not perform I/O; the worker cannot write terminal state without the current lease fence and root maintenance epoch. The controller produces execution evidence but never performs the terminal task transition.

## Migration and rollback

1. Scheduling must enter a fenced maintenance epoch before migration or recovery: reject new claims, request/drain active workers, and invalidate writes from the prior epoch.
2. The importer reads v0 without modifying it, validates a deterministic v1 candidate, creates/verifies an owner-only backup plus manifest, then performs a CAS-like replacement.
3. Interrupted runs reconcile the original, backup, manifest, and candidate hashes idempotently; ambiguity quarantines/blocks rather than guesses.
4. The v0 importer remains read-only for one compatibility window. `delegate --wait` remains a usage compatibility path, not a second writer.
5. Rollback instructions cover pausing workers, inspecting task/lease/result state, restoring a verified backup to a separate read-only root, and reopening without scheduling.
6. Rollback never maps corruption, stale ownership, review failure, ambiguous workspace evidence, or incomplete migration to success.

## Test strategy and exit evidence

- A separate green baseline-characterization commit precedes production changes.
- Pure policies receive exhaustive table tests for transitions, dependency DAGs, retry, lease timing/liveness, fencing, and Git preflight.
- Repository tests inject IDs, clocks, rename/fsync failures, owner probes, and scheduler events; all state roots and Git repositories are temporary synthetic fixtures.
- Integration tests exercise submit/list/status/result/cancel/wait, caller exit, restart/sweep, launch/crash boundaries, three-worker scheduling, plan-write violation, Git worktree isolation, and non-Git serialization.
- Handle-leak tests assert release of timers/listeners/child handles/leases/temporaries/worktrees across success, failure, cancel, timeout, and recovery.
- Required final checks: `pnpm secrets:check`, `pnpm check`, `pnpm build`, `node bin/zeuz health`, `git diff --check`, migration/restore/quarantine validators, GitHub CI, and a fresh cross-family Medusa packet/report.

## Non-objectives

- Wave 05 portable skill registry, Agent Skills discovery, BMAD/NVIDIA imports, provenance/licensing pipeline, or new skill routing.
- Wave 06 Pantheon personas, specialist spawning/routing, direct messages, follow-ups, or task messaging.
- Wave 07 slash dropdown, workflow tree, interactive cancellation, safe reasoning pane, busy-turn composer, or terminal event-tree redesign.
- Wave 08 adaptive onboarding/PRD engine; Wave 09 vault memory/compaction; Wave 10 health-aware routing/catalog telemetry; Waves 11–14 MCP, Telegram, contributor platform, release automation, and npm publication.
- Distributed/multi-host queue, database server, remote coordinator, cloud scheduler, arbitrary shell Git orchestration, automatic merge/rebase/push/commit/stash/reset, dirty-worktree deletion, or descendant process-tree kill beyond Wave 03.
- Direct GLM migration without a real opt-in HTTP 200 completion with expected content.
- Credentials, raw provider events, full environments, real profile/vault content, secret-bearing workspace artifacts, or workspace-file copies in task state.

## Risks

| Risk | Mitigation |
| --- | --- |
| False crash durability claims across filesystems | Document Node/OS guarantees narrowly; test atomicity/failure recovery; expose unproven states as blocked |
| Stale process completes after reclaim | Fence every heartbeat/result/artifact/terminal write and CAS the task revision |
| Migration destroys private history | Read-only v0 import, verified unique backup, validate-before-replace, idempotent manifest, fail-closed quarantine |
| Async child leaks secrets or becomes orphaned | Allowlisted environment, detached narrow entry point, no raw stdio, durable claim, heartbeat, startup sweep |
| Git isolation loses work | Refuse dirty/behind/diverged auto-setup; never auto-clean destructive state; preserve ambiguous/failed worktrees |
| State/root aliases bypass serialization | Canonical realpath plus Git common-dir identity and tested symlink aliases |
| Breadth causes speculative rewrite | Commit by policy/storage/runtime/CLI slices, keep controller/adapters authoritative, require green checkpoints and independent review |

## Completion gate

Wave 04 completes only when all mandatory cases in the session prompt are traceable to passing deterministic tests, the draft PR CI is green, no later change invalidates the evidence packet, and a fresh Composer or GLM Medusa reviewer returns `PASS`. `REVIEW_BLOCKED` or unresolved `CHANGES_REQUIRED` blocks delivery. The branch is not merged in this session.
