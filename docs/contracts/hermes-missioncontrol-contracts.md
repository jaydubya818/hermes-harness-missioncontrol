# Hermes ↔ MissionControl Contracts

Status: draft spec derived from approved target architecture

## Purpose

Define the stable, schema-first boundary between:
- Hermes: intelligent execution runtime
- MissionControl: supervisory control plane and system-of-record

MissionControl governs execution state.
Hermes performs intelligent work inside a governed envelope.
Contracts, not imports, connect them.

## Contract Principles

- schema-first: OpenAPI + JSON Schema
- async by default for step execution
- streaming events are first-class
- MissionControl owns authoritative run/step lifecycle state
- Hermes owns reasoning, context assembly, memory behavior, and tool-driven execution
- no cross-repo internal imports
- no shared business logic in the contracts package

## Ownership Boundary

### Hermes owns
- execution context bundle assembly
- planning and reasoning inside a step
- tool invocation inside allowed envelope
- structured step outputs
- Hermes-side memory writeback behavior

### MissionControl owns
- mission, run, and step state
- approvals
- artifact persistence
- audit trail
- eval linkage
- cancellation, retry, and cleanup decisions

## Shared Package

Recommended package:
- `packages/contracts`

Contains only:
- request/response schemas
- event envelopes
- enums and status models
- error models
- artifact metadata models

Suggested generated outputs:
- TypeScript models for MissionControl
- Python models for Hermes

## Common Types

## IDs
- `MissionId`
- `RunId`
- `StepId`
- `ApprovalId`
- `ArtifactId`
- `ContextBundleId`
- `StepExecutionId`

Format recommendation:
- `mis_<opaque>`
- `run_<opaque>`
- `step_<opaque>`
- `approval_<opaque>`
- `art_<opaque>`
- `ctx_<opaque>`
- `exec_<opaque>`

## Enums

### StepKind
- `plan`
- `implement`
- `test`
- `review`
- `deploy`

### StepState
MissionControl-owned authoritative lifecycle state:
- `pending`
- `ready`
- `running`
- `awaiting_approval`
- `paused`
- `failed`
- `completed`
- `cancelled`

### ApprovalMode
- `never`
- `on_policy_trigger`
- `always`

### ToolPermission
- `allow`
- `deny`
- `allow_with_approval`

### FinalOutcome
Hermes-reported execution outcome:
- `success`
- `partial`
- `blocked`
- `failed`
- `cancelled`

## Execution Envelope

MissionControl passes Hermes an execution envelope on step start:
- `mission_id`
- `run_id`
- `step_id`
- `step_kind`
- `repo_path`
- `worktree_path`
- `objective`
- `constraints[]`
- `operator_notes[]`
- `allowed_tools[]`
- `allowed_actions[]`
- `approval_mode`
- `timeout_seconds`
- `token_budget`
- `resource_budget`
- `output_dir`
- `environment_classification`
- `relevant_files[]`

Hermes must operate only inside this envelope.

## Core Contracts

### 1. Load Context

Direction:
- MissionControl → Hermes

Purpose:
- request an execution context bundle for a governed step

Operation:
- `POST /contracts/v1/context/load`

Request shape:
```json
{
  "mission_id": "mis_123",
  "run_id": "run_123",
  "step_id": "step_123",
  "step_kind": "implement",
  "repo_path": "/repo",
  "worktree_path": "/repo/.worktrees/run_123",
  "objective": "Implement governed async step execution",
  "constraints": ["Do not modify deploy flow"],
  "operator_notes": ["Prefer minimal surface changes first"],
  "relevant_files": ["apps/orchestrator-api/src/index.ts"],
  "approval_mode": "on_policy_trigger",
  "timeout_seconds": 1800
}
```

Response shape:
```json
{
  "context_bundle_id": "ctx_123",
  "summary": "Execution context bundle for async step execution",
  "agent_profile": {
    "profile_name": "hermes",
    "persona_ref": "profile://hermes/default"
  },
  "documents": [
    {
      "type": "architecture",
      "path": "docs/architecture/2026-04-18-hermes-missioncontrol-approved-target-architecture.md",
      "title": "Approved Target Architecture"
    }
  ],
  "risks": ["Lifecycle authority must remain in MissionControl"],
  "gotchas": ["Do not let Hermes commit authoritative step state"],
  "suggested_next_actions": ["implement start_step", "implement event stream"]
}
```

Notes:
- Hermes decides context contents
- MissionControl consumes the bundle, but does not assemble it itself

### 2. Start Step

Direction:
- MissionControl → Hermes

Purpose:
- start async governed execution for a step

Operation:
- `POST /contracts/v1/steps/start`

Request shape:
```json
{
  "execution_id": "exec_123",
  "mission_id": "mis_123",
  "run_id": "run_123",
  "step_id": "step_123",
  "step_kind": "implement",
  "context_bundle_id": "ctx_123",
  "envelope": {
    "repo_path": "/repo",
    "worktree_path": "/repo/.worktrees/run_123",
    "allowed_tools": ["file", "terminal"],
    "allowed_actions": ["read", "write", "test"],
    "approval_mode": "on_policy_trigger",
    "timeout_seconds": 1800,
    "output_dir": "/artifacts/run_123"
  }
}
```

Accepted response:
```json
{
  "execution_id": "exec_123",
  "accepted": true,
  "status": "running",
  "stream_url": "/contracts/v1/steps/exec_123/events"
}
```

Notes:
- accepted != completed
- MissionControl marks lifecycle state as running in its own system-of-record

### 3. Stream Step Events

Direction:
- MissionControl subscribes to Hermes stream

Purpose:
- consume progress, tool, and status events during execution

Transport options:
- SSE first
- WebSocket later if needed

Operation:
- `GET /contracts/v1/steps/{execution_id}/events`

Event schema:
```json
{
  "event_id": "evt_123",
  "timestamp": "2026-04-18T18:00:00Z",
  "execution_id": "exec_123",
  "mission_id": "mis_123",
  "run_id": "run_123",
  "step_id": "step_123",
  "type": "step.progress",
  "sequence": 12,
  "payload": {
    "message": "Running targeted tests",
    "percent": 65
  }
}
```

### 4. Interrupt Step

Direction:
- MissionControl → Hermes

Purpose:
- request pause/stop without losing auditability

Operation:
- `POST /contracts/v1/steps/{execution_id}/interrupt`

Request:
```json
{
  "reason": "approval_requested",
  "requested_by": "missioncontrol"
}
```

Response:
```json
{
  "execution_id": "exec_123",
  "accepted": true,
  "status": "interrupting"
}
```

### 5. Resume Step

Direction:
- MissionControl → Hermes

Purpose:
- continue governed execution after pause/approval

Operation:
- `POST /contracts/v1/steps/{execution_id}/resume`

Request:
```json
{
  "reason": "approval_granted"
}
```

Response:
```json
{
  "execution_id": "exec_123",
  "accepted": true,
  "status": "running"
}
```

### 6. Final Step Result

Direction:
- Hermes → MissionControl

Purpose:
- return final execution result payload

Delivery:
- final event in stream and/or terminal result endpoint

Recommended result schema:
```json
{
  "execution_id": "exec_123",
  "mission_id": "mis_123",
  "run_id": "run_123",
  "step_id": "step_123",
  "final_outcome": "success",
  "summary": "Implemented async step start and event stream contract",
  "artifacts": [
    {
      "artifact_id": "art_123",
      "kind": "patch",
      "uri": "artifact://run_123/patch.diff"
    }
  ],
  "changed_files": [
    "apps/orchestrator-api/src/index.ts"
  ],
  "command_refs": [
    {
      "kind": "test",
      "label": "pnpm test",
      "ref": "log://run_123/test.log"
    }
  ],
  "issues": [],
  "approval_needed": false,
  "recommended_next_step": "test"
}
```

Critical rule:
- Hermes returns final result payload
- MissionControl alone commits authoritative step/run lifecycle state

## Artifact Model

Hermes returns artifact metadata only.
MissionControl owns artifact persistence.

Artifact metadata shape:
```json
{
  "artifact_id": "art_123",
  "kind": "patch",
  "label": "Implementation diff",
  "uri": "artifact://run_123/patch.diff",
  "content_type": "text/x-diff",
  "created_at": "2026-04-18T18:00:00Z"
}
```

## Error Model

Standard error shape:
```json
{
  "error": {
    "code": "STEP_TIMEOUT",
    "message": "Execution exceeded timeout_seconds",
    "retryable": true,
    "details": {}
  }
}
```

Suggested codes:
- `INVALID_ENVELOPE`
- `UNAUTHORIZED_TOOL`
- `STEP_TIMEOUT`
- `INTERRUPTED`
- `POLICY_BLOCKED`
- `INTERNAL_EXECUTION_ERROR`
- `CONTEXT_LOAD_FAILED`

## Memory Writeback

Default model:
- not a first-class MissionControl-triggered contract
- Hermes performs memory writeback inside Hermes-side step finalization behavior

Expose later only if MissionControl needs to:
- trigger writeback explicitly
- observe writeback status separately
- retry writeback independently
- audit writeback as its own operational unit

## Next Implementation Targets

1. formalize OpenAPI spec under `packages/contracts`
2. generate TS models for MissionControl
3. generate Python models for Hermes
4. wire `load_context`, `start_step`, and step event stream first
5. add interrupt/resume semantics after basic start/stream/final-result flow is stable
