#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import textwrap
import yaml

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schema" / "openapi.yaml"
OUT_PATH = ROOT / "generated" / "python_models.py"

ENUM_NAMES = [
    "MissionState",
    "RunState",
    "StepKind",
    "StepState",
    "ApprovalMode",
    "FinalOutcome",
    "EventSource",
]

MODEL_ORDER = [
    "Mission",
    "Run",
    "Step",
    "ArtifactRef",
    "ApprovalRequest",
    "ApprovalResult",
    "RepoScope",
    "ResourceBudget",
    "ExecutionEnvelope",
    "StepExecutionRequest",
    "TaskExecutionResult",
    "EventEnvelope",
    "ContractError",
]

PY_TYPES = {
    "string": "str",
    "integer": "int",
    "number": "float",
    "boolean": "bool",
}


def optionalize(t: str, required: bool) -> str:
    return t if required else f"{t} | None"


def resolve_type(schema: dict) -> str:
    if "$ref" in schema:
        return schema["$ref"].split("/")[-1]
    t = schema.get("type")
    if t == "array":
        item_type = resolve_type(schema.get("items", {"type": "string"}))
        return f"list[{item_type}]"
    if t == "object":
        return "dict[str, Any]"
    if t in PY_TYPES:
        return PY_TYPES[t]
    return "Any"


def main() -> None:
    spec = yaml.safe_load(SCHEMA_PATH.read_text())
    schemas = spec["components"]["schemas"]

    lines: list[str] = [
        "from __future__ import annotations",
        "",
        "from enum import Enum",
        "from typing import Any",
        "",
        "from pydantic import BaseModel, ConfigDict",
        "",
    ]

    for enum_name in ENUM_NAMES:
        enum_values = schemas[enum_name]["enum"]
        lines.append(f"class {enum_name}(str, Enum):")
        for value in enum_values:
            member = value.upper().replace(".", "_").replace("-", "_")
            lines.append(f"    {member} = {value!r}")
        lines.append("")

    for model_name in MODEL_ORDER:
        schema = schemas[model_name]
        lines.append(f"class {model_name}(BaseModel):")
        lines.append("    model_config = ConfigDict(extra='forbid')")
        required = set(schema.get("required", []))
        props = schema.get("properties", {})
        if not props:
            lines.append("    pass")
            lines.append("")
            continue
        for prop_name, prop_schema in props.items():
            py_type = resolve_type(prop_schema)
            py_type = optionalize(py_type, prop_name in required)
            default = "" if prop_name in required else " = None"
            lines.append(f"    {prop_name}: {py_type}{default}")
        lines.append("")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
