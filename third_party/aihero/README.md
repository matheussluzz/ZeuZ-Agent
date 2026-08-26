# AIHero skills provenance

ZeuZ imports the stable engineering and productivity skills from [Matt Pocock's public skills repository](https://github.com/mattpocock/skills), promoted by [AIHero](https://www.aihero.dev/).

- Source revision: `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`
- Source revision date: 2026-08-24
- License: MIT; see [`LICENSE`](./LICENSE)
- Imported scope: 25 skills under `skills/engineering/` and `skills/productivity/`
- Excluded scope: source `misc/`, `in-progress/`, and deprecated material
- Integrity: per-skill inventory digests are recorded in [`SOURCE.json`](./SOURCE.json) and checked before the catalog is built
- Validation decision and compatibility boundaries: [`VALIDATION.md`](./VALIDATION.md)

The upstream skill bodies and their supporting files are copied without edits under `skills/`. ZeuZ adds only adjacent `zeuz.manifest.yaml` files. Those manifests provide the ZeuZ namespace, pinned import marker, routing triggers, capability tags, context budget, and declared network policy. The routing layer loads a skill body only when its trigger matches the current task or an explicit `/skill-name` invocation; it does not execute upstream shell snippets or grant their instructions extra permissions. A digest mismatch fails closed before activation.

Validation for this import includes manifest parsing, trigger compilation, catalog dependency checks, source-file secret-pattern scanning, and the repository's skill/test checks. Network references and setup snippets in upstream documentation remain untrusted reference material and are subject to ZeuZ's tool and secret boundaries.

This import is a ZeuZ integration and does not imply endorsement by Matt Pocock or AIHero.
