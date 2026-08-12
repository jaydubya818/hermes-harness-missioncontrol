# Hermes Workspace V2

Introducing http://Hermes-Workspace.com V2 🤯

Whats New 👇🏻
- 🤯 No fork required
- ⭐️ New Hermes dark + light themes
- 🤖 Agent View Office
- 🚀 Conductor for agent missions
- 👥 Operations for sub agent orchestration

One-liner install:
```bash
curl -fsSL https://hermes-workspace.com/install.sh | bash
```

Repo:
- `https://github.com/outsourc-e/hermes-workspace`

TypeScript MissionControl control plane for governed Hermes execution.

This repo is not Hermes itself. Hermes stays in its own repo/runtime. This repo provides the MissionControl side behind the workspace experience:
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
- manual artifact attachment validates artifact_id/uri/content/metadata types so bad payloads cannot poison dedupe or read models
- mission creation rejects workflow ids that are not in the workflow library
- mission creation validates optional string fields (repo_path, workspace_root, objective, refs) so bad payloads fail at creation, not first dispatch
- mission creation rejects repo_path/workspace_root outside `ALLOWED_REPO_ROOT` with a clear 400 (dispatch still re-validates as defense in depth)
- approval responses validate the actor field instead of 500-ing on non-strings
- persisted state hydration is single-flight, so concurrent first requests cannot double-replay events into live streams
- worker results that land after an operator interrupt/cancel/retry are discarded instead of overriding the operator's decision
- operator interrupt/cancel/retry also signal the worker to abort the in-flight execution's child commands (best-effort; the stale-dispatch guard stays authoritative)
- cancelled runs release their worktree/branch and record an eval, matching the other terminal transitions
- orphan worktree cleanup endpoint + optional periodic sweeper
- the persisted audit trail is restored on load, keeping audit ids stable across restarts
- mission/run/step detail read models report true event totals (not the timeline page size)

Operator surfaces:
- overview read model
- missions queue (each mission surfaces its workflow in the read model and console)
- approvals queue + history
- audit timeline
- mission detail
- run detail
- step detail
- artifact read model with filters/pagination
- console drill-down and live SSE event feed
- console step/run lifecycle controls (interrupt, resume, retry, cancel step, cancel run)
- docs browser lists wiki subdirectories separately and navigates into them

Worker/runtime:
- isolated git worktree execution
- constrained write scope for implement step
- write targets that resolve outside the worktree are rejected even when `writable_paths` grants the whole repo
- test/review/deploy step handling
- deploy adapter abstraction: `auto | noop-canary | vercel | render`
- timeout + budget enforcement
- unknown step kinds are rejected instead of falling through to the deploy path
- resource budgets must be finite positive numbers, so malformed budgets cannot silently disable enforcement
- malformed repo_scope/envelope paths are reported as policy violations instead of bare TypeErrors
- pnpm reinstall is skipped when the workspace is already hydrated at the cached source commit
- workspace hydration tolerates dangling `node_modules` symlinks instead of crashing on EEXIST
- failure event streams emit exactly one `tool.failed` per failure (generic errors no longer duplicate it)
- `branch_name` is validated before it reaches `git worktree add -B` / `git branch -D` (flag-like or non-string names fail as policy violations)
- envelope timeouts abort in-flight child commands (installs, git ops, deploy planning) instead of letting them keep mutating the worktree after the step already failed
- workspace setup (worktree creation, dependency bootstrap) runs inside the same timeout/abort scope, so a hung bootstrap install fails the step at the envelope timeout too
- `POST /api/abort-execution` aborts a live execution by `execution_id`; duplicate dispatches for a still-running execution id are rejected

Eval / observability:
- eval record persistence and summaries (including `total_approvals`)
- `GET /api/evals` supports `order=desc` for newest-first paging
- eval lifecycle events: `eval.started`, `eval.completed`, `eval.failed`
- canonical event taxonomy including SSE replay/live stream
- non-JSON worker responses fail the dispatch with the worker's HTTP status instead of a JSON parse error
- memory promotions validate frontmatter fields and attribute per-agent counts by exact `promoted_by` line
- eval lifecycle events are classified under an `eval` audit-timeline kind (filterable in the console)
- close-task writebacks validate outcome/step_id/note collections and keep line-anchored wiki fields single-line
- memory search anchors result snippets at the first content match
- atomic state/wiki writers clean up their temp files when a write fails
- concurrent close-task writebacks and bus publishes are serialized so appends are never lost
- bus publishes validate the channel against the `PublishBusRequest` union
- heading-like lines inside free-text bodies (task-log summaries, rewrite content, bus bodies) are escaped so callers cannot forge entry boundaries
- eval submissions validate `created_at` and stamp receipt time when it is omitted
- rewrite-candidate parsing is position-independent, and console promotions use unique target paths so earlier promotions are never overwritten
- article listings hide dotfiles (in-flight atomic-write temp files)
- memory ids must be strings (numeric ids no longer coerce into path joins that 500)
- promotions refuse to overwrite an existing article (409) so promoted stubs can never clobber standards or task logs; the guard is serialized, so concurrent promotes to the same target cannot race past it
- console memory writeback/promote actions surface HTTP errors instead of rendering error bodies
- ids are generated with crypto-strength randomness (colliding event ids were silently dropped by replay dedupe)
- eval-api first-request state hydration is single-flight, matching the orchestrator-api guard

Network / service posture:
- all four APIs bind to loopback by default (`HOST` opts into wider exposure); @hono/node-server would otherwise listen on `0.0.0.0`
- CORS is an explicit origin allowlist (`CORS_ALLOWED_ORIGINS`) instead of a wildcard, closing the drive-by-localhost window
- `pnpm audit --prod` is clean (hono 4.12.34, @hono/node-server 2.x)

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
- spawned repo commands (installs, test scripts, deploy planning) run with operator credentials stripped from their environment, so repo-controlled scripts cannot replay `HARNESS_OPERATOR_TOKEN` against the loopback APIs
- run branches are namespaced under `hermes/`; the worker refuses to create, force-reset, or delete branches outside that namespace

Authoritative read models
- UI should consume read models, not stitch raw event payloads
- raw `/api/events` exists, but operator truth lives in `/api/read-models/*`

Replay / idempotency
- processed event IDs persisted in orchestrator state
- duplicate event replay ignored, including after restart for events already evicted from the retained event window
- unrecognized persisted events are skipped (with a warning) on load instead of turning every request into a 500
- eval submissions carrying an `eval_id` are deduplicated by eval-api; malformed scoring fields are rejected with a 400
- retry clears prior blockers and execution IDs safely
- a discarded stale dispatch clears the dead execution id from the paused step, so the post-resume re-dispatch mints a fresh id instead of colliding with already-recorded event/artifact ids
- concurrent `execute-current` dispatches for the same run are rejected with a 409 while one is in flight
- `GET /api/events/stream` resumes from `Last-Event-ID` (header or `last_event_id` query param) on reconnect, falling back to `last`-count replay when the id has been evicted

Sidecar call bounds
- orchestrator calls to eval-api and memory-api abort after 10s; worker cleanup after 60s
- worker step execution is bounded by the envelope timeout plus a 60s bootstrap/cleanup margin (the worker still enforces the envelope timeout itself)

Cleanup
- terminal runs trigger worker cleanup
- run branches and worktree bookkeeping are pruned even when the worktree directory is already gone (deletion is restricted to `hermes/` run branches)
- unexpected git cleanup failures (worktree remove, branch delete) are logged and returned as `warnings` on the cleanup response instead of a silent `ok`
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
- `GET /api/read-models/workflows`
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
- `HARNESS_OPERATOR_TOKEN` — bearer token guarding all mutating APIs and all read endpoints (orchestrator, eval, memory) except `/health`; the SSE event stream also accepts it as a `token` query parameter since `EventSource` cannot send headers; also used by console auth fallback flow
- `HOST` — bind address for each API service (default `127.0.0.1`; set explicitly, e.g. `0.0.0.0`, to expose a service beyond the machine)
- `CORS_ALLOWED_ORIGINS` — comma-separated origin allowlist for cross-origin API access (default `http://localhost:5173,http://127.0.0.1:5173`, the console dev origins; the console normally uses the Vite proxy and needs no CORS)
- `SSE_HEARTBEAT_MS` — keep-alive comment cadence on `GET /api/events/stream` (default 25000, 0 disables)
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

`pnpm typecheck` bootstraps workspace package build outputs first so dependent apps/packages can resolve workspace types from a clean checkout.

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

There is no dedicated repo-wide ESLint command yet; use `pnpm typecheck` + `pnpm test` as the current validation baseline.

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
