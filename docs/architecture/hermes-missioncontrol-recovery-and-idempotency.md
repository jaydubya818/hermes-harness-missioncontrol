# Hermes ↔ MissionControl Recovery and Idempotency

Status: implemented for current control-plane scope

## Goal
Make MissionControl credible under restart, replay, duplicate delivery, and repeated operator actions.

## Implemented protections

### Event ingestion
- MissionControl persists `processed_event_ids` in orchestrator state.
- `recordEvent()` ignores duplicate `event_id`.
- persisted events are normalized on load before reuse.
- audit timeline is rebuilt from canonical events, not trusted as separate truth.

### Approval resolution
- only `pending` approvals can be resolved
- duplicate response returns `409 approval already resolved`
- stale approval response returns `409 approval is stale`
- cancel-step / cancel-run auto-resolve the active pending approval once

### Lifecycle endpoints
- interrupt requires current step `running`
- resume requires current step `paused`
- retry requires retryable step states only
- cancel-step rejects terminal step states
- cancel-run rejects terminal run states
- duplicate operator calls therefore do not mutate state twice

### Artifact creation
- workflow-engine attach path dedupes by `artifact_id`
- worker artifact ids are stable per execution when possible
- MissionControl manual artifact POST is idempotent when client repeats the same `artifact_id`

### Worker result replay
- MissionControl reuses an existing `step.execution_id` when redispatching a still-running step after restart
- duplicate worker step events are dropped by `event_id`
- duplicate artifacts from replay are dropped by `artifact_id`

## Restart semantics

### Orchestrator restart while run is `running`
- persisted run reloads through `syncRunState()`
- existing `step.execution_id` is preserved
- next dispatch reuses that execution id
- replayed worker events/artifacts are deduped

### Orchestrator restart while run is `paused`
- paused run remains paused
- operator must explicitly resume

### Orchestrator restart while run is `awaiting_approval`
- step approval linkage remains authoritative through `Step.approval_id`
- `Run.approval_id` is recomputed as derived visibility
- approval queue read model remains correct from persisted approvals

### Orchestrator restart with persisted duplicate events
- load path normalizes and replays events through `recordEvent()`
- only one copy survives per `event_id`

## Timeout semantics
- worker-runtime enforces `timeout_seconds` with a hard race around step execution
- timeout emits:
  - `tool.failed`
  - `execution.timeout`
  - `step.failed`
- MissionControl then marks the step/run failed through authoritative workflow state

## Budget semantics
Worker-runtime enforces:
- `resource_budget.max_artifacts`
- `resource_budget.max_output_bytes`
- `resource_budget.token_budget` using a conservative output-size token estimate

Budget failure emits:
- `execution.budget_exceeded`
- `step.failed`

MissionControl then records authoritative failure state.

## Terminal-state guards
Workflow-engine and MissionControl both protect terminal states.

Protected transitions:
- completed/failed/cancelled steps are not paused/resumed/completed/failed/cancelled again
- retry clears prior blockers and clears `execution_id` for the next attempt
- completed/failed/cancelled runs are not cancellable or executable again

## Cleanup semantics
Implemented now:
- MissionControl calls worker cleanup after completion, rejection, and failure
- worker cleanup removes worktree and branch when possible

Explicit follow-up job boundary:
- orphaned worktree sweeper is intentionally separate from request-path logic
- TODO is left in orchestrator load path for the periodic cleanup job

## Design boundary reminder
- MissionControl owns truth
- Hermes/worker emits events and execution output
- events help reconstruct and audit, but do not replace authoritative run/step state
