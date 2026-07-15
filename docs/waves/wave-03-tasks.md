# Wave 03 task list

Status legend: `[ ]` pending, `[~]` in progress, `[x]` complete, `[!]` blocked.

This checklist is the persistent execution record for Wave 03. Check an item only after inspecting evidence.

## Brainstorming

- [x] Bootstrap repository context in the required order (`AGENTS.md`, user profile, `handoff.md`, vault indexes).
- [x] Verify clean worktree, fast-forward `main` to Wave 02 merge `8909551`, confirm `d09fcc7` is an ancestor, and create branch `agent/wave-03-process-resilience-streaming`.
- [x] Read the frozen Wave 03 contract and characterize `src/process.ts`, adapter runtime, controller deadlines, workspace fingerprinting, and review-gate interactions.
- [x] Run baseline health and record provider degradation honestly before delegation. Evidence on bundled Node 24.14.0: shallow `node bin/zeuz health` exit 0 passed Codex, Cursor, Claude Code 2.1.210, Agy, Copilot, and NVIDIA. Deep health passed GLM (11,094 ms), DeepSeek (43,426 ms), and MiniMax (7,240 ms); Kimi returned NVIDIA HTTP 404 and Qwen timed out. Two substantive GLM delegates later failed through the Copilot harness (`copilot exited with code 1`); two direct GLM HTTP probes reached `z-ai/glm-5.2` but returned 429. Composer produced the planning artifacts after the requested fallback.
- [x] Run baseline tests at Wave 02 merge `8909551` before Wave 03 edits. Evidence: `pnpm check` exit 0 on bundled Node 24.14.0; 105 TypeScript tests, 18 Node skill-validator tests, 6 Argos Python tests, 10 installer checks, and 5 AWS MCP tests passed; secret scan passed 170 tracked files. `pnpm build` also exited 0.
- [x] Freeze requirements, non-objectives, risks, acceptance criteria, testing strategy, and rollback in the PRD.

## Architecture

- [x] Write `docs/waves/wave-03-prd.md` with outcome, verified baseline, architecture, deadline defaults, process-tree semantics, byte bounds, tri-state measurement, cancellation resumability, acceptance, testing, and one-release legacy rollback.
- [x] Specify pure policy modules for deadlines, termination classification, workspace tri-state measurement, truncation/redaction metadata, and unsafe-completion failure classification in the PRD.
- [x] Specify the shared child-process runner result contract (completion, timeout, cancellation, spawn failure, exit failure, escalation stage, truncation, unsafe completion).
- [x] Specify the injectable HTTP transport contract for the NVIDIA direct JSON tool loop (bounded body reader, abort/deadline, truncation, unsafe completion).
- [ ] Keep GLM on the Copilot BYOK harness until an opt-in direct NVIDIA completion returns HTTP 200; after proof, move only GLM to the direct transport and remove its obsolete process fixture/dependency without changing the independent Copilot provider or DeepSeek route.
- [x] Specify `AbortSignal` ownership per phase and forbid reuse across producer/review/remediation.
- [x] Document macOS/Linux signal semantics (direct child PID default; optional isolated process group with group-directed `kill(-pgid, …)` behind explicit capability).
- [x] Document byte-budget defaults and UTF-8-safe accumulator behavior, including emitted-event (256 KiB) and downstream-queue (1 MiB per stream key) ceilings with coalescing/backpressure rules.
- [x] Document Git and non-Git tri-state measurement bounds, deny patterns, and `unmeasurable` rules.
- [x] Plan the one-release legacy runner flag, default-off behavior, and removal criteria.

## Engineering

### Characterization checkpoint (separate green commit before production)

- [x] Add characterization tests proving `src/process.ts` accumulates unbounded stdout/stderr.
- [x] Add characterization tests proving untyped `SIGINT` → `SIGKILL` escalation after 1.5s without typed termination metadata, including isolated proof that pre-abort plus spawn failure can propagate SIGINT to the caller group.
- [x] Add characterization tests proving `send`, `ask`, `runReview`, and `remediate` lack a shared deadline policy.
- [x] Add green injected-order characterization for timeout/cancel before availability failure and availability failure before timeout/cancel. Assert the current terminal winner, exactly-once settlement, fallback eligibility, and that ordinary timeout/cancellation does not match the availability fallback predicate.
- [x] Add green injected-order characterization for abort before close and close before abort, plus abort before error and error before abort, including abort during active streaming. Assert the current terminal winner, exactly-once settlement, observed output, and cleanup gaps.
- [x] Add green injected-order characterization for native-session observation before cancellation versus successful close before controller save. Assert that `recordRun` persists only a returned successful result while abort/error/cancel may lose partial native state.
- [x] Add characterization tests proving availability-classified producer failures may trigger fallback only when the workspace is measurably unchanged; `changed` or `unmeasurable` states block replay.
- [x] Add characterization tests proving `workspaceFingerprint()` is `undefined` outside Git and the controller infers writable change from that ambiguity.
- [x] Add characterization tests proving Git untracked files above 5 MiB fall back to size/mtime identity instead of `unmeasurable`.
- [x] Add characterization tests proving adapter/fixture paths can depend on complete stdout/stderr buffers.
- [x] Add characterization tests proving `NvidiaAdapter.runDirect()` uses unbounded `fetch` + `response.json()` outside the CLI fixture path.
- [x] Commit the green characterization checkpoint separately before production contract changes (`20b7c98`).

### Shared runner and deadlines

- [ ] Implement the injected process runner with typed termination, cleanup, and truncation metadata.
- [ ] Implement deadline resolution/validation (0, negative, `NaN`, valid maximum, above maximum/very large, `Infinity`, and exact-boundary cases) with injectable clocks/timers.
- [ ] Implement interrupt-to-kill escalation stages with no orphan timers/listeners.
- [ ] Cover mandatory process cases: completes before deadline; ignores interrupt; exits at each stage; kill fails; abort before start; abort during active streaming; abort on close; repeated abort; spawn error; null exit code; output after terminal decision.
- [ ] Cover resource cleanup in every terminal state: listeners, timers, temporary resources, child handles, and transport handles released on success, failure, timeout, and cancellation.
- [ ] Retain the legacy runner behind a documented one-release compatibility flag with tests.

### Bounded streaming and incremental parsing

- [ ] Implement byte-bounded stdout, stderr, partial-line, raw-event, and HTTP response-body accumulators with UTF-8-safe boundaries.
- [ ] Emit redacted truncation diagnostics only; never include discarded payload or secret-shaped content.
- [ ] Return named non-success results (`unsafe_completion`, `parse_failure`, or equivalent) when truncation or malformed protocol data prevents safe final-result reconstruction; forbid partial-success delivery.
- [ ] Implement incremental parsers for Codex, Cursor, Claude, Copilot, and Agy using Wave 01 fixtures.
- [ ] Implement both NVIDIA routes: Copilot-backed CLI (`nvidia.jsonl`) and direct HTTP JSON tool loop with new deterministic fragmented/truncated/malformed fixtures.
- [ ] Add injectable HTTP transport to `AdapterRuntime` for the direct NVIDIA route; do not rely on global unbounded `fetch` + `response.json()` in tests or production.
- [ ] Preserve the existing provider-neutral `AgentEvent` surface and its roadmap mapping: current `delta` represents future `output.delta`; add narrow cancellation/termination metadata for future `turn.cancelled`; defer envelope/UI renaming to Wave 07. Enforce the 262,144-byte ceiling for every textual `delta`, `status`, `tool`, `diff`, `warning`, `error`, and cancellation/termination event plus the 1,048,576-byte queue ceiling per stream key. Split oversized text losslessly at UTF-8 boundaries; oversized non-text metadata produces named `event_overflow`/`unsafe_completion`. Coalesce only within the event ceiling, never drop, block on backpressure, and release waits on cancellation/deadline.
- [ ] Cover mandatory parsing cases: empty chunks, byte-by-byte chunks, split CRLF, multiple lines per chunk, trailing line without newline, split JSON, split multibyte UTF-8, malformed events.
- [ ] Cover mandatory streaming/backpressure cases across all six adapters and every textual event type (`delta`, `status`, `tool`, `diff`, `warning`, `error`, cancellation/termination): oversized text is split losslessly with no discarded prefix and each event ≤ 256 KiB; oversized non-text metadata yields identical `event_overflow`/`unsafe_completion`; high event counts retain ≤ 1 MiB per stream key; slow consumers cause bounded coalescing or producer wait, never drop; cancellation releases waits; FIFO ordering and bounded retained bytes hold; upstream truncation warnings precede subsequent delivery.
- [ ] Cover mandatory overflow matrix separately: stdout budget exceeded; stderr budget exceeded; partial-line budget exceeded; raw-event budget exceeded; HTTP response-body budget exceeded; retained bytes remain bounded (no RSS assertions).
- [ ] Assert secret-shaped chunks near truncation boundaries never appear in errors, events, logs, handoff updates, or returned results.
- [ ] Prove conformance for all six adapters with injected runtimes only (no real CLIs or live HTTP).

### Workspace tri-state measurement

- [ ] Replace boolean/undefined inference with explicit `changed | unchanged | unmeasurable` evidence.
- [ ] Cover Git cases with expected tri-state: clean → `unchanged`; dirty/staged/unstaged → `changed`; untracked within budget → `changed` when content differs; untracked above 5 MiB per file → `unmeasurable`; successfully captured branch/HEAD difference between snapshots → `changed`; branch/HEAD mutation during one snapshot → `unmeasurable`; exact `.agents/reviews/**`-only change → `unchanged`; other `.agents/**` change → measured; tracked/non-ignored credential path → security failure/`unmeasurable`; internal symlink unchanged → `unchanged`; external/broken/escaping/retargeted symlink → `unmeasurable`; Git command failure, repo removal, permission error, or concurrent mutation → `unmeasurable`.
- [ ] Cover non-Git cases with expected tri-state: unchanged → `unchanged`; create/modify/remove → `changed`; internal symlink metadata/target unchanged → `unchanged`; external/broken symlink, permission denial, concurrent mutation, budget overshoot, or any path matched by the union of Wave 02 `isCredentialPath()` and Medusa `isSensitivePath()` → `unmeasurable`; change confined to stable exclusions → `unchanged`. Stable exclusions are exact: `.agents/reviews/**`, private profile/vault/handoff, the verified configured state root when inside the workspace, build artifacts, and editor/OS noise. Sensitive paths are denied evidence rather than exclusions, and arbitrary `.agents/**` content remains measured.
- [ ] Block fallback/replay when measurement is `changed` or `unmeasurable`.
- [ ] Block review freshness/delivery when measurement is `unmeasurable` and freshness is required.
- [ ] Block delivery when workspace becomes `changed` after review but before completion; require fresh cross-family review evidence.

### Controller integration and resumability

- [ ] Apply separate producer, review, and remediation deadline budgets in the controller.
- [ ] Classify producer timeout/cancellation without triggering fallback when workspace is `changed` or `unmeasurable`; ordinary timeout/cancellation must not be treated as availability fallback even when unchanged.
- [ ] Preserve Wave 02 fail-closed review: reviewer timeout/failure → `REVIEW_BLOCKED`; remediation timeout/failure blocks delivery.
- [ ] Persist resumable session state on cancellation (native session ID and provider-neutral handles only; no permission elevation).
- [ ] Cover post-cancellation turn: new turn succeeds; only proven native state is reused; no secret environment reintroduction; timeout/cancellation during active streaming leaves persisted state consistent with close/error characterization.
- [ ] Preserve only the provider-neutral incremental event surface required for Wave 03: runtime `delta` (the future `output.delta`), `status`, `tool`, `diff`, `warning`, `error`, and cancellation/termination, all under the shared byte/queue policy. Do not build the Wave 07 envelope, event tree, or UI.

### Documentation

- [ ] Update public documentation only where Wave 03 behavior changes (runner contract, HTTP transport, deadlines, tri-state measurement, legacy flag).

## Reviewer

- [ ] Run focused deterministic tests for runner, parsing, measurement, controller, and compatibility paths.
- [ ] Run `pnpm secrets:check` before every commit and push.
- [ ] Run `pnpm check`, `pnpm build`, and `node bin/zeuz health` with bundled Node 24.
- [ ] Run proportional opt-in real smokes only after a fresh health check; report separately from CI proof.
- [ ] Retry one bounded opt-in direct GLM completion only after quota recovers. Require HTTP 200 plus expected content before removing GLM's Copilot process route; record HTTP 429 as blocked, not pass.
- [ ] Generate a fresh Medusa evidence packet and initialized report for changed artifacts.
- [ ] Obtain a cross-family Medusa `PASS`; remediate any `CHANGES_REQUIRED` finding and re-review.
- [ ] Validate the final report structurally and confirm workspace freshness immediately before delivery.

## Optimizer and GitHub

- [ ] Remove duplicated runner/parser logic and avoid abstractions beyond Wave 03 needs.
- [ ] Confirm the legacy rollback flag cannot bypass deadlines, bounds, tri-state honesty, or fail-closed review.
- [ ] Confirm unit/CI paths do not start real providers, Ink, network calls, or credential reads.
- [ ] Inspect staged, unstaged, and untracked files for scope and private data.
- [ ] Run `git diff --check` before delivery.
- [ ] Open a draft PR after the first reviewed checkpoint commit; keep description, commits, and checks current.
- [ ] Do not merge the Wave 03 PR.
