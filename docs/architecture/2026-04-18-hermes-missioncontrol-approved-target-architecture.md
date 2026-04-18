# Approved Target Architecture v2: Hermes + MissionControl

## Goal

Keep Hermes Agent and MissionControl as separate repos with a strict, schema-defined integration boundary.

- Hermes = reasoning runtime
- MissionControl = supervisory control plane

Do not merge codebases now.
Design for loose coupling, explicit contracts, and independent deployability.

## Core Model

### Hermes owns
- reasoning
- planning
- agent behavior inside a step
- tool invocation inside allowed boundaries
- memory behavior
- context assembly
- task summaries
- structured execution outputs

### MissionControl owns
- mission/run/step lifecycle
- orchestration
- approvals
- sandbox/worktree boundaries
- policy enforcement
- allowed tools/actions envelope
- audit trail
- artifact persistence
- run history
- eval triggering
- operator UI
- event streaming and operational visibility

## Clean split

MissionControl governs. Hermes thinks.
Hermes does not govern itself.
MissionControl does not implement agent cognition.

## Repo roles

### 1. Hermes Agent
Repo: `~/.hermes/hermes-agent`
Stack: Python
Role: intelligent execution runtime

Responsibilities:
- execute reasoning within a provided step
- assemble execution context bundles
- use tools allowed by MissionControl
- produce structured outputs and summaries
- interact with memory services behind Hermes-owned behavior
- return progress, events, and results through contract

### 2. MissionControl
Repo: `~/projects/Hermes-harness-with-missioncontrol`
Stack: TypeScript
Role: orchestration/control plane

Responsibilities:
- create missions and runs
- prepare worktrees and sandboxes
- dispatch governed execution steps
- stream events to UI
- pause for approvals
- persist artifacts and audit state
- invoke evals
- manage retries, cancel, resume, and cleanup

## Non-negotiable boundary rules

### MissionControl must never
- import Hermes internals
- depend on Hermes filesystem structure
- reimplement Hermes reasoning logic
- own memory ranking, summarization, or promotion logic

### Hermes must never
- choose its own repo boundaries
- bypass policy
- self-approve governed actions
- own run, audit, or artifact system-of-record
- persist operator-facing run history as primary truth

## Memory boundary

Recommended model:
- Hermes owns memory behavior
- a separate memory service may exist underneath
- MissionControl can request context and consume results only through contract
- MissionControl does not own memory intelligence

Meaning:
- Hermes decides what context to assemble
- Hermes decides what memories to retrieve
- Hermes decides how to summarize and write back
- Hermes decides how to publish learnings

MissionControl is a caller and consumer of those capabilities.

## Execution model

Execution must be async, interruptible, and streamable.

Not:
- one blocking request/response

Instead:
1. `start_step`
2. `stream_step_events`
3. `request_approval` when needed
4. `interrupt_step` or `cancel_step`
5. `resume_step`
6. Hermes returns final step result
7. MissionControl commits authoritative step/run lifecycle state

This is required for:
- long-running tool use
- coding loops
- live UI
- approvals
- retries
- debugging
- operator trust

## Runtime flow

1. Operator creates mission in MissionControl
2. MissionControl creates run and step metadata
3. MissionControl prepares isolated worktree or sandbox
4. MissionControl defines policy envelope:
   - worktree path
   - allowed tools
   - allowed actions
   - approval mode
   - timeout and budget
   - output and artifact directory
5. MissionControl requests an execution context bundle from Hermes
6. MissionControl starts governed step execution
7. Hermes performs reasoning and tool work inside the envelope
8. Hermes emits progress and step events
9. Hermes returns structured outputs, file changes, summaries, and log refs
10. MissionControl evaluates policy:
   - continue
   - block
   - require approval
   - fail
   - retry
11. MissionControl stores artifacts, audit state, and run state
12. Eval layer scores outputs
13. Hermes performs memory writeback through Hermes-owned memory behavior
14. MissionControl updates UI, event history, and final state

## Integration pattern

Preferred order:
1. HTTP/JSON APIs
2. streaming events
3. MCP or tool contract where useful
4. shared schema package for types only

Avoid:
- direct internal imports across repos
- shared DB tables unless forced
- ad hoc payloads
- TS-only contracts manually mirrored in Python

## Contract strategy

### Source of truth
Use schema-first contracts:
- OpenAPI
- JSON Schema
- generated TS + Python models

### Shared contracts package
Example: `packages/contracts`

Contains only:
- mission, run, and step models
- step event schemas
- artifact metadata schemas
- approval request and result schemas
- execution result schemas
- enums and statuses
- error models

Contains types only.
No orchestration logic.
No memory logic.
No business rules.

## Required Hermes-facing contracts

### `load_context`
Purpose:
- assemble execution context bundle for a governed step

### `start_step`
Purpose:
- begin async governed execution for a step

### `stream_step_events`
Purpose:
- provide progress, tool activity, status, and partial outputs

### `interrupt_step`
Purpose:
- pause or stop step without losing auditability

### `resume_step`
Purpose:
- continue from governed paused state

Hermes returns final step result payload.
MissionControl alone commits authoritative step and run lifecycle state.

## Required MissionControl-facing capabilities

- `create_mission`
- `start_run`
- `pause_run`
- `resume_run`
- `cancel_run`
- `request_approval`
- `record_eval`
- `store_artifact`
- `stream_run_events`
- `cleanup_worktree`

MissionControl remains system-of-record for:
- runs
- steps
- approvals
- artifacts
- audit
- operational status

## Event model

Treat events as first-class.

Suggested event types:
- `mission.created`
- `run.started`
- `step.started`
- `step.progress`
- `tool.started`
- `tool.completed`
- `artifact.created`
- `approval.requested`
- `approval.resolved`
- `step.blocked`
- `step.failed`
- `step.completed`
- `run.completed`
- `run.cancelled`

Why:
- live UI
- audit
- replay and debugging
- eval correlation
- observability
- multi-agent future support

## Artifact boundary

### Hermes returns
- artifact metadata
- summaries
- changed files
- log refs
- structured outputs
- patch refs or file refs

### MissionControl owns
- artifact persistence
- run linkage
- audit trail
- retention
- operator visibility
- eval linkage

Artifact system-of-record lives in MissionControl.

## Sandbox and policy boundary

MissionControl owns the execution envelope.

MissionControl passes Hermes:
- worktree path
- repo scope
- allowed tools
- allowed actions
- approval mode
- output dir
- timeout
- resource budget
- environment classification

Hermes operates only inside that envelope.

## Deployment model

Keep deployable units independent.

### Hermes
- runtime service and/or CLI
- versioned independently
- replaceable and upgradable without changing MissionControl internals

### MissionControl
- UI + orchestrator + worker/runtime coordination + audit/eval integration
- versioned independently
- can scale operationally without changing Hermes core

This avoids release lockstep.

## Local dev model

Keep repos separate but easy to run together.

Recommended:
- shared dev bootstrap docs
- one launcher script
- generated contracts
- explicit `.env` mapping
- optional wrapper workspace later

Example:
- `make dev-all`
- `pnpm dev` in MissionControl
- `uv run hermes dev` in Hermes

## What should not be shared

Do not share:
- orchestration logic
- policy engine logic
- memory logic
- approval rules
- repo/worktree management logic
- agent runtime internals
- operator UI internals

Only share:
- schemas
- enums
- payload contracts
- event models

## Phased plan

### Phase 1
- lock ownership boundaries
- define schema-first contracts
- implement async step start + final result
- implement step event streaming
- make MissionControl own artifact persistence
- make Hermes own memory behavior clearly

### Phase 2
- add interrupt, resume, and cancel semantics
- standardize event taxonomy
- add generated TS/Python contract models
- add eval/result linkage
- add replayable run history

### Phase 3
- multi-agent steps
- richer policy automation
- approval policy simulation
- advanced observability and debugging
- cross-run learning promotion workflows

## When a merge would ever make sense

Only consider merging later if all of these become true:
- same team fully owns both long-term
- both always deploy together
- contract boundary becomes artificial overhead
- version skew becomes a chronic problem
- local dev across two repos becomes a real drag on velocity
- Hermes is no longer a reusable runtime outside MissionControl
- MissionControl is no longer a distinct control plane product

If Hermes remains reusable, or MissionControl remains supervisory, keep them separate.

## Final summary

MissionControl is the supervisory control plane and system-of-record for runs, approvals, artifacts, and audit. Hermes is the intelligent runtime that performs reasoning, execution context assembly, memory behavior, and tool-driven execution inside a MissionControl-defined policy envelope. They remain in separate repos, connected through schema-first async contracts and streaming events, with strict ownership boundaries and no shared business logic.
