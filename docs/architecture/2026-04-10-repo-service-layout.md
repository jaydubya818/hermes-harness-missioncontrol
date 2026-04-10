# Repo and Service Layout

Goal: define a repo/service map that preserves the MissionControl and Agentic-KB strengths while reducing coupling.

## Recommendation

Use a multi-repo or monorepo-with-clear-boundaries layout.
Best default for speed: monorepo named `agentic-harness` with independent apps/packages.

## Proposed Layout

```text
agentic-harness/
├── apps/
│   ├── harness-console/          # MissionControl-derived UI shell
│   ├── orchestrator-api/         # orchestration HTTP/WebSocket API
│   ├── worker-runtime/           # step executor / sandbox manager
│   ├── memory-api/               # Agentic-KB-derived API surface
│   └── eval-api/                 # replay/eval/score service
├── packages/
│   ├── shared-types/             # ids, event schemas, API DTOs
│   ├── workflow-engine/          # workflow template renderer/executor
│   ├── policy-engine/            # risk gates and approval rules
│   ├── agent-runtime-core/       # runtime lifecycle, heartbeat, execution contracts
│   ├── memory-runtime/           # context loader, writeback, promotion, retention
│   ├── eval-core/                # replay, scoring, regression
│   ├── model-router/             # cost-aware model selection
│   ├── event-bus/                # append-only events / queue helpers
│   └── ui-kit/                   # shared console components, HUD-inspired panels
├── services/
│   ├── github-adapter/
│   ├── ci-adapter/
│   ├── deploy-adapter/
│   ├── observability-adapter/
│   └── secrets-adapter/
├── workflows/
│   ├── bugfix.yaml
│   ├── test-generation.yaml
│   ├── dependency-upgrade.yaml
│   ├── refactor.yaml
│   └── canary-deploy.yaml
├── docs/
│   ├── architecture/
│   ├── product/
│   └── plans/
└── vault/
    └── agentic-kb/               # optional embedded development vault or external mount
```

## Service Responsibilities

### harness-console
- React/Vite or Next.js app
- operator-facing surfaces only
- calls orchestrator-api and memory-api
- should not call runtimes directly

### orchestrator-api
- start/stop missions
- list runs/steps/artifacts
- approvals
- WebSocket for live events
- dispatches to worker-runtime
- reads/writes execution state

### worker-runtime
- ephemeral execution environments
- repo sandboxes/worktrees/containers
- actual agent step execution
- artifact capture
- runtime heartbeat and logs

### memory-api
- wraps Agentic-KB runtime
- context bundle load
- writeback
- search/read article
- project summary
- promotion and rewrite endpoints

### eval-api
- benchmark replay
- scoring
- regression checks
- routing/prompt/policy comparison jobs

## Storage Model

Execution state store:
- projects, missions, runs, steps, approvals, artifacts, deploys, incidents
- can be Postgres or Convex in early development
- if speed is the priority, Convex is fine initially for console state

Memory store:
- filesystem markdown vault plus metadata/logs
- Agentic-KB remains the source of truth
- optional SQLite/postgres indices later for search and analytics

Event log:
- append-only JSONL or durable queue in v1
- can evolve into Kafka/NATS/etc only if needed

Artifact store:
- patch diffs
- test reports
- logs
- replay bundles
- deploy manifests
- screenshots if needed

## Migration Recommendation from Current Repos

### MissionControl → harness-console / orchestrator-api / selected packages
Extract and preserve:
- apps/mission-control-ui → apps/harness-console
- packages/workflow-engine → packages/workflow-engine
- packages/policy-engine → packages/policy-engine
- packages/coordinator → pieces into orchestrator-api
- packages/model-router → packages/model-router
- packages/agent-runtime → packages/agent-runtime-core
- selected shared types → packages/shared-types

Do not carry forward by default:
- CRM/office/telegraph/hiring features
- broad comms packages unless directly needed

### Agentic-KB → memory-api / packages/memory-runtime
Extract and preserve:
- compile/search/query patterns
- audit logging
- context ranking pipeline
- memory runtime plan concepts
- CLI/MCP compatibility patterns where helpful

Keep external if faster:
- it is acceptable for Agentic-KB to remain a sibling repo and be integrated over HTTP at first

## UI Kit Direction

Create packages/ui-kit from:
- MissionControl reusable UI primitives
- Hermes HUD UI panel patterns
- keyboard-first command palette
- capacity bars, sparklines, status rows, compact operator cards

## Best Default Build Order

1. Keep Agentic-KB as separate repo and expose memory-api
2. Fork MissionControl UI into harness-console
3. Build orchestrator-api as the slim new execution gateway
4. Pull over packages/workflow-engine, policy-engine, model-router
5. Add eval-api only after runtime and memory flows are stable
