#!/usr/bin/env python3
"""Validate Argos experiment-charter and candidate-registry JSON artifacts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


PLACEHOLDER = re.compile(r"<[^>]+>")
APPROVAL_VALUES = {"approved", "not_required"}
KNOWN_STATUSES = {"proposed", "running", "failed", "eliminated", "advanced", "selected"}


@dataclass(frozen=True)
class Finding:
    path: str
    message: str


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path}: root must be a JSON object")
    return value


def get(value: dict[str, Any], path: str, findings: list[Finding]) -> Any:
    current: Any = value
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            findings.append(Finding(path, "required field is missing"))
            return None
        current = current[part]
    return current


def find_placeholders(value: Any, path: str = "$") -> list[Finding]:
    findings: list[Finding] = []
    if isinstance(value, dict):
        for key, nested in value.items():
            findings.extend(find_placeholders(nested, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            findings.extend(find_placeholders(nested, f"{path}[{index}]"))
    elif isinstance(value, str) and (not value.strip() or PLACEHOLDER.search(value)):
        findings.append(Finding(path, "blank or unresolved <placeholder> value"))
    return findings


def parse_timestamp(value: Any, path: str, findings: list[Finding]) -> datetime | None:
    if not isinstance(value, str):
        findings.append(Finding(path, "must be an ISO-8601 timestamp with timezone"))
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("timezone required")
        return parsed
    except ValueError as error:
        findings.append(Finding(path, f"invalid timestamp ({error})"))
        return None


def positive_number(value: Any, path: str, findings: list[Finding], *, allow_zero: bool = False) -> None:
    valid = isinstance(value, (int, float)) and not isinstance(value, bool)
    if not valid or (value < 0 if allow_zero else value <= 0):
        qualifier = "non-negative" if allow_zero else "positive"
        findings.append(Finding(path, f"must be a {qualifier} number"))


def validate_charter(charter: dict[str, Any]) -> list[Finding]:
    findings = find_placeholders(charter)
    required = [
        "schema_version",
        "experiment_id",
        "charter_version",
        "frozen_at",
        "decision.owner",
        "decision.action",
        "decision.prediction_unit",
        "decision.target",
        "decision.forecast_origin_definition",
        "decision.horizon",
        "decision.lead_time",
        "decision.label_maturity_delay",
        "decision.current_process",
        "data.snapshot_id",
        "data.available_time_column_or_rule",
        "data.label_time_column_or_rule",
        "data.privacy_classification",
        "evaluation.split_strategy",
        "evaluation.training_start",
        "evaluation.validation_start",
        "evaluation.final_test_start",
        "evaluation.final_test_end",
        "evaluation.fold_count",
        "evaluation.gap",
        "evaluation.primary_metric.name",
        "evaluation.primary_metric.direction",
        "evaluation.primary_metric.minimum_useful_relative_improvement",
        "evaluation.comparison_rule",
        "budget.maximum_candidate_count",
        "budget.maximum_trials_per_candidate",
        "budget.maximum_wall_clock_hours",
        "budget.maximum_external_service_cost",
        "reproducibility.repository_commit",
        "reproducibility.data_snapshot",
        "reproducibility.environment_lock",
        "reproducibility.seed_policy",
    ]
    values = {path: get(charter, path, findings) for path in required}

    frozen = get(charter, "frozen_at", findings)
    if frozen is None:
        findings.append(Finding("frozen_at", "charter must be frozen before experiment execution"))
    else:
        parse_timestamp(frozen, "frozen_at", findings)

    timeline_paths = [
        "evaluation.training_start",
        "evaluation.validation_start",
        "evaluation.final_test_start",
        "evaluation.final_test_end",
    ]
    timeline = [parse_timestamp(values.get(path), path, findings) for path in timeline_paths]
    if all(timeline):
        assert all(item is not None for item in timeline)
        if not timeline[0] < timeline[1] < timeline[2] < timeline[3]:
            findings.append(
                Finding(
                    "evaluation",
                    "timeline must satisfy training_start < validation_start < final_test_start < final_test_end",
                )
            )

    direction = values.get("evaluation.primary_metric.direction")
    if direction not in {"minimize", "maximize"}:
        findings.append(Finding("evaluation.primary_metric.direction", "must be minimize or maximize"))

    positive_number(values.get("evaluation.fold_count"), "evaluation.fold_count", findings)
    positive_number(
        values.get("evaluation.primary_metric.minimum_useful_relative_improvement"),
        "evaluation.primary_metric.minimum_useful_relative_improvement",
        findings,
        allow_zero=True,
    )
    positive_number(values.get("budget.maximum_candidate_count"), "budget.maximum_candidate_count", findings)
    positive_number(values.get("budget.maximum_trials_per_candidate"), "budget.maximum_trials_per_candidate", findings)
    positive_number(values.get("budget.maximum_wall_clock_hours"), "budget.maximum_wall_clock_hours", findings)
    positive_number(
        values.get("budget.maximum_external_service_cost"),
        "budget.maximum_external_service_cost",
        findings,
        allow_zero=True,
    )

    guardrails = get(charter, "evaluation.guardrails", findings)
    if not isinstance(guardrails, list) or not guardrails:
        findings.append(Finding("evaluation.guardrails", "must contain at least one predeclared guardrail"))
    stop_conditions = get(charter, "stop_conditions", findings)
    if not isinstance(stop_conditions, list) or not stop_conditions:
        findings.append(Finding("stop_conditions", "must contain at least one stop condition"))

    approvals = get(charter, "approvals", findings)
    if isinstance(approvals, dict):
        for name in ("data_use", "external_transfer", "compute_and_cost"):
            if approvals.get(name) not in APPROVAL_VALUES:
                findings.append(Finding(f"approvals.{name}", "must be approved or not_required"))
    return findings


def validate_registry(registry: dict[str, Any], charter: dict[str, Any]) -> list[Finding]:
    findings = find_placeholders(registry)
    if registry.get("experiment_id") != charter.get("experiment_id"):
        findings.append(Finding("experiment_id", "must match the experiment charter"))

    candidates = registry.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        findings.append(Finding("candidates", "must contain at least one candidate"))
        return findings

    maximum = ((charter.get("budget") or {}).get("maximum_candidate_count"))
    if isinstance(maximum, int) and len(candidates) > maximum:
        findings.append(Finding("candidates", f"count {len(candidates)} exceeds charter limit {maximum}"))

    ids: set[str] = set()
    baseline_count = 0
    external_allowed = bool((charter.get("data") or {}).get("external_transfer_allowed"))
    external_approval = (charter.get("approvals") or {}).get("external_transfer")
    max_trials = (charter.get("budget") or {}).get("maximum_trials_per_candidate")

    required_fields = [
        "id",
        "tier",
        "family",
        "implementation",
        "version_or_revision",
        "hypothesis",
        "information_set",
        "preprocessing",
        "outputs",
        "search_budget",
        "expected_constraints",
        "known_failure_modes",
        "advance_rule",
        "status",
    ]

    for index, candidate in enumerate(candidates):
        path = f"candidates[{index}]"
        if not isinstance(candidate, dict):
            findings.append(Finding(path, "candidate must be an object"))
            continue
        for field in required_fields:
            if field not in candidate:
                findings.append(Finding(f"{path}.{field}", "required field is missing"))

        candidate_id = candidate.get("id")
        if not isinstance(candidate_id, str) or not candidate_id.strip():
            findings.append(Finding(f"{path}.id", "must be a nonblank string"))
        elif candidate_id in ids:
            findings.append(Finding(f"{path}.id", "candidate ID must be unique"))
        else:
            ids.add(candidate_id)

        family = str(candidate.get("family", "")).lower()
        if family == "baseline":
            baseline_count += 1
        status = candidate.get("status")
        if status not in KNOWN_STATUSES:
            findings.append(Finding(f"{path}.status", f"must be one of {sorted(KNOWN_STATUSES)}"))

        budget = candidate.get("search_budget")
        if isinstance(budget, dict):
            trial_count = budget.get("max_trials")
            positive_number(trial_count, f"{path}.search_budget.max_trials", findings)
            positive_number(
                budget.get("max_wall_clock_minutes"),
                f"{path}.search_budget.max_wall_clock_minutes",
                findings,
            )
            if isinstance(trial_count, int) and isinstance(max_trials, int) and trial_count > max_trials:
                findings.append(
                    Finding(
                        f"{path}.search_budget.max_trials",
                        f"exceeds charter per-candidate limit {max_trials}",
                    )
                )
        else:
            findings.append(Finding(f"{path}.search_budget", "must be an object"))

        constraints = candidate.get("expected_constraints")
        if not isinstance(constraints, dict):
            findings.append(Finding(f"{path}.expected_constraints", "must be an object"))
        elif "timegpt" in family:
            transfers = constraints.get("external_data_transfer")
            if transfers is not True:
                findings.append(
                    Finding(
                        f"{path}.expected_constraints.external_data_transfer",
                        "hosted TimeGPT candidate must declare external data transfer",
                    )
                )
            if not external_allowed or external_approval != "approved":
                findings.append(
                    Finding(
                        path,
                        "TimeGPT requires charter external_transfer_allowed=true and approved transfer",
                    )
                )

        failure_modes = candidate.get("known_failure_modes")
        if not isinstance(failure_modes, list) or not failure_modes:
            findings.append(Finding(f"{path}.known_failure_modes", "must contain at least one failure mode"))

    if baseline_count == 0:
        findings.append(Finding("candidates", "must include at least one family=baseline candidate"))
    return findings


def validate(charter: dict[str, Any], registry: dict[str, Any]) -> list[Finding]:
    return validate_charter(charter) + validate_registry(registry, charter)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a frozen Argos charter and candidate registry.")
    parser.add_argument("--charter", required=True, type=Path)
    parser.add_argument("--registry", required=True, type=Path)
    parser.add_argument("--json", action="store_true", help="emit a machine-readable result")
    args = parser.parse_args()

    try:
        charter = load_json(args.charter)
        registry = load_json(args.registry)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"verdict": "ERROR", "error": str(error)}) if args.json else f"ERROR: {error}")
        return 2

    findings = validate(charter, registry)
    if args.json:
        print(
            json.dumps(
                {
                    "verdict": "FAIL" if findings else "PASS",
                    "finding_count": len(findings),
                    "findings": [finding.__dict__ for finding in findings],
                    "limitation": "Structural validation only; it does not prove scientific validity or absence of leakage.",
                },
                indent=2,
            )
        )
    elif findings:
        for finding in findings:
            print(f"[{finding.path}] {finding.message}", file=sys.stderr)
        print(f"FAIL: {len(findings)} finding(s).", file=sys.stderr)
    else:
        print("PASS: charter and registry satisfy Argos structural gates; scientific review is still required.")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
