# Hermes ↔ MissionControl Event Model

Status: canonical taxonomy locked in code and schema

## Principles
- MissionControl is system-of-record for mission/run/step truth.
- Events are history, audit input, and replay input.
- Audit read models derive only from canonical events.
- Consumers must dedupe by `event_id`.
- `schema_version = v1` for every current event.

## Canonical envelope
All events use:

```json
{
  "schema_version": "v1",
  "event_id": "evt_123",
  "timestamp": "2026-04-18T18:00:00Z",
  "sequence": 7,
  "source": "missioncontrol",
  "type": "step.started",
  "mission_id": "mis_123",
  "run_id": "run_123",
  "step_id": "plan",
  "execution_id": "exec_123",
  "actor": "operator",
  "payload": {}
}
```

Required envelope fields:
- `schema_version`
- `event_id`
- `timestamp`
- `sequence`
- `source`
- `type`
- `mission_id`
- `payload`

Optional envelope fields by event class:
- `run_id`
- `step_id`
- `execution_id`
- `actor`

## Locked canonical event set

Mission:
- `mission.created`
- `mission.updated`
- `mission.paused`
- `mission.running`
- `mission.cancelled`
- `mission.completed`

Run:
- `run.started`
- `run.running`
- `run.paused`
- `run.completed`
- `run.failed`
- `run.cancelled`

Step:
- `step.started`
- `step.progress`
- `step.paused`
- `step.resumed`
- `step.blocked`
- `step.completed`
- `step.failed`
- `step.cancelled`
- `step.retried`

Tool:
- `tool.started`
- `tool.completed`
- `tool.failed`

Artifact:
- `artifact.created`

Approval:
- `approval.requested`
- `approval.resolved`

Policy / execution guardrails:
- `policy.violation`
- `execution.timeout`
- `execution.budget_exceeded`

## Legacy names removed or normalized
Persisted legacy events are normalized on load:
- `approval.granted` -> `approval.resolved`
- `approval.rejected` -> `approval.resolved`
- `mission.started` -> `mission.running`
- `run.resumed` -> `run.running`
- `step.awaiting_approval` -> `step.blocked`

No new code should emit legacy names.

## Required identifiers by event type

Mission-only:
- required: `mission_id`
- optional: `run_id`, `step_id`, `execution_id`, `actor`
- examples: `mission.created`, `mission.updated`, `mission.running`, `mission.paused`, `mission.cancelled`, `mission.completed`

Run-scoped:
- required: `mission_id`, `run_id`
- optional: `step_id`, `execution_id`, `actor`
- examples: `run.started`, `run.running`, `run.paused`, `run.completed`, `run.failed`, `run.cancelled`

Step-scoped:
- required: `mission_id`, `run_id`, `step_id`
- optional: `execution_id`, `actor`
- examples: `step.started`, `step.progress`, `step.blocked`, `step.paused`, `step.resumed`, `step.completed`, `step.failed`, `step.cancelled`, `step.retried`

Execution-scoped guardrails:
- required: `mission_id`, `run_id`, `step_id`, `execution_id`
- optional: `actor`
- examples: `tool.started`, `tool.completed`, `tool.failed`, `policy.violation`, `execution.timeout`, `execution.budget_exceeded`

Approval-scoped:
- required: `mission_id`, `run_id`, `step_id`
- optional: `execution_id`, `actor`
- examples: `approval.requested`, `approval.resolved`

Artifact-scoped:
- required: `mission_id`, `run_id`, `step_id`
- optional: `execution_id`, `actor`
- examples: `artifact.created`

## Payload rules

### `mission.created`
Required payload fields:
- `mission_id`
- `title`
- `workflow`
- `project_id`
- `status`

Optional:
- `objective`
- `repo_path`
- `workspace_root`
- `policy_ref`
- `profile_ref`
- `summary`

### `mission.updated`
Required:
- `status`
- `summary`

### `mission.running | mission.paused | mission.cancelled | mission.completed`
Required:
- `status`
- `summary`

### `run.started`
Required:
- `run_id`
- `mission_id`
- `workflow_id`
- `status`

### `run.running | run.paused | run.completed | run.failed | run.cancelled`
Required:
- `status`
- `current_step_id?` is expected when available

### `step.started`
Required:
- `step_kind`

Optional:
- `approval_mode`
- `state`
- `envelope`

When MissionControl emits dispatch-start for worker execution, `payload.envelope` includes:
- `workspace_root`
- `worktree_path`
- `output_dir`
- `repo_scope`
- `allowed_tools`
- `allowed_actions`
- `timeout_seconds`
- `resource_budget`
- `approval_mode`
- `environment_classification`

### `step.progress`
Required:
- `message`
- `phase`

### `step.blocked`
Required:
- `reason`

Optional:
- `approval_id`

### `step.paused | step.resumed | step.cancelled`
Required:
- control or reason context in payload

### `step.completed`
Required:
- step completion summary or execution result context

### `step.failed`
Required:
- failure summary

### `step.retried`
Required:
- none

Optional:
- `previous_execution_id`

### `tool.started | tool.completed | tool.failed`
Required:
- `tool_name`
- `step_kind`

Optional:
- `summary`

### `artifact.created`
Required:
- `artifact_id`
- `kind`
- `label`
- `uri`

Optional:
- `metadata`
- `created_at`
- `created_by`

### `approval.requested`
Required:
- `approval_id`
- `reason`
- `decision_scope`
- `requested_at`

### `approval.resolved`
Required:
- `approval_id`
- `decision`
- `resolved_at`

Optional:
- `resolved_by`
- `reason`
- `step_id`

### `policy.violation`
Required:
- `reason`
- `violation_kind`

Optional:
- envelope or repo path details
- attempted action/tool

### `execution.timeout`
Required:
- `reason`
- `timeout_seconds`

### `execution.budget_exceeded`
Required:
- `reason`
- `budget`
- `produced`
- `allowed`

## Source ownership

Hermes emits:
- `step.started`
- `step.progress`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `artifact.created`
- `step.completed`
- `step.failed`
- `policy.violation` when worker rejects envelope or path/tool policy
- `execution.timeout`
- `execution.budget_exceeded`

MissionControl emits:
- mission lifecycle events
- run lifecycle events
- approval lifecycle events
- step pause/resume/retry/cancel events
- policy violations from policy-engine / dispatch validation
- artifact.created for MissionControl-side artifact persistence

## Replay semantics
- load path normalizes legacy names into canonical names
- load path rebuilds audit timeline from canonical events
- duplicate `event_id` is ignored
- UI should read `/api/read-models/audit`, not stitch raw internal event variants
