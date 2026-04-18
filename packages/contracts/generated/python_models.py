from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict

class MissionState(str, Enum):
    PENDING = 'pending'
    RUNNING = 'running'
    AWAITING_APPROVAL = 'awaiting_approval'
    FAILED = 'failed'
    COMPLETED = 'completed'
    CANCELLED = 'cancelled'

class RunState(str, Enum):
    PENDING = 'pending'
    RUNNING = 'running'
    AWAITING_APPROVAL = 'awaiting_approval'
    PAUSED = 'paused'
    FAILED = 'failed'
    COMPLETED = 'completed'
    CANCELLED = 'cancelled'

class StepKind(str, Enum):
    PLAN = 'plan'
    IMPLEMENT = 'implement'
    TEST = 'test'
    REVIEW = 'review'
    DEPLOY = 'deploy'

class StepState(str, Enum):
    PENDING = 'pending'
    READY = 'ready'
    RUNNING = 'running'
    BLOCKED = 'blocked'
    AWAITING_APPROVAL = 'awaiting_approval'
    PAUSED = 'paused'
    FAILED = 'failed'
    COMPLETED = 'completed'
    CANCELLED = 'cancelled'

class ApprovalMode(str, Enum):
    NEVER = 'never'
    ON_POLICY_TRIGGER = 'on_policy_trigger'
    ALWAYS = 'always'

class FinalOutcome(str, Enum):
    SUCCESS = 'success'
    PARTIAL = 'partial'
    BLOCKED = 'blocked'
    FAILED = 'failed'
    CANCELLED = 'cancelled'

class EventSource(str, Enum):
    HERMES = 'hermes'
    MISSIONCONTROL = 'missioncontrol'

class Mission(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mission_id: str
    title: str
    workflow: str
    repo_path: str | None = None
    status: MissionState
    created_at: str
    updated_at: str

class Run(BaseModel):
    model_config = ConfigDict(extra='forbid')
    run_id: str
    mission_id: str
    status: RunState
    current_step_id: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    approval_id: str | None = None
    summary: str | None = None
    created_at: str
    updated_at: str

class Step(BaseModel):
    model_config = ConfigDict(extra='forbid')
    step_id: str
    kind: StepKind
    title: str
    state: StepState
    approval_mode: ApprovalMode
    risk: str | None = None
    execution_id: str | None = None
    approval_id: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    blocked_reason: str | None = None
    notes: str | None = None
    artifacts: list[ArtifactRef]

class ArtifactRef(BaseModel):
    model_config = ConfigDict(extra='forbid')
    artifact_id: str
    kind: str
    uri: str
    label: str
    content_type: str | None = None
    created_at: str | None = None
    metadata: dict[str, Any] | None = None

class ApprovalRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    approval_id: str
    mission_id: str
    run_id: str
    step_id: str
    reason: str
    decision_scope: str
    requested_at: str

class ApprovalResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    approval_id: str
    decision: str
    resolved_at: str
    resolved_by: str | None = None

class TaskExecutionResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    execution_id: str
    mission_id: str
    run_id: str
    step_id: str
    final_outcome: FinalOutcome
    summary: str
    artifacts: list[ArtifactRef]
    changed_files: list[str]
    issues: list[str]
    approval_needed: bool
    recommended_next_step: StepKind | None = None
    confidence: float | None = None
    command_refs: list[dict[str, Any]] | None = None

class EventEnvelope(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: str
    event_id: str
    timestamp: str
    sequence: int
    source: EventSource
    type: str
    mission_id: str
    run_id: str
    step_id: str | None = None
    execution_id: str | None = None
    payload: dict[str, Any]

class ContractError(BaseModel):
    model_config = ConfigDict(extra='forbid')
    error: dict[str, Any]

