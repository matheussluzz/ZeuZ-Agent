# Wave 03 PRD — Process resilience and observable streaming

Status: implementation complete; final Medusa re-review pending

Branch: `agent/wave-03-process-resilience-streaming`

Frozen contracts: `AGENTS.md`, `docs/roadmap_candidate.md` (candidates 7–9 and the controller-side runtime abort/deadline slice of candidate 8), and the inherited seams in `docs/waves/wave-01-prd.md`, `docs/waves/wave-01-tasks.md`, `docs/waves/wave-02-prd.md`, and `docs/waves/wave-02-tasks.md`.

Baseline: Wave 02 merge `8909551e0f17e206181f83c5c7f3d9a0a0edae38` on `origin/main`; Wave 02 head `d09fcc73c4f63d865e483942604f51e5985c5c5b` is an ancestor of the Wave 03 branch.

Baseline verification on bundled Node 24.14.0: `pnpm check` exited 0 (105 TypeScript tests, 18 Node skill-validator tests, 6 Argos Python tests, 10 installer checks, and 5 AWS MCP tests; secret scan covered 170 tracked files), `pnpm build` exited 0, and shallow `node bin/zeuz health` exited 0 for all six provider surfaces. Deep/provider degradations are recorded in `docs/waves/wave-03-tasks.md` and are supplemental diagnostics, not deterministic proof.

## Outcome

Long provider turns remain bounded, cancellable, diagnosable, and honest in Git and non-Git workspaces. A single shared process-runner contract governs adapters and the controller. Producer, adversarial review, and remediation each receive distinct deadlines. Cancellation escalates interrupt-to-kill with typed termination metadata. Incremental parsing and byte-bounded buffers prevent unbounded memory growth while preserving correct results when streams fit the budget. Workspace change is reported only as `changed`, `unchanged`, or `unmeasurable`. Cancellation leaves a resumable session without weakening the Wave 02 fail-closed Medusa delivery gate.

## Verified baseline

Direct inspection of the merged Wave 02 tree confirms these gaps:

| Area | Current behavior | Risk |
| --- | --- | --- |
| `src/process.ts` | Accumulates full stdout/stderr strings; abort sends `SIGINT` then `SIGKILL` after 1.5s with no typed cause, stage, or cleanup contract | Unbounded memory; orphan timers/listeners; opaque cancellation |
| Abort before spawn failure | A pre-aborted signal combined with a missing executable can propagate `SIGINT` to the caller/process group before the child emits its spawn error; characterization must isolate this probe in a detached group | The orchestrator itself can be interrupted instead of receiving a typed spawn/cancel result |
| Adapter runtime | `runProcess` returns complete buffers; fixture harness replays whole files at once | Adapters can depend on final buffers instead of incremental events |
| Controller deadlines | `send`, `ask`, `runReview`, and `remediate` share no common producer/review/remediation deadline policy | Turns can run indefinitely; timeout competes with fallback and persistence |
| Workspace measurement | `workspaceFingerprint()` returns `undefined` outside Git; controller treats `undefined` before/after as changed for writable modes | Non-Git workspaces get false-positive change and cannot prove review freshness |
| Change inference | `measurablyUnchanged()` requires two defined equal fingerprints; controller separately uses `before === undefined ? mode !== 'plan' : before !== after` | `unmeasurable` is conflated with `changed`; optimistic replay paths remain possible |
| Review gate | Wave 02 blocks delivery without fresh cross-family `PASS`; reviewer timeout/failure must remain `REVIEW_BLOCKED` | Wave 03 must not weaken this invariant |
| NVIDIA direct HTTP route | `NvidiaAdapter.runDirect()` uses global `fetch` with `stream: false`, then unbounded `response.json()`; only the Copilot-backed CLI path is covered by `nvidia.jsonl` | MiniMax/Qwen/Kimi have no bounded, incremental, deterministic transport plan today |
| GLM transport | GLM currently uses the Copilot BYOK process harness. Matheus authorized migration to direct NVIDIA HTTP after a real direct completion succeeds; two direct probes on 2026-07-15 reached `z-ai/glm-5.2` but returned HTTP 429 | Keep the process harness until direct inference is proven; a reachable endpoint or deep probe alone is not migration evidence |

## Requirements

1. Introduce two narrow shared execution contracts with explicit result types for completion, timeout, cancellation, spawn/transport failure, non-zero exit, signal/escalation stage, truncation metadata, and unsafe-completion failure:
   - **Child-process runner** — for CLI-backed adapters (Codex, Cursor, Claude, Copilot, Agy, and the current Copilot-backed NVIDIA GLM route until the direct route is proven).
   - **Injectable HTTP transport** — for the NVIDIA direct JSON tool loop (MiniMax, Qwen, Kimi, and GLM after a successful direct smoke). `AdapterRuntime` must expose an injectable `fetch`/response-body seam with byte-bounded body accumulation, abort/deadline composition, and deterministic fixtures. A child-process runner alone does not govern this route.
2. Apply separate configurable deadlines to producer turn, adversarial review, and remediation. Deadlines compose with external `AbortSignal` without losing the original cause or reusing an aborted signal across phases.
3. Implement interrupt-to-kill escalation with documented stages, no orphan timers/listeners, and deterministic tests for abort-before-spawn, abort-during-stream, abort-after-close, repeated abort, spawn error, null exit code, and post-terminal output.
4. Replace boolean/undefined workspace change inference with an explicit tri-state contract and evidence objects before and after each measured phase.
5. Provide byte-bounded accumulators for stdout, stderr, partial-line fragments, raw protocol events, and HTTP response bodies. Enforce limits in bytes, preserve UTF-8 boundaries, and emit redacted truncation diagnostics only (stream, limit, observed/discarded byte counts). Never include discarded payload, secrets, or credential-shaped content.
6. When truncation or parse failure prevents safe reconstruction of session IDs, tool events, native handles, or final text, return a named non-success result (`unsafe_completion`, `parse_failure`, or equivalent). Never return partial text as success, emit invented review evidence, or downgrade to a silent warning-only path.
7. Implement real incremental parsing for Codex, Cursor, Claude, Copilot, Agy, and both NVIDIA routes using Wave 01 sanitized fixtures plus new direct-route HTTP fixtures. CLI adapters must not require retaining complete stdout/stderr; the direct NVIDIA route must not require unbounded `response.json()` on the live path.
8. On cancellation or timeout, persist safely any native session ID and provider-neutral state already observed; record termination cause without secret content; allow a later turn without elevating permissions or reintroducing secret-bearing environment.
9. Retain the existing runner behind the new interface for one release as an explicit rollback path. The default path must not silently disable deadlines, bounds, redaction, tri-state measurement, or fail-closed review.
10. Add deterministic characterization tests that freeze current behavior and gaps before production changes, in a separate green commit ahead of implementation. Include timeout/cancellation race characterization against fallback eligibility, stream close/error handling, and session-persistence behavior on cancel.
11. When workspace measurement becomes `changed` after a review verdict was produced but before delivery, block completion and require fresh cross-family review evidence. Never deliver on stale review freshness.
12. Migrate GLM from the Copilot BYOK process harness to direct NVIDIA HTTP only after an opt-in real completion returns HTTP 200 with the configured `z-ai/glm-5.2` route. HTTP 429, a shallow/deep health pass, or endpoint reachability is insufficient. On success, remove only GLM's process dependency and its obsolete fixture path; preserve the independent Copilot provider and do not migrate DeepSeek without separate evidence.

## Non-objectives

- Wave 04 durable asynchronous task engine, schemas/migrations, dependencies, retries, heartbeat, lock reclamation, task ownership, artifacts/full-result retrieval, parallel editing tasks, or worktree isolation.
- Wave 06 specialist lifecycle, direct-message/follow-up channel, or task messaging.
- Wave 07 terminal cancellation UX, slash dropdown, workflow tree, safe-reasoning pane, event-tree redesign, or Ink E2E.
- Waves 05 and 09–14 skills registry/import, Pantheon, adaptive PRD engine, vault/memory, health-aware routing, telemetry, MCPs, Telegram, contributor platform, or npm release.
- Real credential storage, vault/profile access, generic event bus, speculative broad controller/adapter rewrite, or provider-wide retry policy.
- Claims of hard real-time behavior, RSS-stable behavior for uncontrolled third-party libraries, or descendant process-tree kill on platforms where that behavior is not demonstrated. Wave 03 proves bounded retained bytes in ZeuZ-owned accumulators and buffers only.

## Architecture

- **Pure policy modules** — deadline resolution/validation, termination classification, workspace tri-state measurement, and truncation/redaction metadata.
- **Injected child-process runner** — spawn, clocks, timers, signal delivery, and child-handle cleanup behind `AdapterRuntime` / controller runtime seams; no long real-time sleeps in unit tests.
- **Injectable HTTP transport** — bounded response-body reader, abort/deadline wiring, and redacted truncation metadata for the NVIDIA direct JSON tool loop; deterministic fragmented/truncated/malformed direct-route fixtures separate from `nvidia.jsonl`.
- **Bounded byte accumulators and decoders** — per-stream, per-parser, and per-response-body budgets with UTF-8-safe partial handling.
- **Incremental protocol parsers** — one decoder per CLI adapter protocol plus a direct NVIDIA HTTP/action decoder, replaying Wave 01 fixtures and new direct-route fixtures through the appropriate transport contract.
- **Provider-neutral delta streaming** — adapters emit incremental `output.delta` (and related status/warning events) through the shared transcript contract; never adapter-private UI strings. Text above the single-event ceiling is split at UTF-8 boundaries into ordered events before enqueue. Downstream consumers use bounded buffering with lossless backpressure per stream key (see byte-budget table).
- **Controller orchestration** — decides fallback, review, remediation, and delivery from typed termination plus workspace tri-state; never from message regex alone or `undefined` optimism.
- **Compatibility wrapper** — legacy `runProcess` behavior selectable for one release only; covered by tests; rollback cannot convert timeout, overflow, `unmeasurable`, or reviewer failure into degraded success.

Adapters remain protocol translators. The transcript and provider-neutral event contract stay centralized. Wave 02 review-policy, permission, resume-monotonicity, and state-root modules remain authoritative for delivery gating.

## Deadline defaults and validation policy

Deadlines are resolved once per phase from configuration with injectable clock/timer seams.

| Phase | Default | Minimum | Maximum | Invalid input |
| --- | --- | --- | --- | --- |
| Producer turn | 3,600,000 ms (60 min) | 0 (immediate timeout; test-only) | 7,200,000 ms (120 min) | Negative, `NaN`, `Infinity`, or above maximum → named configuration error |
| Adversarial review | 1,800,000 ms (30 min) | 0 | 3,600,000 ms (60 min) | Same validation |
| Remediation | 3,600,000 ms (60 min) | 0 | 7,200,000 ms (120 min) | Same validation |

Policy rules:

- Each phase owns a fresh `AbortController` or equivalent scoped abort source. External cancellation and internal deadline both record the earliest effective cause.
- Producer timeout/cancellation is never classified as simple provider unavailability when workspace measurement is `changed` or `unmeasurable`.
- Reviewer timeout/failure remains `REVIEW_BLOCKED`. Remediation timeout/failure blocks delivery and requires new review evidence.
- Exact-boundary behavior at `now + deadline` is characterized in tests with injected clocks, not wall-clock sleeps.

## Process-tree semantics for macOS and Linux

Wave 03 documents and tests only what the implementation actually does:

1. **Default path** — signal the direct spawned child PID only. Do not claim descendant termination unless demonstrated.
2. **Optional process-group path** — if enabled for a platform:
   - spawn the child in a new isolated process group and record its verified PGID;
   - deliver interrupt/kill to the **process group**, not merely the leader PID (POSIX: negative PGID to `kill(2)` / `process.kill(-pgid, signal)` or an equivalent documented primitive);
   - verify the PGID belongs to the spawned child before signaling and guard against reuse or accidental signaling of the parent/session group;
   - document the isolation/portability tradeoff and the risk of signaling the wrong group.
   Absent capability → named `unsupported_process_group` (or equivalent) rather than silent no-op. If group-directed signaling will not be implemented, restrict the contract to direct-child termination only.
3. **Escalation stages** — cooperative interrupt (`SIGINT` or platform equivalent) → short grace window via injectable timer → forced kill (`SIGKILL` or platform equivalent). Record the stage reached and whether the child handle reported exit.
4. **Failure honesty** — if kill does not produce exit within the characterized window, surface `termination_incomplete` metadata; do not report success.

## UTF-8 byte bounds and redacted truncation

| Budget | Default limit | Scope |
| --- | --- | --- |
| stdout capture | 8,388,608 bytes (8 MiB) | Total observed stdout per process run |
| stderr capture | 2,097,152 bytes (2 MiB) | Total observed stderr per process run |
| partial-line buffer | 262,144 bytes (256 KiB) | Incomplete line retained across chunk boundaries |
| raw protocol event | 1,048,576 bytes (1 MiB) | Single decoded event payload before rejection |
| emitted provider-neutral event | 262,144 bytes (256 KiB) | Maximum byte length of every delivered textual event (`delta`, `status`, `tool`, `diff`, `warning`, `error`, or cancellation/termination) after splitting/coalescing |
| downstream retained queue | 1,048,576 bytes (1 MiB) | Maximum retained undelivered event bytes per stream key in a consumer buffer |
| HTTP response body | 8,388,608 bytes (8 MiB) | Total observed body bytes per direct NVIDIA completion |

Rules:

- Count and truncate using byte length (`Buffer.byteLength` or equivalent), not JavaScript string length.
- When a multibyte UTF-8 sequence would be split, hold the partial bytes in the line buffer; never emit a corrupted surrogate string.
- When a budget is exceeded, stop growing the retained buffer, continue draining the stream if needed for liveness, and attach `truncation` metadata: `{ stream, limitBytes, observedBytes, discardedBytes }` after secret redaction.
- **Emitted-event and queue policy:** any text event above 262,144 bytes is split losslessly at UTF-8 boundaries into ordered events of the same type, stream key, and status; no prefix is discarded and splitting alone emits no warning. Non-text metadata that cannot fit produces named `event_overflow` and an `unsafe_completion` terminal result. A downstream queue never drops events: it may coalesce adjacent deltas only while the result remains within the single-event ceiling, otherwise the producer awaits capacity. The queue never exceeds 1,048,576 retained bytes per stream key, cancellation/deadline releases blocked producers, and delivery remains FIFO. Truncation warnings occur only when an upstream byte budget actually discards bytes, before later events continue.
- If truncation or malformed protocol data prevents safe recovery of required fields, return a named non-success result. Do not emit partial assistant text, native session IDs, or tool outcomes as success.
- Diagnostics, warnings, errors, events, logs, handoff updates, and returned text include only metadata—never discarded bytes or secret-shaped substrings near the cut boundary. Assert this separately for every sink.

### Wave 03 event surface

Wave 03 extends the existing `AgentEvent` contract narrowly instead of implementing the Wave 07 event-tree redesign:

- current `{ type: 'delta' }` is the Wave 03 runtime representation of the roadmap's future `output.delta` wire name;
- existing `status`, `tool`, `diff`, `warning`, and `error` remain provider-neutral and all use the same textual event ceiling and queue policy;
- add a provider-neutral `cancelled`/termination event carrying typed cause/stage metadata and redacted text; this is the Wave 03 representation of future `turn.cancelled`;
- a later Wave 07 migration may rename/envelope these events for the UI, but it may not weaken the byte bounds or termination semantics established here.

## Git/non-Git tri-state measurement bounds

Replace fingerprint-only boolean inference with `classifyWorkspaceChange(before, after)` returning:

- `unchanged` — both snapshots succeeded and hashes/evidence match under the same policy version.
- `changed` — both snapshots succeeded and evidence differs.
- `unmeasurable` — either snapshot failed, policy version mismatched, symlink/denied/oversized entry blocked measurement, workspace access changed between snapshots, or non-Git scan exceeded budget.

Git measurement (existing repo):

- Include porcelain status, staged/unstaged diff against `HEAD`, and untracked file content up to 5 MiB per file.
- Apply the same exact reserved review exclusion as Medusa: `.agents/reviews/**` is excluded from Git status/diff/untracked evidence so creating packet/report metadata does not invalidate freshness. No other `.agents/**` path is excluded implicitly.
- Ignored private/runtime/build paths are absent only when Git itself proves they are ignored and untracked. Any path classified sensitive by the fail-closed union of Wave 02 `isCredentialPath()` and Medusa `isSensitivePath()` (including credential filenames, `.env*`, `lamine*.yaml`, `.npmrc`, auth/session databases, `*.pem`, `*.key`, and equivalent protected patterns) that is tracked or non-ignored is a named security failure and makes measurement `unmeasurable`; it is never silently excluded. All other tracked and non-ignored paths remain measured.
- **Trust-critical rule:** any untracked file above the per-file content budget makes the snapshot `unmeasurable`. Do not fall back to size/mtime identity for oversized untracked files.
- Hash only stable normalized evidence; record which Git commands contributed.
- **Git symlink policy:** inspect symlinks with `lstat`/`readlink`, never `stat`/content traversal. Hash link metadata plus target text only when the resolved target stays inside the workspace and exists. External, broken, escaping, or concurrently retargeted symlinks in tracked, staged, or untracked evidence make the snapshot `unmeasurable`.
- A successfully captured branch or `HEAD` difference between complete before/after snapshots is `changed`. Branch/`HEAD` movement while either individual snapshot is being assembled is `unmeasurable`.
- Git command failure, removed `.git`, permission errors, concurrent mutation during measurement, or any budget overshoot → `unmeasurable`.

Non-Git measurement (new bounded snapshot):

- Walk only the workspace root. Stable exclusions (never hashed, never traversed):
  - `.git/` metadata directory when present;
  - `.agents/reviews/**`, the exact workspace-local Medusa packet/report metadata path required by the review contract; artifacts remain forbidden there;
  - private continuity and profile paths: `handoff.md`, `users/*.md`, `vault/**` (templates under `vault/templates/**` remain excluded from measurement);
  - the exact configured ZeuZ private state root only when it resolves inside the workspace and passes the Wave 02 private-state policy; an external state root is outside the walk. This is not a blanket exclusion for arbitrary `.agents/**` content;
  - dependency/build artifacts: `node_modules/`, `dist/`, `coverage/`, `*.tsbuildinfo`;
  - editor/OS noise: `.DS_Store`, `.idea/`, `.vscode/`, `*.swp`, `*~`.
- Default scan budget: 512 files and 32 MiB total hashed content; any overshoot → `unmeasurable` with redacted reason.
- Any path classified sensitive by the fail-closed union of Wave 02 `isCredentialPath()` and Medusa `isSensitivePath()` makes a non-Git snapshot `unmeasurable` with redacted metadata. Sensitive paths are denied/unsafe evidence, never stable exclusions.
- **Symlink policy:** internal symlinks hash link metadata plus target text without traversal only when the resolved target remains inside the workspace boundary. External targets, broken symlinks, and symlink escapes → `unmeasurable`.
- Permission denied, concurrent mutation during scan, empty/clean workspace, and observable create/modify/remove each map to explicit tri-state outcomes in the mandatory test matrix.
- A change confined to stable exclusions is `unchanged` when both snapshots otherwise succeed under the same policy version.

Tri-state rules:

- `unmeasurable` never equals `unchanged`.
- `unmeasurable` blocks fallback/replay and blocks review freshness when delivery depends on measurement (`REVIEW_BLOCKED` or named controller error).
- Read-only non-Git workspaces with successful identical snapshots may complete without mandatory review.
- Writable non-Git workspaces with observed change trigger the same fail-closed review path as Git.

## Cancellation resumability

On timeout or external cancellation:

- Persist native provider session IDs and provider-neutral resume handles already parsed before termination.
- Append a provider-neutral termination record (`turn.cancelled`, `turn.failed`, or equivalent) with cause, stage, and redacted metadata.
- Save session state before rethrowing/blocking delivery so a subsequent turn can resume when the adapter supports it.
- Do not widen `plan`/`agent`/`yolo` authority, secret-bearing environment, or writable boundary on resume.
- Do not implement Wave 04 task records, queues, or ownership.

## Risks and controls

| Risk | Control |
| --- | --- |
| Unbounded memory survives behind incremental parsing | Byte budgets on every accumulator and downstream delta buffer; tests assert bounded retained bytes during huge-stream replay |
| Truncation leaks secrets at boundary | Redaction before metadata emission; adversarial secret-shaped chunk tests |
| `unmeasurable` treated as unchanged | Tri-state policy module used by fallback, review gate, and delivery; negative tests for `undefined` fingerprints |
| Reviewer timeout becomes `CHANGES_REQUIRED` or silent pass | Reuse Wave 02 `REVIEW_BLOCKED` paths; conformance tests for review/remediation timeout |
| Orphan timers/listeners after cancel | Runner cleanup contract; leak tests on success/failure/timeout/cancel |
| False claim of descendant kill | Document actual signal target; optional process-group path behind explicit capability flag |
| Legacy runner disables new safety defaults | Compatibility flag off by default; tests prove defaults remain active |
| Fixture parsers drift from incremental path | Replay Wave 01 fixtures through byte-chunked harness before and after migration |
| NVIDIA direct route bypasses bounds | Separate injectable HTTP transport with bounded body reader and direct-route fixtures |
| Partial success after truncation | Named `unsafe_completion` / `parse_failure`; negative tests forbid success paths |
| Workspace changes after review | Re-check tri-state immediately before delivery; stale freshness → `REVIEW_BLOCKED` |

## Acceptance criteria

- A distinct first commit contains green characterization tests for the verified baseline gaps. With injected event order, characterize both timeout/cancel-before-availability and availability-before-timeout/cancel; abort-before-close and close-before-abort; abort-before-error and error-before-abort; and native-session observation-before-cancel versus successful-close-before-save. Each case asserts the current terminal winner, exactly-once settlement, fallback eligibility, and persisted state. Ordinary timeout/cancellation currently does not trigger fallback even when the workspace is unchanged; only an availability-classified failure that wins first may fall back when measurable and unchanged; changed/unmeasurable states block replay; successful close persists native session IDs while abort/error/cancel paths may lose partial state. A later commit introduces the target contract without a red CI suite.
- Shared runner contract proves completion, timeout, cancellation, spawn failure, escalation stages, cleanup, and truncation metadata under deterministic injected clocks/processes.
- Abort during active streaming is covered in both characterization and acceptance suites.
- Deadline validation accepts the configured maximum, rejects above-maximum and very-large values, and rejects `Infinity` with a named configuration error.
- All six adapters pass incremental parsing conformance with fragmented JSONL/text, CRLF, trailing partial lines, split UTF-8, malformed events, and oversized single lines—without real provider CLIs. NVIDIA coverage includes both the Copilot-backed CLI route (`nvidia.jsonl`) and the direct HTTP JSON tool loop with new deterministic fixtures.
- Every provider-neutral textual event (`delta`, `status`, `tool`, `diff`, `warning`, `error`, and cancellation/termination) proves the emitted-event (256 KiB) and downstream-queue (1 MiB per stream key) byte ceilings. Deterministic tests cover UTF-8-safe lossless splitting, oversized non-text `event_overflow`, high event counts, slow consumers, FIFO ordering, cancellation of blocked producers, upstream truncation warnings before continued delivery, and bounded retained bytes across all six adapters.
- Separate overflow assertions exist for stdout, stderr, partial-line, raw-event, and HTTP response-body budgets; secret-shaped boundary chunks never appear in errors, events, logs, handoff, or returned results.
- Unsafe truncation/parse failure returns named non-success results; no partial-success delivery path remains.
- Workspace mutation after review but before delivery remains blocked by the Wave 02 fail-closed gate.
- Listeners, timers, temporary resources, transport handles, and child handles are released on success, failure, timeout, and cancellation.
- Controller applies separate producer/review/remediation deadlines and preserves Wave 02 fail-closed delivery (`REVIEW_BLOCKED` on reviewer timeout/failure or unprovable freshness).
- Workspace classification returns only `changed`, `unchanged`, or `unmeasurable` for Git and non-Git cases covered in the mandatory test matrix.
- Cancellation leaves session state resumable in tests without permission elevation.
- Legacy runner remains available for one release behind a documented flag with compatibility tests.
- `pnpm check`, `pnpm build`, and `node bin/zeuz health` pass on bundled Node 24.
- A fresh cross-family Medusa `PASS` covers every changed artifact; otherwise the wave ends `REVIEW_BLOCKED`.
- Diff contains no secrets, private profiles, vault data, or unrelated files.

## Testing strategy

1. **Characterization (pre-production)** — freeze current `process.ts`, controller deadline absence, Git-only fingerprint, buffer-unbounded behavior, ordinary timeout/cancellation not qualifying for fallback, availability-only fallback when unchanged, successful-close persistence versus abort/error/cancel partial-state loss, and oversized-untracked size/mtime fallback in a green commit.
2. **Acceptance (production)** — failing tests written against the target contract, then made green by implementation.
3. **Mandatory matrix** — all cases listed in `docs/waves/wave-03-tasks.md` under Engineering.
4. **CI boundary** — unit/CI tests use injected runtimes only; no real providers, credentials, network, or long wall-clock sleeps.
5. **Opt-in smokes** — if run, require explicit env gate, fresh health, and separate reporting from deterministic proof.

## Rollback

Retain the pre-Wave-03 `runProcess` implementation behind the new runner interface for exactly one release.

- Activation: explicit configuration flag documented in README/Wave notes; default remains the bounded runner.
- Verification: compatibility tests exercise both paths; the bounded path stays default in CI.
- Removal: delete the legacy wrapper in the next release after one bounded-runner release ships.
- Rollback must not restore delivery without a fresh cross-family Medusa `PASS`, permit fallback after `changed`/`unmeasurable`, or treat reviewer timeout as success.
