# Hermes-harness-with-missioncontrol Blueprint

Working autonomous software-development harness with:
- operator console
- orchestrator/control plane
- memory plane
- eval plane
- repo-aware worker runtime
- approval-gated deploy flow
- authenticated operator actions

Sources evaluated:
- MissionControl: UI and orchestration/control-plane base
- Agentic-KB: memory plane and compiled knowledge substrate
- Hermes HUD UI: operator UX patterns, lightweight dashboard primitives, command palette, refresh model

Primary design choice:
- Hermes Harness Console = MissionControl-derived operator console
- Memory Plane = Agentic-KB-derived memory runtime and knowledge system
- Eval Plane = replay, scoring, regression, routing/policy optimization

Docs:
- docs/architecture/2026-04-10-harness-console-surface-map.md
- docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-integration-contract.md
- docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-v1-system-architecture.md
- docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-repo-service-layout.md
- docs/plans/2026-04-10-hermes-harness-with-missioncontrol-implementation-plan.md

Current capabilities
- persistent orchestrator state
- persistent eval state
- repo-aware isolated execution via git worktrees
- worktree hydration/bootstrap for pnpm monorepos
- framework-aware test command adapters
- structured patch/test/review/deploy artifacts with metadata
- deploy adapter abstraction with canary/rollback plan metadata
- operator auth on mutating endpoints via bearer token
- browser console with proxy-based API access

Service ports
- memory-api: 4301
- orchestrator-api: 4302
- eval-api: 4303
- worker-runtime: 4304
- harness-console: 5173

Required/optional environment variables
- HARNESS_OPERATOR_TOKEN
  - optional but recommended
  - when set, all mutating API routes require:
    - Authorization: Bearer <token>
- HARNESS_VAULT_ROOT
  - memory-api vault root
- ORCHESTRATOR_STATE_FILE
  - orchestrator persistence file
- EVAL_STATE_FILE
  - eval persistence file
- WORKER_RUNTIME_ROOT
  - worker artifact root
- WORKTREE_ROOT
  - git worktree root
- WORKSPACE_CACHE_FILE
  - cache metadata for hydrated workspaces
- ALLOWED_REPO_ROOT
  - allowed repo root for worker-runtime
- DEPLOY_ADAPTER
  - auto | noop-canary | vercel | render
- DEPLOY_BASE_URL
  - base URL used in generated deploy plan metadata

Local run
1. Install
- pnpm install --frozen-lockfile

2. Build + verify
- pnpm typecheck
- pnpm test
- pnpm build

3. Start services
- HARNESS_OPERATOR_TOKEN=your-token pnpm --filter memory-api dev
- HARNESS_OPERATOR_TOKEN=your-token pnpm --filter orchestrator-api dev
- HARNESS_OPERATOR_TOKEN=your-token pnpm --filter eval-api dev
- HARNESS_OPERATOR_TOKEN=your-token pnpm --filter worker-runtime dev
- pnpm --filter harness-console dev

Console auth
- open the Settings tab
- paste HARNESS_OPERATOR_TOKEN
- save token
- subsequent mutating actions use bearer auth automatically

End-to-end behavior
- create mission
- start run
- worker creates isolated worktree
- bootstrap/hydration runs as needed
- implement mutates isolated repo workspace
- test uses detected framework command
- review inspects actual changed files and git status
- deploy creates canary/rollback plan artifact
- high-risk deploy pauses for operator approval
- approval completes run and records eval

Notes
- worker-runtime currently performs safe repo-local mutation for validation via .hermes-harness/runs/<run_id>/implementation.json inside the isolated workspace
- deploy adapters currently generate provider-aware plan metadata; real provider execution depends on credentials/integration setup
- runtime-generated memory logs under vault/agentic-kb/wiki/agents/agent_demo/ may be validation noise and can be reset before commit
