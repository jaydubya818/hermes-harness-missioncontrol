# Hermes Harness with MissionControl

Autonomous software-development harness with operator console, orchestrator/control plane, memory plane, and eval plane. Runs repo-aware, approval-gated execution loops with full artifact tracing.

## Architecture

```
harness-console (5173)   ← operator UI
orchestrator-api (4302)  ← mission/run lifecycle, approval gates, event bus
worker-runtime (4304)    ← isolated git worktree execution, test detection, deploy plans
memory-api (4301)        ← agentic-kb vault read/write, task writeback, bus publishing
eval-api (4303)          ← eval records and run scoring
```

### Packages
- `packages/workflow-engine` — step lifecycle, run state machine
- `packages/policy-engine` — approval gate logic per step kind and risk level
- `packages/memory-runtime` — atomic vault writeback, context loading, learning promotion
- `packages/state-store` — JSON persistence helpers
- `packages/shared-types` — branded IDs, event types, request/response contracts
- `packages/eval-core` — eval record summarization
- `packages/ui-kit` — shared React components

### Design choices
- MissionControl-derived operator console
- Agentic-KB-derived memory runtime and knowledge substrate
- Eval plane: replay, scoring, regression, routing/policy optimization
- Per-run git worktrees for isolation; pnpm monorepo-aware bootstrapping
- Deploy adapter abstraction: `noop-canary | vercel | render | auto`

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
HARNESS_OPERATOR_TOKEN=your-token pnpm --filter memory-api dev
HARNESS_OPERATOR_TOKEN=your-token pnpm --filter orchestrator-api dev
HARNESS_OPERATOR_TOKEN=your-token pnpm --filter eval-api dev
HARNESS_OPERATOR_TOKEN=your-token pnpm --filter worker-runtime dev
pnpm dev:console:auth   # starts console with VITE_OPERATOR_TOKEN=prod-secret
```

## Console Auth
1. Open the Settings tab in the console
2. Paste your `HARNESS_OPERATOR_TOKEN`
3. Save — subsequent mutating actions use bearer auth automatically

## Execution Flow
1. Create a mission (`POST /api/missions`)
2. Start the run (`POST /api/missions/:id/start`)
3. Execute steps (`POST /api/runs/:id/execute-current`) — repeatable until complete
4. Worker creates an isolated git worktree per run
5. Each step: plan → implement → test → review → deploy
6. High-risk steps pause for operator approval
7. Approval or rejection recorded; eval written on run completion
8. Worktree cleaned up after completion or rejection

## Worker Step Kinds
| Kind | What it does |
|---|---|
| `plan` | Reads git status, generates repo-aware implementation plan |
| `implement` | Writes a structured patch artifact into the isolated worktree |
| `test` | Detects test framework (pnpm/yarn/npm/pytest/cargo/go/make), runs it |
| `review` | Diffs actual changed files, builds review artifact |
| `deploy` | Selects provider (vercel/render/noop-canary), generates deploy plan |

## Deploy Adapters
- `auto` — detects `vercel.json` → vercel, `render.yaml` → render, else noop-canary
- `noop-canary` — generates plan artifact only, no real deploy
- `vercel` — generates vercel deploy command + rollback, requires approval
- `render` — generates render deploy command + rollback, requires approval

## MCP Integration (Hermes Agent)
The Hermes agent (`~/.claude/agents/hermes.md`) is wired to two live knowledge sources:

**Obsidian Vault** — via `obsidian` MCP (mcp-remote → localhost:22360)
- Search and retrieve notes with `mcp__obsidian__obsidian_api`
- Read specific notes with `mcp__obsidian__view`
- List vault files with `mcp__obsidian__get_workspace_files`

**Google Workspace** — Calendar credentials at `~/.google-calendar-mcp/credentials.json`
- Activate with `npx @google-calendar-mcp/server` when needed

**Known fix applied:** All Hermes profiles (alan/mira/turing) were updated from the broken `mcp-obsidian` npm package (invalid schema for `read_notes`) to `npx mcp-remote http://localhost:22360/sse`, matching the working Claude Desktop config.

## Agent Config Files
| File | Purpose |
|---|---|
| `~/.hermes/SOUL.md` | Hermes orchestrator operating contract |
| `~/.hermes/AGENTS.md` | Shared mission context for all agents |
| `~/.hermes/memories/USER.md` | Jay's profile and working preferences |
| `~/.hermes/memories/MEMORY.md` | Long-term canonical memory |
| `~/.hermes/profiles/*/SOUL.md` | Per-specialist identity (alan/mira/turing) |
| `~/.claude/agents/hermes.md` | Claude agent definition with session start protocol |
| `config/agents/agent_demo.yaml` | Harness agent capability spec (read/write/forbidden paths) |

## Architecture Docs
- `docs/architecture/2026-04-18-hermes-missioncontrol-approved-target-architecture.md` ← approved target state
- `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-v1-system-architecture.md`
- `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-repo-service-layout.md`
- `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-integration-contract.md`
- `docs/architecture/2026-04-10-harness-console-surface-map.md`

## Notes
- Worker-runtime performs safe repo-local mutation for validation via `.hermes-harness/runs/<run_id>/implementation.json`
- Deploy adapters generate provider-aware plan metadata; real provider execution requires credentials
- Runtime-generated memory logs under `vault/agentic-kb/wiki/agents/agent_demo/` are validation noise — reset before commit with `pnpm dev:reset-state`
