# Hermes-harness-with-missioncontrol Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a governed autonomous software-development harness by combining a MissionControl-derived operator console, an Agentic-KB-derived memory plane, and a small eval plane for replay and continuous improvement.

**Architecture:** Use a three-plane design. MissionControl-derived code becomes the execution/control plane UI and orchestration shell. Agentic-KB becomes the memory plane with explicit context loading and writeback. An eval plane records outcomes and replay scores to improve routing, retrieval, and policies safely.

**Tech Stack:** TypeScript strict, React/Vite or Next.js for console, Node services for orchestration/runtime integration, filesystem-backed markdown vault for memory, append-only JSONL events/logs, GitHub/CI/deploy integrations.

---

## Principles

- Start with the lowest-complexity path that proves value.
- Do not attempt unrestricted autonomy in v1.
- Memory before RL.
- Eval before adaptive optimization.
- Strong policy boundaries between execution and memory.
- TDD for all logic-heavy packages.
- Frequent commits.

---

### Task 1: Create the new harness workspace and copy the architecture docs into the repo

**Files:**
- Create: `README.md`
- Create: `docs/architecture/2026-04-10-harness-console-surface-map.md`
- Create: `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-integration-contract.md`
- Create: `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-v1-system-architecture.md`
- Create: `docs/architecture/2026-04-10-hermes-harness-with-missioncontrol-repo-service-layout.md`

**Step 1: Create the workspace**

Run:
```bash
mkdir -p docs/architecture docs/plans apps packages services workflows
```

Expected: directories exist.

**Step 2: Add the saved architecture docs**

Write in the contents from this planning session verbatim.

**Step 3: Commit**

```bash
git init
git add README.md docs/architecture
git commit -m "docs: add harness architecture foundation"
```

### Task 2: Fork and narrow the MissionControl UI into Hermes Harness Console

**Files:**
- Create: `apps/harness-console/`
- Modify: copied MissionControl shell files
- Delete/omit: non-v1 views listed in the surface map

**Step 1: Copy only the core shell and retained views**

Bring over the keep list from the surface map.

**Step 2: Remove non-v1 routes/components**

Delete or do not import the cut list.

**Step 3: Create the new top-level navigation**

Tabs:
- Overview
- Missions
- Agents
- Memory
- Code
- Audit
- Settings

**Step 4: Replace the current view routing table with the narrowed v1 map**

Expected: app boots with only the v1 surfaces.

**Step 5: Commit**

```bash
git add apps/harness-console
git commit -m "feat: create narrowed harness console from mission control"
```

### Task 3: Import Hermes HUD UI interaction patterns into the console

**Files:**
- Create/Modify: `packages/ui-kit/*`
- Modify: `apps/harness-console/src/components/*`

**Step 1: Add panel primitives**

Build reusable HUD-style cards:
- Panel
- CapacityBar
- Sparkline
- StatusRow
- CostCard

**Step 2: Add command palette**

Keyboard shortcuts:
- Ctrl/Cmd+K palette
- numeric tab navigation
- refresh shortcut

**Step 3: Convert the Overview page to compact panels**

Panels:
- Active Missions
- Pending Approvals
- Run Failures
- Memory Health
- Cost Today
- Agent Throughput
- Recent Promotions

**Step 4: Add SWR-like polling for read-only status panels**

Use lightweight fetch refresh for overview, health, cost, memory summary, recent runs.

**Step 5: Commit**

```bash
git add packages/ui-kit apps/harness-console
git commit -m "feat: add hud-inspired console patterns"
```

### Task 4: Create the shared contract package

**Files:**
- Create: `packages/shared-types/src/index.ts`
- Create: `packages/shared-types/src/ids.ts`
- Create: `packages/shared-types/src/events.ts`
- Create: `packages/shared-types/src/memory.ts`
- Test: `packages/shared-types/src/*.test.ts` if needed

**Step 1: Define canonical IDs**

Types:
- project_id
- mission_id
- run_id
- step_id
- agent_id
- artifact_id
- bundle_id
- rewrite_id
- promotion_id

**Step 2: Define request/response DTOs for**
- context load
- task close/writeback
- discovery publish
- promote learning
- memory summary
- project summary

**Step 3: Define event schemas**
- mission.*
- step.*
- deployment.*
- memory.*

**Step 4: Add tests for schema serialization/validation**

**Step 5: Commit**

```bash
git add packages/shared-types
git commit -m "feat: define shared contracts across control and memory planes"
```

### Task 5: Build memory-runtime v0

**Files:**
- Create: `packages/memory-runtime/`
- Test: `packages/memory-runtime/src/*.test.ts`

**Step 1: Implement memory classes**
- profile
- hot
- working
- learned
- rewrite
- bus

**Step 2: Implement agent contract loading**

Contracts define:
- context policy
- allowed writes
- forbidden paths
- budget bytes

**Step 3: Implement context loader**

Input:
- agent_id, project_id, mission_id, run_id, step_id

Output:
- ordered files
- budget/provenance trace
- truncation metadata

**Step 4: Implement writeback transaction**

Input:
- summary
- discoveries
- gotchas
- rewrites
- artifacts

Output:
- written paths
- guard decisions
- writeback trace

**Step 5: Implement promotion path**

Workers propose.
Leads/operators promote.
Canonical docs update only through promotion/merge path.

**Step 6: Add tests**
- context inclusion/exclusion
- forbidden write rejection
- atomic writeback
- promotion legality

**Step 7: Commit**

```bash
git add packages/memory-runtime
git commit -m "feat: add memory runtime v0 with context loading and writeback"
```

### Task 6: Build memory-api service

**Files:**
- Create: `apps/memory-api/`

**Step 1: Expose endpoints**
- POST `/api/memory/context/load`
- POST `/api/memory/tasks/close`
- POST `/api/memory/bus/publish`
- POST `/api/memory/promote`
- GET `/api/memory/agents/:id/summary`
- GET `/api/memory/projects/:id/summary`
- GET `/api/memory/search`
- GET `/api/memory/articles/:slug`

**Step 2: Return trace-rich responses**

**Step 3: Add integration tests around the HTTP boundary**

**Step 4: Commit**

```bash
git add apps/memory-api
git commit -m "feat: expose memory plane api"
```

### Task 7: Build orchestrator-api shell

**Files:**
- Create: `apps/orchestrator-api/`

**Step 1: Expose mission/run/step endpoints**
- create mission
- start run
- update step status
- approvals
- artifact listing
- live event stream

**Step 2: Wire workflow-engine and policy-engine into the service**

**Step 3: Add runtime event logging**

**Step 4: Commit**

```bash
git add apps/orchestrator-api
git commit -m "feat: add orchestrator api shell"
```

### Task 8: Connect console to memory-api

**Files:**
- Modify: `apps/harness-console/src/MemoryView*`
- Modify: `apps/harness-console/src/DocsView*`
- Modify: `apps/harness-console/src/SearchBar*`
- Modify: `apps/harness-console/src/AgentDetail*`

**Step 1: Replace current Convex memory calls with memory-api**

**Step 2: Add context bundle preview to agent detail**

**Step 3: Add project standards and rewrites surface to Memory page**

**Step 4: Add KB-backed docs and search**

**Step 5: Commit**

```bash
git add apps/harness-console
git commit -m "feat: integrate memory plane into harness console"
```

### Task 9: Connect orchestrator to memory lifecycle

**Files:**
- Modify: orchestrator-api
- Modify: worker-runtime

**Step 1: Before each step, request context bundle**

**Step 2: After each step, post writeback**

**Step 3: Store bundle_id and writeback_id on run/step records**

**Step 4: Surface them in audit and task drawer**

**Step 5: Commit**

```bash
git add apps/orchestrator-api apps/worker-runtime apps/harness-console
git commit -m "feat: wire runtime steps to memory lifecycle"
```

### Task 10: Add eval plane skeleton

**Files:**
- Create: `packages/eval-core/`
- Create: `apps/eval-api/`

**Step 1: Record run outcomes with bundle_id and policy decisions**

**Step 2: Add replay job structure for historical tasks**

**Step 3: Add simple scorecard**
- task success
- test pass rate
- override rate
- rollback rate
- cost per run

**Step 4: Commit**

```bash
git add packages/eval-core apps/eval-api
git commit -m "feat: add eval plane skeleton"
```

### Task 11: Add overview KPIs and cost surfaces

**Files:**
- Modify: `apps/harness-console/src/Overview*`

**Step 1: Add cost cards by mission/run/day**

**Step 2: Add memory health cards**

**Step 3: Add recent promotions and rewrite backlog cards**

**Step 4: Add agent throughput and failure panels**

**Step 5: Commit**

```bash
git add apps/harness-console
git commit -m "feat: add operator kpis and cost visibility"
```

### Task 12: Add replay-backed optimization loop

**Files:**
- Modify: eval-core, memory-runtime, model-router, policy-engine

**Step 1: Capture enough data to compare runs by context bundle and routing choice**

**Step 2: Add offline analysis jobs for**
- retrieval quality
- prompt choice
- routing choice
- escalation thresholds

**Step 3: Gate any optimization behind replay benchmark improvement**

**Step 4: Commit**

```bash
git add packages/eval-core packages/memory-runtime packages/model-router packages/policy-engine
git commit -m "feat: add replay-gated optimization loop"
```

---

## Week-by-Week Roadmap

### Week 1
- Tasks 1-4
- ship the workspace, shell fork, HUD patterns, and shared contracts

### Week 2
- Tasks 5-6
- memory runtime v0 and memory-api online

### Week 3
- Tasks 7-9
- orchestrator shell, step lifecycle integration, console-memory integration

### Week 4
- Tasks 10-11
- eval skeleton and operator KPI surfaces

### Week 5+
- Task 12
- replay-backed optimization only after baseline execution is stable

---

## Success Criteria

v1 is successful when:
- an operator can launch a bounded engineering mission
- every agent step loads scoped context from the memory plane
- every step writes back structured learnings
- approvals and policy decisions are visible in the console
- memory promotions are traceable from run → discovery → standard
- replay and scorecards exist before any adaptive tuning is attempted

---

Plan complete and saved to `docs/plans/2026-04-10-hermes-harness-with-missioncontrol-implementation-plan.md`.

Execution recommendation:
- Start with the memory runtime first, then integrate the console, then add eval.
- Do not begin with RL, vector infra, or broad enterprise surfaces.
