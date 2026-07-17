# Wave 05 PRD — Portable skill registry and provenance

Status: in progress

Branch: `agent/wave-05-portable-skill-registry`

Frozen contracts: `AGENTS.md`, `docs/roadmap_candidate.md` (D01–D03), Waves 01–04 outcomes.

Baseline: Wave 04 merge `c6396f3efb3184d4952068f6da80759a2f3bff05`; `pnpm check` PASS (298 TypeScript tests, 18 skill tests, 6 Argos Python tests, 10 installer tests, 5 AWS MCP tests); `pnpm build` PASS; shallow `node bin/zeuz health` PASS for codex/copilot/nvidia.

## Problem

`src/skills.ts` hard-codes eight pantheon regex triggers and two dependency branches, lists every `skills/` directory as valid, injects full `SKILL.md` bodies on activation, and silently truncates with `selected.slice(0, 3)`. There is no metadata index, provenance, trust lifecycle, install/update/remove, or reproducible third-party sync.

## Outcome

Replace the hard-coded registry with a portable, progressive, auditable skill catalog that:

1. discovers Agent Skills-compatible metadata without loading bodies into list/search/status;
2. keeps the reviewed pantheon functional during migration;
3. imports complete pinned BMAD and NVIDIA catalogs into versioned workspace bundles;
4. records provenance, license, attribution, integrity, and trust per bundle and file;
5. validates metadata, dependencies, conflicts, budgets, tools, scripts, and network declarations offline;
6. keeps imported skills quarantined/disabled until explicit reviewed enablement;
7. exposes deterministic install/update/remove/sync CLI controls;
8. removes silent truncation and returns named budget/dependency errors;
9. enforces package and startup budgets with separate bundles when core would grow excessive.

## Non-goals

Wave 06 specialist personas/spawn, Wave 06–07 interactive `/skill` UI, script execution for third-party imports, npm publication, MCP catalog, automatic enablement of imported skills.

## Verified upstream sources (2026-07-16)

| Source | Canonical URL | Pinned revision | License / notice | Verified |
| --- | --- | --- | --- | --- |
| Agent Skills spec | https://agentskills.io/specification | 2026-07-16 page | Reference only | yes |
| BMAD-METHOD | https://github.com/bmad-code-org/BMAD-METHOD | `717479bc3f50f38119fd958b9e577a8bde2e0184` | MIT + `TRADEMARK.md` | yes |
| NVIDIA skills | https://github.com/NVIDIA/skills | `8543c134fe6d7fe8e05ea967a0403afe0e191795` | Apache-2.0 + CC BY 4.0 (`LICENSE`) | yes |

BMAD inventory at pin: 56 `SKILL.md` files (`src/core-skills`, `src/bmm-skills`, `web-bundles/*`, 3 under `test/fixtures` excluded from import). NVIDIA inventory at pin: 242 `SKILL.md` files.

Trademark boundary: BMAD names remain upstream attribution only; NVIDIA catalog is not ZeuZ branding or endorsement.

## Architecture

Modules under `src/skill-registry/`:

- `parser`, `identity` — Agent Skills frontmatter + ZeuZ `zeuz.manifest.yaml`
- `inventory`, `digest`, `provenance` — deterministic file inventory and locks
- `index` — generated catalog index (metadata only)
- `validator`, `trust` — fail-closed lifecycle transitions
- `resolver`, `loader` — routing, dependency closure, progressive activation
- `installer`, `sync` — staging, atomic promote, rollback
- `adapter` — preserves `SkillRegistry.list()` / `contextFor()` for controller callers
- `cli` — `zeuz skill list|status|validate|install|update|remove|sync|check`

Bundles:

- `skills/` — reviewed pantheon snapshot (enabled)
- `catalog/bundles/bmad/` — complete BMAD import (quarantined/disabled)
- `catalog/bundles/nvidia/` — complete NVIDIA import (quarantined/disabled)
- `catalog/locks/*.lock.json` — immutable revision + inventory digests

## Trust lifecycle

States: `quarantined` → `validated` → `disabled` → `enabled` (with `invalid` on integrity/schema failure).

- Third-party bundles enter `quarantined` + `disabled`.
- Pantheon enters `enabled` after migration validation.
- `validated` does not imply `enabled`.
- File/revision/license/override changes invalidate prior validation until re-run.

## Pantheon migration

Each pantheon skill receives `zeuz.manifest.yaml` with:

- canonical namespace `zeuz/pantheon`
- trigger regexes currently in `SKILL_TRIGGERS`
- dependencies (`metis → medusa`, `atena → prometeu, clio`)
- trust `enabled`, context budget contribution

Legacy `src/skills.ts` becomes a thin adapter over the new registry.

## Package and startup budgets (baseline-measured)

| Metric | Baseline (`c6396f3`) | Ceiling (core) | Evidence |
| --- | --- | --- | --- |
| npm pack file count | 282 | ≤ 350 | `npm pack --dry-run` (342 after registry; bundles excluded) |
| pantheon tree size | 444 KiB / 70 files | unchanged path | `du skills/` |
| catalog index metadata bytes | n/a | ≤ 512 KiB | generated index with 291 skills ≈ 93 KiB |
| list metadata bytes | full `SKILL.md` per activation | index records only | characterization + benchmark test |
| discovery latency | n/a | p95 ≤ 75 ms (fixtures, 5 samples) | `test/skill-registry-benchmark.test.ts` |

BMAD + NVIDIA imports live in `catalog/bundles/*` and are excluded from npm `files` when they would exceed core ceilings. Index still lists bundle metadata without loading bodies.

## Threat model

- Hostile skill content must not override `AGENTS.md`, permission mode, or reviewer gate.
- Symlinks, traversal, absolute paths, FIFO/device/socket, reserved names, and oversize trees are rejected at inventory.
- Sync/network only on explicit `zeuz skill sync`; normal discovery is offline.
- Logs/errors must not echo script bodies or secrets.
- Downstream ZeuZ terms must not restrict upstream-licensed reuse.

## Acceptance criteria

1. Characterization tests pass on baseline commit semantics until production replaces them.
2. Pantheon activation preserves Metis→Medusa and Atena→Prometeu+Clio without TypeScript special cases.
3. No silent truncation; budget exceed returns named error with selection + dependencies.
4. List/status/search read index only (test proves `SKILL.md` bodies not read).
5. BMAD/NVIDIA locks reconcile to pinned revisions with exclusion reason codes.
6. Imported skills remain disabled/quarantined in index.
7. `zeuz skill` commands documented in README/help with tests.
8. `pnpm check`, `pnpm build`, `node bin/zeuz health`, `pnpm secrets:check`, `npm pack --dry-run` pass.
9. Independent DeepSeek Medusa review with schema-valid JSON report.

## Rollback

1. Disable third-party bundles via lock `enabled: false` or remove bundle directories.
2. Restore previous `catalog/locks/*.lock.json` and index from transactional backup.
3. Pantheon remains available under `skills/` snapshot; adapter boundary allows reverting to pre-registry behavior without deleting user overrides.

## Test plan

- `test/wave-05-characterization.test.ts` (baseline, separate commit)
- `test/skill-registry*.test.ts` — parser, identity, inventory, validator, resolver, loader, sync, CLI
- `test/skill-registry-benchmark.test.ts` — discovery latency + metadata bytes
- `test/skill-registry-package.test.ts` — npm pack contents gate
- Existing `test/skills.test.ts` pantheon dependency cases remain green
- Official pantheon skill script tests unchanged
- Opt-in online sync replay separate from deterministic CI fixtures
