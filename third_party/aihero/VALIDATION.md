# AIHero validation record

Status: validated for bounded ZeuZ routing at the pinned revision `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76` (2026-08-26).

This record explains why the imported skills may be indexed as `trust: enabled` and `enablement: enabled`. In ZeuZ, that state means that the source and manifest passed the checks below; it does not make upstream prompt text authoritative, grant tools, authorize network access, or permit secret handling. Every activation is still labeled untrusted reference material, and the ZeuZ contract, permission mode, and secret boundary win.

## Validation gates

| Gate | Evidence and decision |
| --- | --- |
| Source identity | `SOURCE.json` pins `https://github.com/mattpocock/skills` to the reviewed commit and records the 25 imported source paths. |
| License | The upstream MIT license is preserved in [`LICENSE`](./LICENSE). No upstream endorsement is implied. |
| File integrity | `SOURCE.json` records one SHA-256 inventory digest per installed skill. Catalog construction recomputes every inventory and fails closed with `AIHERO_INTEGRITY_MISMATCH` on drift, missing scope, or malformed provenance. |
| Manifest validity | Each row below has a parsed `zeuz.manifest.yaml` with the `zeuz/aihero` namespace, pinned import marker, explicit trust/enablement state, bounded context budget, declared network policy, and an explicit tool allowlist. |
| Routing validity | Triggers compile during catalog validation. `disable-model-invocation: true` is preserved from upstream and limits those skills to explicit slash invocation. Dependencies are resolved by canonical skill name before activation. |
| Tool boundary | Every imported manifest has `allowedTools: []`. Upstream scripts and templates are prompt reference only; the adapter/controller permission layer is the only source of executable tool authority. Plan mode remains read-only and only the root orchestrator may delegate. |
| Network boundary | `networkPolicy: declared` is surfaced in the activation envelope but does not authorize a request. Network access requires an explicit ZeuZ capability and tool path; the router never executes upstream shell snippets or fetches their links. |
| Secret boundary | The repository secret scan covers the imported snapshot and rejects credential-shaped content. The imported instructions do not receive `.env`, `lamine.yaml`, credential files, auth state, or provider keys. Any upstream setup guidance remains untrusted documentation. |
| Compatibility review | The boundary notes below record known upstream behaviors that would conflict with ZeuZ if interpreted as executable authority. They are constrained by the global contract and direct tool guards. |

## Per-skill inventory

Each imported skill passed all gates above. The source path is included so the installed flat directory can be reconciled against the pinned upstream scope.

| Skill | Upstream scope | Result |
| --- | --- | --- |
| `ask-matt` | `skills/engineering/ask-matt` | PASS |
| `code-review` | `skills/engineering/code-review` | PASS |
| `codebase-design` | `skills/engineering/codebase-design` | PASS |
| `diagnosing-bugs` | `skills/engineering/diagnosing-bugs` | PASS |
| `domain-modeling` | `skills/engineering/domain-modeling` | PASS |
| `grill-with-docs` | `skills/engineering/grill-with-docs` | PASS |
| `implement` | `skills/engineering/implement` | PASS |
| `improve-codebase-architecture` | `skills/engineering/improve-codebase-architecture` | PASS |
| `prototype` | `skills/engineering/prototype` | PASS |
| `research` | `skills/engineering/research` | PASS |
| `resolving-merge-conflicts` | `skills/engineering/resolving-merge-conflicts` | PASS |
| `setup-matt-pocock-skills` | `skills/engineering/setup-matt-pocock-skills` | PASS |
| `tdd` | `skills/engineering/tdd` | PASS |
| `to-spec` | `skills/engineering/to-spec` | PASS |
| `to-tickets` | `skills/engineering/to-tickets` | PASS |
| `triage` | `skills/engineering/triage` | PASS |
| `wayfinder` | `skills/engineering/wayfinder` | PASS |
| `wizard` | `skills/engineering/wizard` | PASS |
| `grill-me` | `skills/productivity/grill-me` | PASS |
| `grilling` | `skills/productivity/grilling` | PASS |
| `handoff` | `skills/productivity/handoff` | PASS |
| `teach` | `skills/productivity/teach` | PASS |
| `to-questionnaire` | `skills/productivity/to-questionnaire` | PASS |
| `wait-what` | `skills/productivity/wait-what` | PASS |
| `writing-for-agents` | `skills/productivity/writing-for-agents` | PASS |

## Compatibility boundaries

- `wizard` and `setup-matt-pocock-skills` may describe writing configuration or credentials. ZeuZ does not execute those snippets automatically; secret files remain denied, and private configuration follows ZeuZ's `lamine.yaml`/`.env` boundary.
- `handoff` is reference material only. ZeuZ's root `handoff.md` protocol, size limit, and no-secret rule take precedence over any upstream temporary-file or persistence convention.
- `code-review` and any other imported skill cannot spawn specialists. Only the root ZeuZ orchestrator may delegate, and a delegated model cannot create nested delegates.
- `research`, `grill-with-docs`, and related skills may mention external sources. `declared` makes that fact visible; it is not permission to browse or execute a network tool.

The relevant regression and negative-path tests are in `test/skills.test.ts`, `test/skill-registry.test.ts`, `test/orchestration.test.ts`, and the provider sandbox tests. Re-run `pnpm check`, `pnpm build`, `node bin/zeuz skill validate --write-index`, and `pnpm secrets:check` when refreshing this snapshot or changing its manifests.
