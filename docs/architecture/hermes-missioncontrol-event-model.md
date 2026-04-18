# Hermes ↔ MissionControl Event Model

Status: draft event taxonomy aligned with approved target architecture

## Purpose

Define first-class events for:
- live operator UI
- audit trail
- replay/debugging
- eval correlation
- future multi-agent execution

MissionControl remains system-of-record for run state.
Hermes emits execution events inside a governed step.

## Event Principles

- append-only
- ordered per execution stream
- immutable after emission
- schema-versioned
- machine-readable first, UI-friendly second
- streamable over SSE first

## Event Envelope

All events share this envelope:

```json
{
  "schema_version": "v1",
  "event_id": "evt_123",
  "timestamp": "2026-04-18T18:00:00Z",
  "sequence": 15,
  "source": "hermes",
  "type": "tool.started",
  "mission_id": "mis_123",
  "run_id": "run_123",
  "step_id": "step_123",
  "execution_id": "exec_123",
  "payload": {}
}
```

## Envelope Fields

- `schema_version`: contract version
- `event_id`: unique opaque identifier
- `timestamp`: UTC RFC3339 timestamp
- `sequence`: monotonic per execution stream
- `source`: `missioncontrol` or `hermes`
- `type`: event type string
- `mission_id`: mission scope
- `run_id`: run scope
- `step_id`: step scope when applicable
- `execution_id`: execution scope when applicable
- `payload`: event-specific body

## Source Rules

### Hermes emits
- step execution progress
- tool lifecycle
- partial outputs
- generated artifacts metadata
- final execution result event

### MissionControl emits
- mission/run lifecycle events
- approval lifecycle events
- policy blocks
- artifact persistence events
- eval linkage events
- cleanup/completion state transitions

## Canonical Event Types

### Mission lifecycle
- `mission.created`
- `mission.updated`
- `mission.cancelled`

### Run lifecycle
- `run.started`
- `run.paused`
- `run.resumed`
- `run.completed`
- `run.cancelled`
- `run.failed`

### Step lifecycle
- `step.started`
- `step.progress`
- `step.blocked`
- `step.awaiting_approval`
- `step.interrupted`
- `step.resumed`
- `step.completed`
- `step.failed`
- `step.cancelled`

### Tool lifecycle
- `tool.started`
- `tool.progress`
- `tool.completed`
- `tool.failed`

### Artifact lifecycle
- `artifact.created`
- `artifact.persisted`
- `artifact.failed`

### Approval lifecycle
- `approval.requested`
- `approval.resolved`

### Eval lifecycle
- `eval.requested`
- `eval.completed`
- `eval.failed`

### Cleanup lifecycle
- `cleanup.started`
- `cleanup.completed`
- `cleanup.failed`

## Event Payload Shapes

### `mission.created`
Source: MissionControl

```json
{
  "mission_title": "Implement governed async step execution",
  "workflow": "implementation",
  "repo_path": "/repo"
}
```

### `run.started`
Source: MissionControl

```json
{
  "run_state": "running",
  "trigger": "operator_start"
}
```

### `step.started`
Source: MissionControl

```json
{
  "step_kind": "implement",
  "approval_mode": "on_policy_trigger",
  "worktree_path": "/repo/.worktrees/run_123"
}
```

### `step.progress`
Source: Hermes

```json
{
  "message": "Implementing step contract handlers",
  "percent": 40,
  "phase": "implementation"
}
```

### `tool.started`
Source: Hermes

```json
{
  "tool_name": "terminal",
  "tool_call_id": "tool_123",
  "summary": "Run targeted tests"
}
```

### `tool.completed`
Source: Hermes

```json
{
  "tool_name": "terminal",
  "tool_call_id": "tool_123",
  "status": "success",
  "output_ref": "log://run_123/test.log"
}
```

### `artifact.created`
Source: Hermes or MissionControl

```json
{
  "artifact_id": "art_123",
  "kind": "patch",
  "label": "Implementation diff",
  "uri": "artifact://run_123/patch.diff"
}
```

### `artifact.persisted`
Source: MissionControl

```json
{
  "artifact_id": "art_123",
  "storage_uri": "s3://artifacts/run_123/patch.diff"
}
```

### `approval.requested`
Source: MissionControl

```json
{
  "approval_id": "approval_123",
  "reason": "deploy step requires approval",
  "decision_scope": "step"
}
```

### `approval.resolved`
Source: MissionControl

```json
{
  "approval_id": "approval_123",
  "decision": "approved",
  "resolved_by": "operator"
}
```

### `step.blocked`
Source: MissionControl

```json
{
  "reason": "policy_blocked",
  "details": "Requested action outside allowed envelope"
}
```

### `step.completed`
Source: MissionControl

```json
{
  "final_outcome": "success",
  "summary": "Step completed and committed to system-of-record",
  "artifact_count": 2
}
```

### `step.failed`
Source: MissionControl

```json
{
  "final_outcome": "failed",
  "reason": "STEP_TIMEOUT",
  "retryable": true
}
```

### `run.completed`
Source: MissionControl

```json
{
  "final_state": "completed",
  "steps_completed": 5,
  "steps_failed": 0
}
```

### `eval.completed`
Source: MissionControl or Eval service facade

```json
{
  "score": 0.93,
  "pass": true,
  "warnings": []
}
```

## Stream Semantics

### Transport
Initial recommendation:
- SSE for live step/run event streams

Suggested endpoints:
- `GET /contracts/v1/steps/{execution_id}/events`
- `GET /contracts/v1/runs/{run_id}/events`

### Ordering
- ordering guaranteed only within a single execution stream
- `sequence` must be monotonic per stream
- consumers should not assume global ordering across all runs

### Delivery
- at-least-once acceptable initially
- consumers must de-duplicate by `event_id`
- replay endpoint should exist later for debugging and audit hydration

## UI Guidance

Operator UI should treat:
- `step.progress`
- `tool.started`
- `tool.completed`
- `approval.requested`
- `step.completed`
- `step.failed`

as highest-signal events for real-time display.

Low-noise events should be grouped in audit views rather than top-level dashboards.

## Audit Guidance

MissionControl audit ledger should store:
- raw event envelope
- ingestion timestamp
- source
- correlated mission/run/step/execution IDs

Audit log should not rewrite historical events.
If state changes, emit a new event.

## Replay Guidance

Replay/debugging should be based on:
- ordered event stream
- stored artifact refs
- final execution result payload
- approval events
- eval results

This enables:
- timeline reconstruction
- operator debugging
- regression analysis
- future policy simulation

## Future Extensions

Reserved future event families:
- `agent.spawned`
- `agent.completed`
- `agent.failed`
- `memory.writeback.completed`
- `memory.writeback.failed`
- `policy.simulated`
- `policy.overridden`

Do not add these to v1 until operational need exists.

## Rules to Preserve

- Hermes may emit step outcome information
- MissionControl alone commits authoritative step/run lifecycle state
- artifact persistence truth lives in MissionControl
- event schemas live in contracts package, not hidden in either repo internals
