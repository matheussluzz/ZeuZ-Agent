# Review contract

## Evidence packet

Generate `review-packet.json` with:

```bash
node scripts/evidence-packet.mjs \
  --workspace /absolute/workspace \
  --request request.md \
  --criteria criteria.json \
  --delivery delivery.md \
  --verification verification.txt \
  --artifact path/to/artifact \
  --producer-family openai \
  --out .agents/reviews/review-packet.json
```

`criteria.json` must be an array of unique objects:

```json
[{"id":"REQ-001","text":"The CLI starts from one executable.","required":true,"source":"user"}]
```

Classify derived criteria as `source: "derived"` and state the governing contract or invariant in `text`. Sanitize the four input files before packet generation: the script refuses credential-file names and common high-entropy key shapes. The packet contains user-provided text, is written with mode `0600`, and must remain private under the Git-ignored `.agents/` state directory.

Required packet state:

- request, delivery, criteria, and verification inputs captured with content hashes;
- producer family named;
- inspectable artifact paths;
- Git HEAD/status/diff plus non-secret untracked-file hashes folded into one workspace fingerprint; denied secret paths contribute metadata only, and a tracked secret path blocks packet generation;
- missing inputs listed explicitly under `blockers`.

Initialize an honest, private `REVIEW_BLOCKED` report before assigning the reviewer:

```bash
node scripts/init-review-report.mjs .agents/reviews/review-packet.json
```

The initializer pre-populates all criteria as `UNVERIFIED`, records that checks/replay have not run, uses mode `0600`, and refuses to overwrite an existing report. The independent reviewer replaces those placeholders with evidence.

## Review report schema

Use this top-level shape:

```json
{
  "schemaVersion": "1.0",
  "packetFingerprint": "sha256 from packet",
  "reviewer": {"provider":"cursor","model":"fable","family":"anthropic"},
  "deterministicChecks": [
    {"id":"CHK-001","command":"pnpm check","status":"PASS","required":true,"evidence":"exit 0"}
  ],
  "criteria": [
    {"id":"REQ-001","status":"MET","evidence":["bin mapping and smoke output"],"findingIds":[]}
  ],
  "verificationGaps": [
    {"id":"GAP-001","changedBehavior":"startup","assertion":"smoke asserts banner","status":"COVERED","evidence":"test id"}
  ],
  "findings": [],
  "blockers": [],
  "verdict": "PASS",
  "summary": "Concise evidence-led conclusion."
}
```

Write the report directly under `.agents/reviews/` and set file mode `0600` (`chmod 600 .agents/reviews/review-report.json` on Unix). The validator rejects symlinked, public/group-readable, or out-of-directory packet/report files.

Allowed values:

- check status: `PASS`, `FAIL`, `BLOCKED`, `NOT_APPLICABLE`;
- criterion status: `MET`, `NOT_MET`, `UNVERIFIED`;
- gap status: `COVERED`, `GAP`, `NOT_APPLICABLE`;
- severity: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`;
- verdict: `PASS`, `CHANGES_REQUIRED`, `REVIEW_BLOCKED`.

Every finding requires `id`, `severity`, `title`, `location`, `evidence`, `reproduction`, `expectedCorrection`, and one or more `criterionIds`. Evidence must be sufficient for the producer to reproduce the issue without guessing. Use `blockers` for absent access/evidence, never as a hiding place for a suspected actionable defect.

## Requirement traceability

For each required criterion, answer four separate questions:

1. Where is it implemented or expressed?
2. What observable evidence demonstrates it?
3. What assertion would fail if it regressed?
4. Is any part still inaccessible or inferred?

Do not mark a criterion `MET` merely because implementation text resembles the request. Do not mark it `NOT_MET` without reproducible evidence. Use `UNVERIFIED` when the artifact may comply but the available evidence cannot establish it.

## Freshness and remediation

The report must reference the exact packet fingerprint. Save packet and report only under the workspace-local `.agents/reviews/` private-state directory; keep `.agents/` ignored by Git. The fingerprint deliberately excludes this reserved review-metadata path but includes the rest of the tracked, staged, and untracked workspace. A change outside the reserved path makes the report stale. Remediation therefore requires a new packet, not an edited old verdict.
