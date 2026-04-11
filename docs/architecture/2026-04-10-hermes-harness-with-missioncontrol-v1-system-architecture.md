# v1 System Architecture — Hermes-harness-with-missioncontrol

## Product Wedge

v1 automates bounded software-development workflows:
- bug fixes with repro
- test generation
- dependency upgrades
- targeted refactors
- review assistance
- controlled canary deploys for low-risk changes

Not v1:
- unconstrained feature development across arbitrary repos
- unrestricted production changes
- broad internal operations / CRM / office / hiring features

## System Planes

### 1. Hermes Harness Console
Derived from MissionControl UI.
Responsibilities:
- operator overview
- missions queue
- run detail and artifacts
- approvals
- audit ledger
- deployment control
- telemetry
- memory visibility

### 2. Orchestrator
Responsibilities:
- mission decomposition
- workflow template selection
- DAG/state machine execution
- risk tracking
- cost/budget tracking
- retry, escalation, rollback coordination

### 3. Agent Runtime
Responsibilities:
- per-step execution in sandbox/worktree/container
- tool invocation
- artifact capture
- terminal and file trace collection
- heartbeat/status reporting

### 4. Policy Engine
Responsibilities:
- classify actions by risk
- require or skip approvals
- block forbidden actions
- enforce merge/deploy criteria
- define rollback triggers

### 5. Memory Plane
Derived from Agentic-KB.
Responsibilities:
- context bundle assembly
- agent memory classes
- standards/recipes/postmortems/ADRs
- writeback routing
- promotions and rewrites
- memory retention and provenance

### 6. Eval Plane
Responsibilities:
- benchmark tasks
- historical replay
- run scoring
- reviewer override tracking
- regression suites for prompts/policies/routing
- safe optimization loop for routing/retrieval/policies

### 7. Integrations Layer
Responsibilities:
- GitHub/Git
- CI
- deployment target
- observability
- issue tracker
- docs
- secrets broker

## Runtime Sequence

1. Operator creates mission in Hermes Harness Console
2. Orchestrator chooses workflow template and task DAG
3. Planner requests scoped context bundle from Agentic-KB
4. Planner produces structured execution plan
5. Runtime spins isolated branch/worktree/container for implementation step
6. Coder executes against scoped context and repo sandbox
7. Test agent runs targeted suites and captures artifacts
8. Review agent evaluates patch + policy + standards hints from memory plane
9. If risk is acceptable, MissionControl requests approval or proceeds automatically by policy
10. Deploy agent performs staging/canary when permitted
11. Telemetry agent watches regressions, anomaly budget, rollback triggers
12. Agentic-KB receives writeback and stores discoveries, gotchas, rewrites, and learned patterns
13. Eval plane records outcome and compares against historical baseline

## v1 Agent Roles

- Planner
- Coder
- Tester
- Reviewer
- Deployer
- Ops/Monitor
- Lead reviewer / approver

Optional later:
- Security specialist
- Incident triager
- Documentation agent
- Dependency specialist

## v1 Core Entities

### MissionControl
- Project
- Mission
- Run
- Step
- Agent
- Approval
- Artifact
- Deployment
- Incident
- PolicyDecision

### Agentic-KB
- AgentProfile
- HotMemory
- WorkingMemory
- LearnedMemory
- RewriteCandidate
- Standard
- Recipe
- Postmortem
- ContextBundle
- PromotionRecord
- BusItem

## State and Data Flow

MissionControl is authoritative for:
- mission state
- execution status
- approvals
- deployment actions
- audit of runtime events

Agentic-KB is authoritative for:
- memory content
- knowledge articles
- context construction
- learned patterns
- promotion lineage

Eval plane is authoritative for:
- scorecards
- replay results
- regression baselines
- optimization metrics

## Safety Model

Low-risk automated:
- test generation
- lint/fix
- docs changes
- dependency update PRs
- small bugfixes with passing tests and low-risk review score

Requires approval:
- database migrations
- security-sensitive changes
- policy changes
- merge to protected branch
- production deploy
- destructive operations
- high-cost retries or repeated failures

## Why This Architecture

- MissionControl already solves operator console, workflow visibility, and approval surfaces
- Agentic-KB already solves compiled knowledge, context quality, and durable memory better than naïve RAG
- Hermes HUD UI shows how to make the console fast, dense, keyboard-driven, and easy to scan
- separating execution, memory, and evaluation prevents an opaque monolith and makes continuous improvement measurable
