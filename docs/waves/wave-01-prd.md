# Wave 01 PRD — Deterministic orchestration and adapter test foundation

Status: implementation complete; formal Medusa review blocked by existing sensitive-template classification
Contract: `AGENTS.md` and `docs/roadmap_candidate.md` at Wave 01 branch creation
Branch: `agent/wave-01-orchestration-foundation`

## Outcome

Make controller orchestration, adapter protocols, command dispatch, clocks, IDs, workspace fingerprints, and stores deterministic under tests without starting Ink or invoking a real provider. Preserve current public behavior through default constructors and compatibility wrappers while later waves migrate.

## Requirements

- Characterize current default-primary, explicit session model selection, fallback, review, persistence, command, store, and adapter behavior before changing production construction.
- Inject narrow clock, ID, fingerprint, store, adapter-registry, and controller dependencies while retaining current defaults.
- Keep the root controller as the only orchestrator. Delegates cannot recursively delegate.
- Permit fallback only after a pre-execution failure when the workspace is measurably unchanged. An unavailable or changed fingerprint is not proof of safety.
- Cover default GPT-5.6 Sol selection, explicit session selection, safe fallback, cross-family review, remediation/re-review, and persisted provider/session state deterministically.
- Extract a UI-independent slash-command parser and dispatcher foundation with valid, invalid, and ambiguous cases. Keep rendering and picker redesign in Wave 07.
- Validate sanitized protocol fixtures for Codex, Cursor, Claude, Copilot, Agy, and NVIDIA without installed provider CLIs, credentials, network, quota, or Ink.
- Keep real provider smokes explicit and opt-in. They are supplemental diagnostics, never CI evidence.
- Document and test compatibility wrappers and rollback.

## Non-goals

- Terminal redesign, full command palette/dropdown, workflow tree, or Ink component tests.
- Durable asynchronous task scheduling, dependencies, cancellation, ownership, or worktree isolation.
- Full Medusa fail-closed policy, provider permission conformance, or secret-boundary redesign.
- Skill/Pantheon imports, registry, specialist lifecycle, vault redesign, MCP, Telegram, or npm release.
- Provider protocol redesign, broad controller rewrite, or later-wave state migrations.
- Treating real smokes, shallow health, or a delegate self-report as deterministic proof.

## Five-stage delivery flow

### Brainstorming

Characterization found three high-value seams: concrete controller construction, global time/UUID/state roots, and command parsing embedded in Ink. Adapter parsers are coupled to process launch. A GLM 5.2 deep probe passed, but the bounded architecture delegate degraded during the longer turn and was stopped without workspace changes; its output is not design evidence.

### Architecture

1. Add small runtime interfaces for clock, ID generation, and workspace fingerprinting with production defaults.
2. Let stores and the adapter registry accept dependencies while their zero-argument constructors preserve behavior.
3. Let `ZeuzController.create` accept a dependency bundle; keep the public factory and controller methods stable.
4. Extract command parsing/resolution/dispatch from `ui.tsx`; UI remains a compatibility caller.
5. Inject process/runtime functions into adapters, then replay sanitized fixture streams through normal adapter `run` methods.
6. Put real smokes behind an explicit environment gate and a script excluded from `pnpm check`.

No generic dependency-injection framework, event bus, or new task engine is introduced.

### Engineering

Implement characterization tests first, then production seams in small groups. Prefer pure functions and constructor options. Preserve exported names and zero-argument construction. Keep fixture data synthetic and inspectable.

### Reviewer

Run the official Medusa packet flow. If its known sensitive-template classification still blocks, retain formal `REVIEW_BLOCKED` and obtain an independent read-only review from another model family. Any `CHANGES_REQUIRED` finding must be remediated and reviewed again.

### Optimizer

After correctness, remove duplicated fixture harness code, keep APIs narrow, verify no provider/Ink imports enter unit execution paths, and avoid speculative abstractions not exercised by Wave 01 tests.

## Risks and controls

| Risk | Control |
| --- | --- |
| `undefined === undefined` incorrectly labels a non-Git workspace unchanged and permits fallback replay | Require two available equal fingerprints; test unavailable and changed fingerprints |
| Dependency injection changes runtime defaults | Zero-argument constructors and compatibility tests compare current defaults |
| Fixture parsers drift from real wire protocols | Fixtures mirror sanitized observed shapes; optional real smokes remain separate |
| Adapter tests accidentally launch providers | Inject executable/process/HTTP boundaries and fail tests on unplanned calls |
| Command extraction expands into Wave 07 | Extract parsing and dispatch only; keep rendering/pickers in Ink |
| Global environment mutation makes tests flaky | Inject state roots and deterministic runtime values; restore unavoidable env changes |
| Cross-family review route is unavailable | Report `REVIEW_BLOCKED`; never convert missing review into `PASS` |

## Acceptance criteria

- Deterministic tests cover default primary, explicit session model, safe fallback, review, remediation/re-review, and persistence.
- A test proves no fallback/retry occurs after a failure with changed or unmeasurable workspace state.
- Every adapter passes a sanitized fixture success test and representative protocol failure coverage without a real provider.
- Command parser/dispatcher tests cover successful dispatch, invalid syntax/name/arguments, aliases, and ambiguity.
- `pnpm test` does not import Ink, require provider executables, access the network, read credentials, or consume quota.
- Real smokes require an explicit opt-in flag, recheck health first, and are reported separately from CI.
- Existing construction paths, public controller methods, and zero-argument registry/store usage remain compatible.
- Required checks and focused tests are recorded accurately; supply-chain preflight blockers are not bypassed.
- The diff contains no secrets, private profiles, vault data, raw provider events, or unrelated files.

## Rollback

Revert the Wave 01 commits. Default constructors remain the compatibility boundary, so no state migration or provider configuration rollback is required. Fixture and smoke scripts are additive; removing them does not alter stored sessions or tasks.
