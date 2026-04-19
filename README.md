# Hermes Harness with MissionControl

Autonomous software-development harness with operator console, orchestrator/control plane, memory plane, and eval plane. Runs repo-aware, approval-gated execution loops with full artifact tracing.

## Architecture

```
harness-console (5173)   ← operator UI
orchestrator-api (4302)  ← mission/run lifecycle, approval gates, event bus
worker-runtime (4304)    ← isolated git worktree execution, governed envelope enforcement
memory-api (4301)        ← agentic-kb vault read/write, task writeback, bus publishing
eval-api (4303)          ← eval records and run scoring
```

### Packages
- `packages/workflow-engine` — step lifecycle, run state machine
- `packages/policy-engine` — approval gate logic per step kind and risk level
- `packages/memory-runtime` — atomic vault writeback, context loading, learning promotion
- `packages/state-store` — JSON persistence helpers
- `packages/shared-types` — branded IDs and canonical event types
- `packages/contracts` — schema-first MissionControl ↔ Hermes boundary
- `packages/eval-core` — eval record summarization
- `packages/ui-kit` — shared React components

### Design choices
- MissionControl-derived operator console
- Agentic-KB-derived memory runtime and knowledge substrate
- Eval plane: replay, scoring, regression, routing/policy optimization
- Per-run git worktrees for isolation; pnpm monorepo-aware bootstrapping
- Deploy adapter abstraction: `noop-canary | vercel | render | auto`
- MissionControl-issued governed execution envelope for every worker step
- Canonical event taxonomy with replay-safe ingestion by `event_id`

## Service Ports
| Service | Port |
|---|---|
| memory-api | 4301 |
| orchestrator-api | 4302 |
| eval-api | 4303 |
| worker-runtime | 4304 |
| harness-console | 5173 |

## Environment Variables
| Variable | Required | Description |
|---|---|---|
| `HARNESS_OPERATOR_TOKEN` | recommended | Bearer token for all mutating API routes |
| `VITE_OPERATOR_TOKEN` | optional | Console-side fallback token for local dev |
| `HARNESS_VAULT_ROOT` | optional | memory-api vault root (default: `vault/agentic-kb`) |
| `ORCHESTRATOR_STATE_FILE` | optional | Orchestrator persistence file |
| `EVAL_STATE_FILE` | optional | Eval persistence file |
| `WORKER_RUNTIME_ROOT` | optional | Worker artifact root |
| `WORKTREE_ROOT` | optional | Git worktree root |
| `WORKSPACE_CACHE_FILE` | optional | Cache metadata for hydrated workspaces |
| `ALLOWED_REPO_ROOT` | optional | Allowed repo root for worker-runtime |
| `ORPHAN_SWEEP_INTERVAL_MS` | optional | Periodic orchestrator cleanup cadence for orphaned run worktrees/artifact roots |
| `DEPLOY_ADAPTER` | optional | `auto \| noop-canary \| vercel \| render` |
| `DEPLOY_BASE_URL` | optional | Base URL used in generated deploy plan metadata |

## Local Run

```bash
# 1. Install
pnpm install --frozen-lockfile

# 2. Verify
pnpm typecheck
pnpm test
pnpm build

# 3. Start all services (separate terminals or use a process manager)
HARNESS_OPERATOR_TOKEN=*** pnpm --filter memory-api dev
HARNESS_OPERATOR_TOKEN=*** pnpm --filter orchestrator-api dev
HARNESS_OPERATOR_TOKEN=*** pnpm --filter eval-api dev
HARNESS_OPERATOR_TOKEN=*** pnpm --filter worker-runtime dev
pnpm dev:console:auth
```

## Execution Flow
1. Create a mission: `POST /api/missions`
2. Start the run: `POST /api/missions/:id/start`
3. Execute current step: `POST /api/runs/:id/execute-current`
4. MissionControl builds a governed execution envelope
5. Worker validates and enforces envelope constraints
6. Worker emits canonical execution events
7. MissionControl records authoritative lifecycle state and operator read models
8. High-risk or policy-triggered steps pause for approval
9. Completion/failure/rejection triggers eval + cleanup

## Lifecycle Controls
- `POST /api/runs/:id/interrupt-step`
- `POST /api/runs/:id/resume-step`
- `POST /api/runs/:id/retry-step`
- `POST /api/runs/:id/cancel-step`
- `POST /api/runs/:id/cancel`

## Maintenance Controls
- `POST /api/maintenance/sweep-orphans` — prunes orphaned worktree / worker-run roots while preserving active non-terminal runs

## Live Event Stream
- `GET /api/events/stream` — SSE replay + live event feed for operator UI filters (`mission_id`, `run_id`, `step_id`, `event_type`, `actor`, `last`)

## Worker Step Kinds
| Kind | What it does |
|---|---|
| `plan` | Reads git status, generates repo-aware implementation plan |
| `implement` | Writes constrained `.hermes-harness` repo mutation inside allowed writable paths |
| `test` | Detects test framework (pnpm/yarn/npm/pytest/cargo/go/make), runs it |
| `review` | Diffs actual changed files, builds review artifact |
| `deploy` | Selects provider (vercel/render/noop-canary), generates deploy plan |

## Deploy Adapters
- `auto` — detects `vercel.json` → vercel, `render.yaml` → render, else noop-canary
- `noop-canary` — generates plan artifact only, no real deploy
- `vercel` — generates vercel deploy command + rollback, requires approval
- `render` — generates render deploy command + rollback, requires approval

## Architecture Docs
- `docs/architecture/2026-04-18-hermes-missioncontrol-approved-target-architecture.md` ← approved target state
- `docs/architecture/hermes-missioncontrol-event-model.md`
- `docs/architecture/hermes-missioncontrol-recovery-and-idempotency.md`
- `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-v1-system-architecture.md`
- `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-repo-service-layout.md`
- `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-integration-contract.md`
- `docs/architecture/2026-04-10-harness-console-surface-map.md`

## Contracts Docs
- `docs/contracts/hermes-missioncontrol-contracts.md`

## Plans
- `docs/plans/hermes-missioncontrol-implementation-plan.md`

## Notes
- Worker-runtime performs safe repo-local mutation for validation via `.hermes-harness/runs/<run_id>/implementation.json`
- Deploy adapters generate provider-aware plan metadata; real provider execution requires credentials
- Runtime-generated memory logs under `vault/agentic-kb/wiki/agents/agent_demo/` are validation noise — reset before commit with `pnpm dev:reset-state`
