# Hermes Harness with MissionControl

TypeScript control plane for governed Hermes execution.

This repo is not Hermes itself. Hermes stays in its own repo/runtime. This repo provides the MissionControl side:
- mission/run/step lifecycle
- policy and approval gates
- governed execution envelopes
- artifact and audit persistence
- eval recording
- operator read models and console
- local reference worker/runtime for contract verification

Core rule:
- MissionControl governs
- Hermes thinks
- contracts, not imports, define the boundary

## What this repo is

MissionControl is the system of record for:
- missions
- runs
- steps
- approvals
- artifacts
- audit/events
- operator-visible status

Hermes or the worker executes inside a MissionControl-issued envelope with:
- worktree path
- allowed tools/actions
- writable paths
- timeout
- output directory
- resource budget
- approval mode
- environment classification

## Current architecture

```text
harness-console (5173)   operator UI
orchestrator-api (4302)  mission/run/step lifecycle, approvals, read models, event stream
worker-runtime (4304)    governed execution, worktree isolation, deploy planning
memory-api (4301)        Agentic-KB read/write, task writeback, promotion/discovery flows
eval-api (4303)          eval records, summaries, run scoring surface
```

Workspace packages:
- `packages/contracts` — schema-first MissionControl ↔ Hermes boundary
- `packages/workflow-engine` — run/step lifecycle state machine
- `packages/policy-engine` — approval/risk policy decisions
- `packages/state-store` — JSON persistence helpers
- `packages/shared-types` — IDs and canonical event names
- `packages/memory-runtime` — context load + atomic writeback/promotion helpers
- `packages/eval-core` — eval scoring + summaries
- `packages/ui-kit` — shared console components

## Execution model

Happy path:
1. create mission
2. start run
3. current step enters governed execution
4. MissionControl builds execution envelope
5. worker validates envelope and executes inside isolated worktree/output dirs
6. worker emits canonical execution events
7. MissionControl records authoritative lifecycle state and read models
8. approvals pause high-risk work when policy triggers
9. completion/failure writes artifacts, evals, cleanup, audit state

MissionControl remains truth even when worker events exist.
Events are for streaming, replay, and audit — not the primary lifecycle authority.

## Implemented now

Architecture / contracts:
- approved Hermes ↔ MissionControl split
- schema-first contracts package
- generated TypeScript + Python models
- contract-shaped mission/run/step/event/result flow
- governed execution envelope validation on both orchestrator and worker

Lifecycle / governance:
- start + execute-current flow
- interrupt / resume / retry / cancel-step
- cancel-run
- approval normalization and authoritative `Step.approval_id`
- replay-safe event ingestion by `event_id`
- duplicate artifact protection by `artifact_id`
- orphan worktree cleanup endpoint + optional periodic sweeper

Operator surfaces:
- overview read model
- missions queue
- approvals queue + history
- audit timeline
- mission detail
- run detail
- step detail
- artifact read model with filters/pagination
- console drill-down and live SSE event feed

Worker/runtime:
- isolated git worktree execution
- constrained write scope for implement step
- test/review/deploy step handling
- deploy adapter abstraction: `auto | noop-canary | vercel | render`
- timeout + budget enforcement

Eval / observability:
- eval record persistence and summaries
- eval lifecycle events: `eval.started`, `eval.completed`, `eval.failed`
- canonical event taxonomy including SSE replay/live stream

## Deferred

Not blockers for current pass:
- optional future WebSocket surface if SSE is not enough
- stronger real-provider deploy execution beyond current plan/gating flow
- deeper production hardening beyond current local/control-plane scope

## Important runtime concepts

Governed execution envelope
- MissionControl computes the boundary first
- worker validates again before doing anything
- no permissive fallback

Authoritative read models
- UI should consume read models, not stitch raw event payloads
- raw `/api/events` exists, but operator truth lives in `/api/read-models/*`

Replay / idempotency
- processed event IDs persisted in orchestrator state
- duplicate event replay ignored
- retry clears prior blockers and execution IDs safely

Cleanup
- terminal runs trigger worker cleanup
- `POST /api/maintenance/sweep-orphans` prunes orphaned worktree/output roots
- `ORPHAN_SWEEP_INTERVAL_MS` enables periodic sweep outside normal request flow

## Key APIs

Lifecycle:
- `POST /api/missions`
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
- `POST /api/maintenance/sweep-orphans`

Operator/read models:
- `GET /api/read-models/overview`
- `GET /api/read-models/missions`
- `GET /api/read-models/missions/:id`
- `GET /api/read-models/runs/:id`
- `GET /api/read-models/runs/:runId/steps/:stepId`
- `GET /api/read-models/artifacts`
- `GET /api/read-models/approvals`
- `GET /api/read-models/approval-history`
- `GET /api/read-models/audit`
- `GET /api/events/stream`

## Environment

Most important env vars:
- `HARNESS_OPERATOR_TOKEN` — bearer token for mutating APIs; also used by console auth fallback flow
- `VITE_OPERATOR_TOKEN` — console-side default token for local dev
- `HARNESS_VAULT_ROOT` — memory-api vault root; default `vault/agentic-kb`
- `ORCHESTRATOR_STATE_FILE` — orchestrator persistence file
- `EVAL_STATE_FILE` — eval persistence file
- `WORKER_RUNTIME_ROOT` — worker artifact/output root
- `WORKTREE_ROOT` — worktree root
- `WORKSPACE_CACHE_FILE` — worker bootstrap cache metadata
- `ALLOWED_REPO_ROOT` — root boundary for repo/worktree paths
- `ORPHAN_SWEEP_INTERVAL_MS` — optional periodic orphan cleanup cadence
- `DEPLOY_ADAPTER` — `auto | noop-canary | vercel | render`
- `DEPLOY_BASE_URL` — base URL used in deploy-plan metadata

## Setup

Prereqs:
- Node / pnpm matching workspace lockfile expectations
- local writable `data/` area

Install:
```bash
pnpm install --frozen-lockfile
```

Verify workspace:
```bash
pnpm typecheck
pnpm test
pnpm build
```

Reset local state if needed:
```bash
pnpm dev:reset-state
```

## Run locally

Start each service in separate terminals:
```bash
HARNESS_OPERATOR_TOKEN=dev-secret pnpm dev:memory
HARNESS_OPERATOR_TOKEN=dev-secret pnpm dev:orchestrator
HARNESS_OPERATOR_TOKEN=dev-secret pnpm dev:eval
HARNESS_OPERATOR_TOKEN=dev-secret pnpm dev:worker
VITE_OPERATOR_TOKEN=dev-secret pnpm dev:console
```

Or use the auth helper for console only:
```bash
VITE_OPERATOR_TOKEN=dev-secret pnpm dev:console:auth
```

Service ports:
- memory-api: `4301`
- orchestrator-api: `4302`
- eval-api: `4303`
- worker-runtime: `4304`
- harness-console: `5173`

## Useful commands

Workspace:
```bash
pnpm build
pnpm test
pnpm typecheck
pnpm dev:reset-state
```

Per app/package:
```bash
pnpm --filter orchestrator-api test
pnpm --filter orchestrator-api typecheck
pnpm --filter worker-runtime test
pnpm --filter worker-runtime typecheck
pnpm --filter eval-api test
pnpm --filter harness-console build
pnpm --filter @hermes-harness-with-missioncontrol/contracts test
```

## Docs worth reading first

Architecture:
- `docs/architecture/2026-04-18-hermes-missioncontrol-approved-target-architecture.md`
- `docs/architecture/hermes-missioncontrol-event-model.md`
- `docs/architecture/hermes-missioncontrol-recovery-and-idempotency.md`

Contracts:
- `docs/contracts/hermes-missioncontrol-contracts.md`
- `packages/contracts/schema/openapi.yaml`

Plan/status:
- `docs/plans/hermes-missioncontrol-implementation-plan.md`

Earlier background/reference:
- `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-v1-system-architecture.md`
- `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-repo-service-layout.md`
- `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-integration-contract.md`

## Notes for engineers landing here

- Hermes code does not live here.
- Treat this repo as control plane + reference worker/runtime + operator surfaces.
- Prefer contract/schema changes over ad hoc payload drift.
- Prefer read models over raw event stitching in UI.
- Ignore runtime-generated vault/task logs when evaluating product code changes.
- Current local validation writes safe repo-local implementation artifacts under `.hermes-harness/` during implement-step flows.
