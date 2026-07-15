#!/usr/bin/env python3
"""Deterministic unit tests for the dependency-free Argos validators."""

from __future__ import annotations

import copy
import csv
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType


SCRIPT_DIR = Path(__file__).resolve().parent
ASSET_DIR = SCRIPT_DIR.parent / "assets"


def load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


experiment = load_module("validate_experiment", SCRIPT_DIR / "validate_experiment.py")
leakage = load_module("leakage_audit", SCRIPT_DIR / "leakage_audit.py")


def valid_artifacts() -> tuple[dict, dict]:
    charter = json.loads((ASSET_DIR / "experiment-charter.template.json").read_text())
    registry = json.loads((ASSET_DIR / "candidate-registry.template.json").read_text())

    replacements = {
        "<required-stable-id>": "demand-forecast-001",
        "<required-owner>": "planning",
        "<required-action-changed-by-the-output>": "set next-week capacity",
        "<required-row-grain>": "site and forecast origin",
        "<required-target-and-unit>": "next-week demand in units",
        "<required-real-decision-timestamp>": "Monday 08:00 America/Sao_Paulo",
        "<required-duration-or-classification-window>": "7 days",
        "<required-production-lead-time>": "24 hours",
        "<required-delay-until-label-is-reliable>": "14 days",
        "<required>": "documented",
        "<required-operational-rule-or-none>": "seasonal naive",
        "<required-version-or-content-hash>": "sha256:data",
        "<required-key>": "site_id",
        "<required-or-not-applicable>": "event_time",
        "<required-production-realistic-gap>": "24 hours",
        "<required-guardrail>": "bias",
        "<required-pass-rule>": "absolute bias <= 5%",
        "<required-paired-comparison-and-uncertainty-rule>": "paired deltas by origin",
        "<required-path-or-image-digest>": "uv.lock",
    }

    def resolve(value):
        if isinstance(value, dict):
            return {key: resolve(nested) for key, nested in value.items()}
        if isinstance(value, list):
            return [resolve(nested) for nested in value]
        if isinstance(value, str):
            for old, new in replacements.items():
                value = value.replace(old, new)
            return value
        return value

    charter = resolve(charter)
    charter["frozen_at"] = "2026-01-01T00:00:00Z"
    charter["approvals"] = {
        "data_use": "approved",
        "external_transfer": "not_required",
        "compute_and_cost": "approved",
    }
    registry = resolve(registry)
    registry["experiment_id"] = charter["experiment_id"]
    registry["candidates"] = registry["candidates"][:1]
    return charter, registry


class ExperimentValidatorTests(unittest.TestCase):
    def test_valid_artifacts_pass(self):
        charter, registry = valid_artifacts()
        self.assertEqual(experiment.validate(charter, registry), [])

    def test_final_test_must_follow_validation(self):
        charter, registry = valid_artifacts()
        charter["evaluation"]["final_test_start"] = "2024-06-01T00:00:00Z"
        messages = [finding.message for finding in experiment.validate(charter, registry)]
        self.assertTrue(any("timeline must satisfy" in message for message in messages))

    def test_timegpt_requires_transfer_approval(self):
        charter, registry = valid_artifacts()
        candidate = copy.deepcopy(registry["candidates"][0])
        candidate["id"] = "timegpt"
        candidate["family"] = "timegpt-2"
        candidate["expected_constraints"]["external_data_transfer"] = True
        registry["candidates"].append(candidate)
        messages = [finding.message for finding in experiment.validate(charter, registry)]
        self.assertTrue(any("approved transfer" in message for message in messages))


class LeakageAuditTests(unittest.TestCase):
    def write_inventory(self, rows: list[dict[str, str]]) -> Path:
        handle = tempfile.NamedTemporaryFile(mode="w", newline="", suffix=".csv", delete=False)
        with handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=["entity_id", "feature", "forecast_origin", "available_at", "event_time", "known_future"],
            )
            writer.writeheader()
            writer.writerows(rows)
        return Path(handle.name)

    def test_point_in_time_inventory_passes(self):
        path = self.write_inventory(
            [
                {
                    "entity_id": "A",
                    "feature": "lag_7",
                    "forecast_origin": "2026-01-08T00:00:00Z",
                    "available_at": "2026-01-07T12:00:00Z",
                    "event_time": "2026-01-01T00:00:00Z",
                    "known_future": "false",
                }
            ]
        )
        self.addCleanup(path.unlink)
        count, findings = leakage.audit_file(path)
        self.assertEqual(count, 1)
        self.assertEqual(findings, [])

    def test_future_availability_fails(self):
        path = self.write_inventory(
            [
                {
                    "entity_id": "A",
                    "feature": "actual_future_price",
                    "forecast_origin": "2026-01-08T00:00:00Z",
                    "available_at": "2026-01-09T00:00:00Z",
                    "event_time": "2026-01-09T00:00:00Z",
                    "known_future": "false",
                }
            ]
        )
        self.addCleanup(path.unlink)
        _, findings = leakage.audit_file(path)
        codes = {finding.code for finding in findings}
        self.assertIn("AVAILABLE_AFTER_ORIGIN", codes)
        self.assertIn("FUTURE_EVENT_NOT_DECLARED", codes)

    def test_naive_timestamp_fails_closed(self):
        path = self.write_inventory(
            [
                {
                    "entity_id": "A",
                    "feature": "x",
                    "forecast_origin": "2026-01-08 00:00:00",
                    "available_at": "2026-01-07T00:00:00Z",
                    "event_time": "",
                    "known_future": "",
                }
            ]
        )
        self.addCleanup(path.unlink)
        _, findings = leakage.audit_file(path)
        self.assertIn("INVALID_TIMESTAMP", {finding.code for finding in findings})


if __name__ == "__main__":
    unittest.main(verbosity=2)
