# Hermes + MissionControl Implementation Plan

Status: major slices shipped through the 2026-04-18 hardening pass

## Architecture held constant
- Keep Hermes and MissionControl in separate repos.
- MissionControl owns authoritative mission/run/step/approval/artifact/audit state.
- Hermes executes inside a MissionControl-issued envelope.
- Contracts, not imports, define the boundary.

## Shipped slices
- approved target architecture docs
- schema-first contracts package
- generated TypeScript + Python models
- Mission / Run / Step contract adoption in workflow + orchestrator
- contract-shaped execution result and step events
- approval truth normalization
- operator read models:
  - overview
  - missions
  - approvals
  - approval history
  - audit
  - mission detail
  - run detail
  - step detail
  - artifacts
- console drill-down on read models
- pagination and filtering for operator read models
- lifecycle controls:
  - interrupt-step
  - resume-step
  - retry-step
  - cancel-step
  - cancel-run
- governed execution envelope
- canonical event taxonomy lock
- replay/idempotency protections
- artifact/approval hardening
- periodic orphaned worktree cleanup sweeper
- richer eval event taxonomy
- optional SSE event delivery surface
- docs/spec sync

## Current implementation shape

### MissionControl
Owns:
- mission creation
- run creation
- step dispatch
- approval decisions
- lifecycle transitions
- artifact persistence truth
- audit/read-model projection
- replay-safe event ingestion

### Hermes / worker-runtime
Owns:
- step execution inside the envelope
- tool work inside path/action/tool limits
- canonical execution events
- timeout and budget enforcement
- isolated worktree execution

## Remaining intentional follow-ups
These are not blockers for the current architecture pass:
- optional future WebSocket delivery surface if SSE is not sufficient for live operator workflows

## Verification baseline
Fresh verification for this pass should include:
- contracts generate/build/test/typecheck
- shared-types build/typecheck
- workflow-engine build/test/typecheck
- orchestrator-api test/typecheck
- worker-runtime test/typecheck
- eval-core build/test/typecheck
- harness-console build/typecheck
