# Wave 05 tasks — Portable skill registry and provenance

Branch: `agent/wave-05-portable-skill-registry`

## Planning and characterization

- [x] Revalidate `main` at `c6396f3`, clean worktree, checks, gh auth
- [x] Create branch `agent/wave-05-portable-skill-registry`
- [x] Write `docs/waves/wave-05-prd.md`
- [x] Write `docs/waves/wave-05-tasks.md`
- [ ] Commit characterization checkpoint (`test/wave-05-characterization.test.ts`)

## Registry core

- [ ] `src/skill-registry/` types, parser, identity, digest, inventory
- [ ] Generated catalog index + pantheon `zeuz.manifest.yaml` migration
- [ ] Validator, trust lifecycle, resolver, progressive loader
- [ ] `SkillRegistry` compatibility adapter (no controller rewrite)

## Provenance and bundles

- [ ] Pin and document BMAD `717479bc…` and NVIDIA `8543c134…`
- [ ] Import tooling + locks + ledger with exclusion reasons
- [ ] Materialize `catalog/bundles/bmad` and `catalog/bundles/nvidia`
- [ ] Reconciliation tests vs pinned inventories

## CLI and docs

- [ ] `zeuz skill list|status|validate|install|update|remove|sync|check`
- [ ] README, help text, command-dispatch metadata
- [ ] Package `files` allowlist excludes private/runtime paths

## Verification and review

- [ ] Full test matrix from PRD
- [ ] `pnpm secrets:check`, `pnpm check`, `pnpm build`, health, `npm pack --dry-run`
- [ ] Draft PR (gh auth permitting)
- [ ] DeepSeek Medusa adversarial review (schema-valid JSON)
