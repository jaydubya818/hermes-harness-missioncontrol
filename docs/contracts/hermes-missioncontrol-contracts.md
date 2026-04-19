# Hermes ↔ MissionControl Contracts

Status: implemented and current as of 2026-04-18 hardening pass

## Core rule
- MissionControl governs authoritative mission/run/step/approval/artifact/audit state.
- Hermes executes inside a MissionControl-issued envelope.
- Contracts, not imports, connect the repos.

## Source of truth
- OpenAPI: `packages/contracts/schema/openapi.yaml`
- Generated TypeScript: `packages/contracts/src/generated/openapi.ts`
- Generated Python: `packages/contracts/generated/python_models.py`

## Implemented contract models

### Mission
Fields:
- `mission_id`
- `title`
- `objective?`
- `workflow`
- `project_id`
- `policy_ref?`
- `profile_ref?`
- `repo_path?`
- `workspace_root?`
- `status = pending | running | awaiting_approval | paused | failed | completed | cancelled`
- `active_run_id?`
- `summary?`
- `created_at`
- `updated_at`

### Run
Fields:
- `run_id`
- `mission_id`
- `status = pending | running | awaiting_approval | paused | failed | completed | cancelled`
- `current_step_id?`
- `started_at?`
- `completed_at?`
- `approval_id?`  # derived convenience only
- `summary?`
- `created_at`
- `updated_at`

### Step
Fields:
- `step_id`
- `kind = plan | implement | test | review | deploy`
- `title`
- `state = pending | ready | running | blocked | awaiting_approval | paused | failed | completed | cancelled`
- `approval_mode = never | on_policy_trigger | always`
- `risk? = low | medium | high`
- `execution_id?`
- `approval_id?`  # primary approval linkage truth
- `started_at?`
- `completed_at?`
- `blocked_reason?`
- `notes?`
- `artifacts: ArtifactRef[]`

### ArtifactRef
Fields:
- `artifact_id`
- `kind`
- `uri`
- `label`
- `content_type?`
- `created_at?`
- `metadata?`

### ApprovalRequest
Fields:
- `approval_id`
- `mission_id`
- `run_id`
- `step_id`
- `reason`
- `decision_scope = step | run`
- `requested_at`

### ApprovalResult
Fields:
- `approval_id`
- `decision = approved | rejected`
- `resolved_at`
- `resolved_by?`

## Governed execution envelope

MissionControl builds and validates the envelope before worker dispatch.
Worker validates again before execution.
No permissive fallback is allowed.

### RepoScope
- `root_path`
- `writable_paths[]`

### ResourceBudget
- `token_budget`
- `max_artifacts`
- `max_output_bytes`

### ExecutionEnvelope
Required fields:
- `worktree_path`
- `workspace_root`
- `repo_scope`
- `allowed_tools[]`
- `allowed_actions[]`
- `approval_mode`
- `timeout_seconds`
- `resource_budget`
- `output_dir`
- `environment_classification = sandbox | staging | production | local`

### StepExecutionRequest
Required fields:
- `mission_id`
- `run_id`
- `step_id`
- `execution_id`
- `kind`
- `envelope`

Optional fields:
- `repo_path`
- `branch_name`

## Envelope enforcement rules

Worker-runtime enforces:
- required execution identifiers
- required `allowed_tools`
- required `allowed_actions`
- step-kind → action mapping
- step-kind → required tools mapping
- positive `timeout_seconds`
- positive budget values
- path boundaries for:
  - `workspace_root`
  - `worktree_path`
  - `output_dir`
  - `repo_scope.root_path`
  - `repo_scope.writable_paths`
  - `repo_path`
- git repo requirement for git-dependent step kinds
- repo writes only inside `repo_scope.writable_paths`
- output budget enforcement:
  - token estimate
  - artifact count
  - output bytes

MissionControl envelope defaults:
- worktree root: `WORKTREE_ROOT/<run_id>`
- step output dir: `WORKER_RUNTIME_ROOT/<run_id>/<step_id>`
- no repo-wide write permission by default
- current implement step writes constrained to `.hermes-harness`
- missing repo path falls back to an isolated MissionControl sandbox under `ALLOWED_REPO_ROOT/.missioncontrol-sandboxes/<run_id>` instead of widening to the whole repo root

## Worker API shape in practice

### `POST /api/execute-step`
Request body:
- `StepExecutionRequest`

Success response:
- execution result fields
- workspace metadata
- canonical `step_events[]`

Failure response:
- `run_id`
- `mission_id`
- `execution_id`
- `step_id`
- `success = false`
- `summary`
- `error_code?`
- `step_events[]`

Worker failure responses still emit canonical events such as:
- `policy.violation`
- `execution.timeout`
- `execution.budget_exceeded`
- `step.failed`

## MissionControl API surfaces changed in this pass

Execution/lifecycle:
- `POST /api/missions/:id/start`
- `POST /api/runs/:id/execute-current`
- `POST /api/runs/:id/interrupt-step`
- `POST /api/runs/:id/resume-step`
- `POST /api/runs/:id/retry-step`
- `POST /api/runs/:id/cancel-step`
- `POST /api/runs/:id/cancel`
- `POST /api/runs/:id/artifacts`
- `POST /api/runs/:id/steps/:stepId/complete`
- `POST /api/approvals/:id/respond`

Read models remain operator-facing truth:
- `/api/read-models/overview`
- `/api/read-models/missions`
- `/api/read-models/missions/:id`
- `/api/read-models/runs/:id`
- `/api/read-models/runs/:runId/steps/:stepId`
- `/api/read-models/artifacts`
- `/api/read-models/approvals`
- `/api/read-models/approval-history`
- `/api/read-models/audit`

## Approval rules
- `Step.approval_id` is primary truth
- `Run.approval_id` is derived convenience only
- approval resolution is idempotent-safe via pending-state checks
- cancel-run / cancel-step auto-resolve active pending approval as rejected by `operator`

## Artifact rules
- MissionControl remains artifact system-of-record
- artifact linkage always includes mission/run/step context through run state
- duplicate artifact attach is prevented by `artifact_id`
- duplicate manual artifact POST with same `artifact_id` returns existing artifact instead of creating a second record

## Recovery and replay rules
- processed event ids persist in orchestrator state
- load path normalizes persisted events and rebuilds audit from canonical events
- duplicate event ingestion is ignored by `event_id`
- running steps reuse existing `execution_id` on redispatch after restart
- retry clears prior `execution_id` so the next execution gets a fresh identity
- orphaned cleanup sweeper is intentionally left as a separate periodic job, documented in architecture docs
