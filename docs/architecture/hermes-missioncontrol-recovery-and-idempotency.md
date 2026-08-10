# Hermes ↔ MissionControl Recovery and Idempotency

Status: implemented for current control-plane scope

## Goal
Make MissionControl credible under restart, replay, duplicate delivery, and repeated operator actions.

## Implemented protections

### Event ingestion
- MissionControl persists `processed_event_ids` in orchestrator state.
- `recordEvent()` ignores duplicate `event_id`.
- persisted events are normalized on load before reuse.
- worker-supplied `step_events` with unrecognized event types are logged and
  dropped during dispatch instead of failing the request, so a newer/foreign
  worker cannot strand a run mid-step after a successful execution.
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
- manual step-complete requires the current step `running`: completing an
  awaiting-approval step would mint a second pending approval and orphan the
  first in the operator queue, and completing a paused/cancelled step would
  bypass resume/retry (or resurrect a terminal run through the policy gate)
- duplicate operator calls therefore do not mutate state twice
- interrupt/cancel/retry signal the worker abort endpoint (best-effort) so an
  in-flight execution stops its child commands instead of running to the
  envelope timeout; the stale-dispatch guard stays authoritative

### Artifact creation
- workflow-engine attach path dedupes by `artifact_id`
- worker artifact ids are stable per execution when possible
- MissionControl manual artifact POST is idempotent when client repeats the same `artifact_id`
- MissionControl stamps `created_at` at attach time, so artifact read models
  sort on real attach order rather than shared step timestamps

### Worker result replay
- MissionControl reuses an existing `step.execution_id` when redispatching a still-running step after restart
- if that execution is genuinely still in flight on the worker, the worker
  rejects the duplicate dispatch with `409 execution already in flight`
  rather than running two executions against one worktree; the operator can
  abort the live execution or retry (which mints a fresh execution id)
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
- workspace bootstrap-cache updates are serialized through a queue, so
  concurrent step executions cannot lose each other's cache entries (a lost
  entry silently forced a full dependency reinstall on that repo's next step)
- MissionControl calls worker cleanup after completion, rejection, and failure
- worker cleanup removes worktree and branch when possible
- orchestrator exposes `POST /api/maintenance/sweep-orphans` for manual orphan pruning
- optional `ORPHAN_SWEEP_INTERVAL_MS` runs the same orphan sweep periodically outside request-path transitions

Design boundary kept intentionally:
- orphan cleanup stays outside normal mission/run mutation routes
- active non-terminal runs are preserved during sweeping

## Design boundary reminder
- MissionControl owns truth
- Hermes/worker emits events and execution output
- events help reconstruct and audit, but do not replace authoritative run/step state
