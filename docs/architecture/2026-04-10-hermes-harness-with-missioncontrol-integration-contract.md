# MissionControl ↔ Agentic-KB Integration Contract

Goal: define the hard interface between the execution/control plane and the memory/knowledge plane.

## Architecture Boundary

MissionControl owns:
- missions
- runs and step execution
- approvals
- runtime policy enforcement
- deployment and rollback operations
- telemetry and audit of execution
- operator controls

Agentic-KB owns:
- persistent agent memory
- project knowledge
- standards, recipes, ADRs, postmortems
- context assembly
- learned pattern promotion
- contradictions, linting, memory retention, provenance

## Shared Identity and IDs

Canonical IDs shared across systems:
- project_id
- mission_id
- run_id
- step_id
- agent_id
- artifact_id
- bundle_id
- rewrite_id
- promotion_id

## Memory Classes

Agentic-KB exposes these memory classes as first-class resources:
- profile
- hot
- working
- learned
- rewrite
- bus

## Critical Runtime Calls

### 1. Load Context Bundle

POST /api/memory/context/load

Request:
```json
{
  "agent_id": "coder-01",
  "agent_role": "coder",
  "project_id": "sellerfi-core",
  "mission_id": "mis_123",
  "run_id": "run_456",
  "step_id": "implement",
  "task_type": "bugfix",
  "task_summary": "Fix Stripe webhook replay duplication",
  "risk_tier": "medium",
  "budget_bytes": 65536,
  "needed_capabilities": ["project-standards", "recent-incidents", "payment-recipes"]
}
```

Response:
```json
{
  "bundle_id": "ctx_789",
  "truncated": false,
  "budget_used": 48210,
  "files": [
    {
      "path": "wiki/agents/workers/coder-01/profile.md",
      "memory_class": "profile",
      "priority": 1,
      "reason": "self-profile",
      "content": "..."
    }
  ],
  "trace": {
    "included": [
      {"path":"...","class":"profile","reason":"self-profile","bytes":1234,"priority":1}
    ],
    "excluded": [
      {"path":"...","reason":"budget"}
    ]
  }
}
```

Rules:
- MissionControl never assembles context itself
- Agentic-KB returns both payload and provenance trace
- traces are displayed in the console

### 2. Close Step / Writeback

POST /api/memory/tasks/close

Request:
```json
{
  "agent_id": "coder-01",
  "project_id": "sellerfi-core",
  "mission_id": "mis_123",
  "run_id": "run_456",
  "step_id": "implement",
  "outcome": "success",
  "summary": "Added replay-key idempotency guard before enqueue",
  "discoveries": [
    {"title":"Webhook replay issue","body":"Missing replay dedupe key caused duplicate downstream jobs."}
  ],
  "gotchas": [
    {"title":"Out-of-order test replay","body":"Local test replay returns out-of-order events unless fixture timestamps are normalized."}
  ],
  "rewrites": [
    {
      "target": "wiki/projects/sellerfi-core/test-strategy.md",
      "kind": "candidate_rewrite",
      "content": "..."
    }
  ],
  "artifacts": [
    {"type":"patch","uri":"artifact://run_456/patch.diff"},
    {"type":"test_report","uri":"artifact://run_456/junit.xml"}
  ]
}
```

Response:
```json
{
  "writeback_id": "wb_123",
  "status": "ok",
  "writes": [
    {"path":"wiki/agents/workers/coder-01/task-log.md","memory_class":"working"},
    {"path":"wiki/agents/workers/coder-01/gotchas.md","memory_class":"learned"}
  ],
  "promotion_candidates": [
    {"item_id":"disc_001","reason":"repeated pattern candidate"}
  ],
  "trace": {"duration_ms": 123}
}
```

Rules:
- writeback is atomic
- policy failure or forbidden path aborts the whole writeback
- MissionControl records returned write paths into its audit ledger

### 3. Publish Discovery / Escalation

POST /api/memory/bus/publish

Request:
```json
{
  "channel": "discovery",
  "agent_id": "reviewer-01",
  "project_id": "sellerfi-core",
  "mission_id": "mis_123",
  "run_id": "run_456",
  "title": "Webhook idempotency should be codified as standard",
  "body": "...",
  "severity": "medium",
  "tags": ["stripe", "webhooks", "idempotency"]
}
```

### 4. Promote Learning

POST /api/memory/promote

Request:
```json
{
  "item_id": "disc_001",
  "promoted_by": "lead-reviewer",
  "target_path": "wiki/domains/backend/standards/webhook-idempotency.md",
  "promotion_kind": "standard"
}
```

Rules:
- workers propose, leads review, operators can override
- canonical docs are mutated only through promotion/merge paths

## Read Models for the Console

### Agent Summary
GET /api/memory/agents/:agent_id/summary

Returns:
- profile summary
- hot memory health
- working memory freshness
- learned item count
- pending rewrites
- promotion backlog
- last context bundle trace
- lint/contradiction warnings affecting this agent

### Project Summary
GET /api/memory/projects/:project_id/summary

Returns:
- standards
- active rewrites
- recent postmortems
- recommended recipes
- recently promoted learnings
- contradictory or stale knowledge warnings

### Search and Article Read
GET /api/memory/search?q=...
GET /api/memory/articles/:slug

MissionControl uses these in:
- Memory
- Docs
- Search
- Peer review guidance
- planning support

## Event Contract

MissionControl emits:
- mission.created
- run.started
- step.started
- step.completed
- step.failed
- approval.granted
- approval.rejected
- deployment.completed
- rollback.triggered
- incident.opened
- incident.closed

Agentic-KB emits:
- context.loaded
- writeback.completed
- discovery.published
- rewrite.submitted
- learning.promoted
- lint.flagged
- contradiction.detected
- memory.compacted

V1 transport recommendation:
- synchronous HTTP for critical request/response flows
- append-only event sink or queue for non-blocking telemetry

## Policy Rules Across the Boundary

MissionControl policy engine decides:
- whether the agent may proceed with the step
- whether approval is required
- whether deploy/merge is allowed

Agentic-KB policy engine decides:
- what the agent may read
- what the agent may write
- where writebacks are routed
- whether a promotion path is legal

These must be separate.
MissionControl should never infer write permissions.
Agentic-KB should never authorize deploy or merge.

## Observability Requirements

Every context load and writeback must be traceable with:
- agent_id
- project_id
- mission_id
- run_id
- step_id
- bundle_id or writeback_id
- latency_ms
- truncated flag
- budget_used
- included/excluded paths
- allow/deny guard decisions

MissionControl UI must show:
- what context was loaded
- why each file was included
- what memory changed after the run
- which knowledge items were promoted from the run

## Non-Negotiable Principle

Agentic-KB is the memory source of truth.
MissionControl is the execution source of truth.
Neither should become a shadow copy of the other.
