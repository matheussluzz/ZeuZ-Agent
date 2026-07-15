#!/usr/bin/env python3
"""Conservative point-in-time audit for a feature-observation inventory.

This structural check cannot prove that a transformation, source system, or
availability rule is leakage-free. It fails closed on missing/ambiguous clocks
and should be paired with a review of the real data-generating process.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path


REQUIRED_COLUMNS = {"feature", "forecast_origin", "available_at"}
TRUE_VALUES = {"1", "true", "yes", "y"}
FALSE_VALUES = {"", "0", "false", "no", "n"}


@dataclass(frozen=True)
class Finding:
    row: int
    code: str
    message: str


def parse_time(value: str, *, field: str) -> datetime:
    if not value or not value.strip():
        raise ValueError(f"{field} is blank")
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field} must include a UTC offset or Z")
    return parsed


def parse_bool(value: str, *, field: str) -> bool:
    normalized = (value or "").strip().lower()
    if normalized in TRUE_VALUES:
        return True
    if normalized in FALSE_VALUES:
        return False
    raise ValueError(f"{field} must be true/false when provided")


def audit_rows(reader: csv.DictReader[str]) -> tuple[int, list[Finding]]:
    fields = set(reader.fieldnames or [])
    missing = REQUIRED_COLUMNS - fields
    if missing:
        raise ValueError(f"missing columns: {', '.join(sorted(missing))}")

    findings: list[Finding] = []
    seen: set[tuple[str, str, str]] = set()
    count = 0

    for row_number, row in enumerate(reader, start=2):
        count += 1
        feature = (row.get("feature") or "").strip()
        entity = (row.get("entity_id") or "").strip()
        origin_raw = row.get("forecast_origin") or ""

        if not feature:
            findings.append(Finding(row_number, "BLANK_FEATURE", "feature is blank"))

        try:
            origin = parse_time(origin_raw, field="forecast_origin")
            available = parse_time(row.get("available_at") or "", field="available_at")
        except (TypeError, ValueError) as error:
            findings.append(Finding(row_number, "INVALID_TIMESTAMP", str(error)))
            continue

        if available > origin:
            findings.append(
                Finding(
                    row_number,
                    "AVAILABLE_AFTER_ORIGIN",
                    f"{feature or '<blank>'} became available after forecast origin",
                )
            )

        event_raw = (row.get("event_time") or "").strip()
        if event_raw:
            try:
                event = parse_time(event_raw, field="event_time")
                known_future = parse_bool(row.get("known_future") or "", field="known_future")
                if event > origin and not known_future:
                    findings.append(
                        Finding(
                            row_number,
                            "FUTURE_EVENT_NOT_DECLARED",
                            f"{feature or '<blank>'} has an event after origin but is not declared known-future",
                        )
                    )
            except (TypeError, ValueError) as error:
                findings.append(Finding(row_number, "INVALID_EVENT_METADATA", str(error)))

        key = (entity, feature, origin.isoformat())
        if key in seen:
            findings.append(
                Finding(
                    row_number,
                    "DUPLICATE_OBSERVATION",
                    f"duplicate entity/feature/origin tuple {key!r}",
                )
            )
        seen.add(key)

    if count == 0:
        findings.append(Finding(1, "EMPTY_INVENTORY", "inventory contains no feature observations"))
    return count, findings


def audit_file(path: Path) -> tuple[int, list[Finding]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return audit_rows(csv.DictReader(handle))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fail on missing, ambiguous, future, or duplicate feature-availability evidence."
    )
    parser.add_argument("inventory", help="CSV with feature, forecast_origin, available_at columns")
    parser.add_argument("--json", action="store_true", help="emit a machine-readable result")
    args = parser.parse_args()

    try:
        row_count, findings = audit_file(Path(args.inventory))
    except (OSError, ValueError) as error:
        if args.json:
            print(json.dumps({"verdict": "ERROR", "error": str(error)}, indent=2))
        else:
            print(f"ERROR: {error}", file=sys.stderr)
        return 2

    verdict = "FAIL" if findings else "PASS"
    if args.json:
        print(
            json.dumps(
                {
                    "verdict": verdict,
                    "rows": row_count,
                    "finding_count": len(findings),
                    "findings": [asdict(finding) for finding in findings],
                    "limitation": "Structural audit only; inspect source semantics and transformations separately.",
                },
                indent=2,
            )
        )
    elif findings:
        for finding in findings:
            print(f"row {finding.row} [{finding.code}]: {finding.message}", file=sys.stderr)
        print(f"FAIL: {len(findings)} finding(s) across {row_count} row(s).", file=sys.stderr)
    else:
        print(
            f"PASS: {row_count} feature observation(s) were available at or before their origins; "
            "semantic review is still required."
        )
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
