# Wave 05 tasks — Portable skill registry and provenance

Branch: `agent/wave-05-portable-skill-registry`

## Planning and characterization

- [x] Revalidate `main` at `c6396f3`, clean worktree, checks, gh auth
- [x] Create branch `agent/wave-05-portable-skill-registry`
- [x] Write `docs/waves/wave-05-prd.md`
- [x] Write `docs/waves/wave-05-tasks.md`
- [x] Commit characterization checkpoint (`test/wave-05-characterization.test.ts`)

## Registry core

- [x] `src/skill-registry/` types, parser, identity, digest, inventory
- [x] Generated catalog index + pantheon `zeuz.manifest.yaml` migration
- [x] Validator, trust lifecycle, resolver, progressive loader
- [x] `SkillRegistry` compatibility adapter (no controller rewrite)

## Provenance and bundles

- [x] Pin and document BMAD `717479bc…` and NVIDIA `8543c134…`
- [x] Import tooling + locks + ledger with exclusion reasons
- [x] Materialize `catalog/bundles/bmad` (53) and `catalog/bundles/nvidia` (230)
- [x] Reconciliation tests vs pinned inventories

## CLI and docs

- [x] `zeuz skill list|status|validate|install|update|remove|sync|check`
- [x] README, help text, command metadata
- [x] Package `files` allowlist excludes bundle trees from npm core

## Verification and review

- [x] Full test matrix from PRD (core)
- [x] `pnpm secrets:check`, `pnpm check`, `pnpm build`, health, `npm pack --dry-run`
- [x] Draft PR https://github.com/matheussluzz/ZeuZ-Agent/pull/6
- [ ] DeepSeek Medusa adversarial review (schema-valid JSON) — in progress
