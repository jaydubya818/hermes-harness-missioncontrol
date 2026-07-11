#!/usr/bin/env python3
from __future__ import annotations

import json
import py_compile
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
SCHEMA_PATH = ROOT / "schema" / "openapi.yaml"
EXAMPLES_DIR = ROOT / "examples"
PY_MODELS_PATH = ROOT / "generated" / "python_models.py"

FACTORY_SCHEMAS = [
    "WorkOrder",
    "ArtifactManifest",
    "VerificationReceipt",
    "OutcomeMetrics",
    "LearningCandidate",
]

EXAMPLE_SCHEMAS = {
    "factory-v0.1-work-order.json": "WorkOrder",
    "factory-v0.1-artifact-manifest.json": "ArtifactManifest",
    "factory-v0.1-verification-receipt.json": "VerificationReceipt",
    "factory-v0.1-outcome-metrics.json": "OutcomeMetrics",
    "factory-v0.1-learning-candidate.json": "LearningCandidate",
}


class ValidationError(Exception):
    pass


def load_schema() -> dict[str, Any]:
    with SCHEMA_PATH.open() as f:
        spec = yaml.safe_load(f)
    schemas = spec.get("components", {}).get("schemas", {})
    missing = [name for name in FACTORY_SCHEMAS if name not in schemas]
    if missing:
        raise ValidationError(f"missing schemas: {', '.join(missing)}")
    return spec


def resolve_ref(schemas: dict[str, Any], ref: str) -> dict[str, Any]:
    prefix = "#/components/schemas/"
    if not ref.startswith(prefix):
        raise ValidationError(f"unsupported ref: {ref}")
    name = ref.removeprefix(prefix)
    if name not in schemas:
        raise ValidationError(f"missing ref target: {ref}")
    return schemas[name]


def validate_refs(schemas: dict[str, Any], node: Any, path: str = "schema") -> None:
    if isinstance(node, dict):
        if "$ref" in node:
            resolve_ref(schemas, node["$ref"])
        for key, value in node.items():
            validate_refs(schemas, value, f"{path}.{key}")
    elif isinstance(node, list):
        for idx, value in enumerate(node):
            validate_refs(schemas, value, f"{path}[{idx}]")


def schema_type(schema: dict[str, Any]) -> str | None:
    if "$ref" in schema:
        return "object"
    if "enum" in schema and "type" not in schema:
        return "string"
    return schema.get("type")


def validate_value(value: Any, schema: dict[str, Any], schemas: dict[str, Any], path: str) -> None:
    if "$ref" in schema:
        validate_value(value, resolve_ref(schemas, schema["$ref"]), schemas, path)
        return

    if "enum" in schema and value not in schema["enum"]:
        raise ValidationError(f"{path}: {value!r} not in enum {schema['enum']!r}")

    kind = schema_type(schema)
    if kind == "object":
        if not isinstance(value, dict):
            raise ValidationError(f"{path}: expected object")
        required = set(schema.get("required", []))
        missing = sorted(required - value.keys())
        if missing:
            raise ValidationError(f"{path}: missing required fields {missing}")
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extra = sorted(set(value) - set(props))
            if extra:
                raise ValidationError(f"{path}: unexpected fields {extra}")
        for key, item in value.items():
            if key in props:
                validate_value(item, props[key], schemas, f"{path}.{key}")
        return

    if kind == "array":
        if not isinstance(value, list):
            raise ValidationError(f"{path}: expected array")
        item_schema = schema.get("items", {"type": "string"})
        for idx, item in enumerate(value):
            validate_value(item, item_schema, schemas, f"{path}[{idx}]")
        return

    expected = {
        "string": str,
        "integer": int,
        "number": (int, float),
        "boolean": bool,
    }.get(kind)
    if expected is not None and not isinstance(value, expected):
        raise ValidationError(f"{path}: expected {kind}, got {type(value).__name__}")


def load_examples() -> dict[str, dict[str, Any]]:
    examples: dict[str, dict[str, Any]] = {}
    for filename in EXAMPLE_SCHEMAS:
        path = EXAMPLES_DIR / filename
        if not path.exists():
            raise ValidationError(f"missing example: {path}")
        with path.open() as f:
            examples[filename] = json.load(f)
    return examples


def validate_example_coherence(examples: dict[str, dict[str, Any]]) -> None:
    work_order = examples["factory-v0.1-work-order.json"]
    manifest = examples["factory-v0.1-artifact-manifest.json"]
    receipt = examples["factory-v0.1-verification-receipt.json"]
    metrics = examples["factory-v0.1-outcome-metrics.json"]
    learning = examples["factory-v0.1-learning-candidate.json"]

    work_order_id = work_order["work_order_id"]
    run_id = receipt["run_id"]
    mission_id = receipt["mission_id"]
    for name, obj in {
        "manifest": manifest,
        "receipt": receipt,
        "metrics": metrics,
        "learning": learning,
    }.items():
        if obj.get("work_order_id") != work_order_id:
            raise ValidationError(f"{name}: work_order_id does not match work order")
        if obj.get("run_id") != run_id:
            raise ValidationError(f"{name}: run_id does not match verification receipt")
        if obj.get("mission_id") != mission_id:
            raise ValidationError(f"{name}: mission_id does not match verification receipt")

    ac_ids = [criterion["id"] for criterion in work_order["acceptance_criteria"]]
    if len(ac_ids) != len(set(ac_ids)):
        raise ValidationError("work order acceptance criteria ids are not unique")
    receipt_ac_ids = [result["acceptance_criterion_id"] for result in receipt["acceptance_results"]]
    unknown_ac_ids = sorted(set(receipt_ac_ids) - set(ac_ids))
    if unknown_ac_ids:
        raise ValidationError(f"receipt references unknown acceptance criteria: {unknown_ac_ids}")

    artifact_uris = {artifact["uri"] for artifact in manifest["artifacts"]}
    if not artifact_uris:
        raise ValidationError("artifact manifest has no artifacts")
    receipt_evidence = set(receipt["evidence_refs"])
    if not artifact_uris & receipt_evidence:
        raise ValidationError("verification receipt does not reference any manifest artifact URI")

    for source in work_order["source_of_truths"]:
        if not isinstance(source["writeback_required"], bool) or not isinstance(source["verification_required"], bool):
            raise ValidationError("source_of_truths require explicit boolean writeback/verification flags")

    for key, value in metrics.items():
        if key.endswith("_ms") and not isinstance(value, int):
            raise ValidationError(f"outcome metric {key} must be integer milliseconds")
    if metrics.get("acceptance_criteria_total") != len(ac_ids):
        raise ValidationError("outcome metrics acceptance_criteria_total does not match work order")

    if learning.get("status") != "proposed":
        raise ValidationError("learning candidate must remain proposed in v0.1")
    if not learning.get("evidence_refs"):
        raise ValidationError("learning candidate must include evidence refs")


def main() -> int:
    spec = load_schema()
    schemas = spec["components"]["schemas"]
    validate_refs(schemas, schemas)

    examples = load_examples()
    for filename, schema_name in EXAMPLE_SCHEMAS.items():
        validate_value(examples[filename], schemas[schema_name], schemas, filename)
    validate_example_coherence(examples)

    py_compile.compile(str(PY_MODELS_PATH), doraise=True)

    print("Factory v0.1 contract examples validated")
    print(f"- OpenAPI schema parsed: {SCHEMA_PATH.relative_to(REPO_ROOT)}")
    print(f"- Examples validated: {len(EXAMPLE_SCHEMAS)}")
    print(f"- Python generated model syntax OK: {PY_MODELS_PATH.relative_to(REPO_ROOT)}")
    print("- Runtime pydantic validation not performed by this script; repository does not declare a Python env dependency here.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValidationError as exc:
        print(f"validation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
