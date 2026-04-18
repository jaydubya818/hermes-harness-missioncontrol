# Hermes + MissionControl Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the approved Hermes + MissionControl target architecture into buildable contracts, streaming execution primitives, and a governed implementation backlog.

**Architecture:** Keep Hermes and MissionControl in separate repos. Start with schema-first contracts and MissionControl-owned lifecycle/artifact state. Implement the smallest async path first: load context -> start step -> stream events -> final result, then add interrupt/resume and eval linkage.

**Tech Stack:** TypeScript strict, Hono/Vite in MissionControl, Python in Hermes, OpenAPI/JSON Schema-generated models, SSE for first streaming transport.

---

### Task 1: Freeze the approved architecture as canonical reference

**Files:**
- Verify: `docs/architecture/2026-04-18-hermes-missioncontrol-approved-target-architecture.md`
- Verify: `README.md`

**Step 1: Confirm approved architecture doc exists**

Run:
```bash
test -f docs/architecture/2026-04-18-hermes-missioncontrol-approved-target-architecture.md
```
Expected: exit 0

**Step 2: Confirm README links the approved architecture**

Run:
```bash
rg -n "approved target state|2026-04-18-hermes-missioncontrol-approved-target-architecture" README.md
```
Expected: one matching line under `Architecture Docs`

**Step 3: Commit if needed**

```bash
git add README.md docs/architecture/2026-04-18-hermes-missioncontrol-approved-target-architecture.md
git commit -m "docs: add approved Hermes + MissionControl target architecture"
```

### Task 2: Create contracts package skeleton in MissionControl

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/enums.ts`
- Create: `packages/contracts/src/models.ts`
- Create: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/errors.ts`
- Test: `packages/contracts/src/index.test.ts`

**Step 1: Write failing package export test**

Create `packages/contracts/src/index.test.ts` asserting exports exist for:
- `StepKind`
- `StepState`
- `ApprovalMode`
- `FinalOutcome`
- `EventEnvelope`
- `FinalStepResult`

**Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @hermes-harness-with-missioncontrol/contracts test
```
Expected: FAIL because package/files do not exist yet

**Step 3: Create minimal contracts package**

Implement minimal enums/models/events/errors from the contracts doc.

**Step 4: Re-run test**

Run:
```bash
pnpm --filter @hermes-harness-with-missioncontrol/contracts test
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat: scaffold Hermes MissionControl contracts package"
```

### Task 3: Add schema source-of-truth folder

**Files:**
- Create: `packages/contracts/schema/openapi.yaml`
- Create: `packages/contracts/schema/components/events.yaml`
- Create: `packages/contracts/schema/components/models.yaml`
- Create: `packages/contracts/schema/components/errors.yaml`

**Step 1: Write failing validation command**

Run:
```bash
npx @redocly/cli lint packages/contracts/schema/openapi.yaml
```
Expected: FAIL because schema does not exist yet

**Step 2: Create minimal OpenAPI spec**

Include schemas for:
- `LoadContextRequest`
- `LoadContextResponse`
- `StartStepRequest`
- `StartStepAccepted`
- `EventEnvelope`
- `FinalStepResult`
- standard error shape

**Step 3: Re-run lint**

Run:
```bash
npx @redocly/cli lint packages/contracts/schema/openapi.yaml
```
Expected: PASS

**Step 4: Commit**

```bash
git add packages/contracts/schema
git commit -m "feat: add schema-first OpenAPI contract sources"
```

### Task 4: Generate TypeScript models from schema

**Files:**
- Modify: `packages/contracts/package.json`
- Create: `packages/contracts/generated/`

**Step 1: Add generation script**

Add script for OpenAPI -> TS types.

**Step 2: Run generation command**

Run:
```bash
pnpm --filter @hermes-harness-with-missioncontrol/contracts generate
```
Expected: generated TS models written successfully

**Step 3: Add export bridge in `src/index.ts`**

Re-export generated/public types.

**Step 4: Run typecheck**

Run:
```bash
pnpm --filter @hermes-harness-with-missioncontrol/contracts typecheck
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/contracts/package.json packages/contracts/generated packages/contracts/src
git commit -m "feat: generate TypeScript contract models from OpenAPI"
```

### Task 5: Define Python model generation path for Hermes

**Files:**
- Create: `docs/contracts/hermes-python-model-generation.md`
- Optionally create in Hermes repo later: `contracts/generated/`

**Step 1: Document generation approach**

Specify one approach only:
- OpenAPI -> Pydantic models
or
- JSON Schema -> Pydantic models

**Step 2: List exact commands and output paths**

Include:
- generation command
- target package path in Hermes repo
- version sync rule

**Step 3: Commit**

```bash
git add docs/contracts/hermes-python-model-generation.md
git commit -m "docs: define Python contract generation path for Hermes"
```

### Task 6: Wire contracts package into orchestrator-api

**Files:**
- Modify: `apps/orchestrator-api/package.json`
- Modify: `apps/orchestrator-api/src/index.ts`
- Test: `apps/orchestrator-api/src/index.test.ts`

**Step 1: Write failing test for typed execution endpoints**

Add tests asserting request parsing/response shape for:
- context load request proxy shape
- step start accepted shape
- final result ingestion shape

**Step 2: Run tests to verify failure**

Run:
```bash
pnpm --filter orchestrator-api test
```
Expected: FAIL on missing types/shape mismatch

**Step 3: Import shared contracts**

Replace ad hoc inline shapes where appropriate with contract models.

**Step 4: Re-run tests**

Run:
```bash
pnpm --filter orchestrator-api test
```
Expected: PASS

**Step 5: Commit**

```bash
git add apps/orchestrator-api
git commit -m "feat: wire contracts package into orchestrator api"
```

### Task 7: Implement start_step async acceptance path

**Files:**
- Modify: `apps/orchestrator-api/src/index.ts`
- Modify: `apps/worker-runtime/src/index.ts`
- Test: `apps/orchestrator-api/src/index.test.ts`
- Test: `apps/worker-runtime/src/index.test.ts`

**Step 1: Write failing test for async start**

Expected behavior:
- MissionControl starts step
- receives accepted response with `execution_id`
- run/step state becomes running in MissionControl state store

**Step 2: Run test to verify failure**

Run:
```bash
pnpm --filter orchestrator-api test
pnpm --filter worker-runtime test
```
Expected: FAIL due to missing async contract behavior

**Step 3: Implement minimal acceptance flow**

Add:
- `execution_id`
- accepted response
- MissionControl-owned state transition
- no blocking completion in same request

**Step 4: Re-run tests**

Run same commands.
Expected: PASS

**Step 5: Commit**

```bash
git add apps/orchestrator-api apps/worker-runtime
git commit -m "feat: add async governed step start flow"
```

### Task 8: Implement step event streaming (SSE first)

**Files:**
- Modify: `apps/orchestrator-api/src/index.ts`
- Modify: `apps/worker-runtime/src/index.ts`
- Modify: `apps/harness-console/src/App.tsx`
- Test: `apps/orchestrator-api/src/index.test.ts`

**Step 1: Write failing test for SSE event stream**

Assert stream emits:
- `step.started`
- `step.progress`
- `tool.started`
- `tool.completed`
- terminal step result event or final handoff marker

**Step 2: Run tests to verify failure**

Run:
```bash
pnpm --filter orchestrator-api test
```
Expected: FAIL because stream endpoint missing or wrong shape

**Step 3: Implement minimal SSE endpoint**

Add:
- execution-scoped event stream
- monotonic sequence field
- envelope shape from contracts package

**Step 4: Add console-side consumption for visible progress**

Surface event updates in Missions/Run view.

**Step 5: Re-run tests and typecheck**

Run:
```bash
pnpm --filter orchestrator-api test
pnpm --filter harness-console typecheck
```
Expected: PASS

**Step 6: Commit**

```bash
git add apps/orchestrator-api apps/worker-runtime apps/harness-console
git commit -m "feat: add step event streaming over sse"
```

### Task 9: Standardize event taxonomy in code

**Files:**
- Modify: `packages/contracts/src/events.ts`
- Modify: `apps/orchestrator-api/src/index.ts`
- Modify: `apps/harness-console/src/App.tsx`
- Test: `packages/contracts/src/index.test.ts`

**Step 1: Write failing test for allowed event types**

Assert only canonical event names are accepted.

**Step 2: Run test to verify failure**

Run:
```bash
pnpm --filter @hermes-harness-with-missioncontrol/contracts test
```
Expected: FAIL if events still ad hoc

**Step 3: Replace ad hoc event strings with shared enum/union**

**Step 4: Re-run tests**

Run same command.
Expected: PASS

**Step 5: Commit**

```bash
git add packages/contracts apps/orchestrator-api apps/harness-console
git commit -m "feat: standardize Hermes MissionControl event taxonomy"
```

### Task 10: Make MissionControl artifact persistence authoritative

**Files:**
- Modify: `apps/orchestrator-api/src/index.ts`
- Modify: `apps/worker-runtime/src/index.ts`
- Modify: `packages/state-store/src/index.ts` or artifact storage helper path
- Test: `apps/orchestrator-api/src/index.test.ts`

**Step 1: Write failing test for artifact persistence ownership**

Expected behavior:
- Hermes/worker returns artifact metadata only
- MissionControl persists artifact record and emits `artifact.persisted`

**Step 2: Run test to verify failure**

Run:
```bash
pnpm --filter orchestrator-api test
```
Expected: FAIL if artifact truth still ambiguous

**Step 3: Implement minimal persistence path**

**Step 4: Re-run tests**

Run same command.
Expected: PASS

**Step 5: Commit**

```bash
git add apps/orchestrator-api apps/worker-runtime packages/state-store
git commit -m "feat: make MissionControl authoritative for artifact persistence"
```

### Task 11: Add interrupt/resume/cancel semantics

**Files:**
- Modify: `packages/contracts/src/models.ts`
- Modify: `apps/orchestrator-api/src/index.ts`
- Modify: `apps/worker-runtime/src/index.ts`
- Test: `apps/orchestrator-api/src/index.test.ts`

**Step 1: Write failing tests for**
- interrupt request accepted
- resume request accepted
- cancel updates MissionControl lifecycle state authoritatively

**Step 2: Run tests to verify failure**

Run:
```bash
pnpm --filter orchestrator-api test
```
Expected: FAIL

**Step 3: Implement minimal semantics**

**Step 4: Re-run tests**

Run same command.
Expected: PASS

**Step 5: Commit**

```bash
git add packages/contracts apps/orchestrator-api apps/worker-runtime
git commit -m "feat: add interrupt resume and cancel step semantics"
```

### Task 12: Link eval results to runs and steps

**Files:**
- Modify: `apps/eval-api/src/index.ts`
- Modify: `apps/orchestrator-api/src/index.ts`
- Modify: `apps/harness-console/src/App.tsx`
- Test: `apps/eval-api/src/index.test.ts`

**Step 1: Write failing test for eval linkage**

Expected behavior:
- eval result references `run_id` and `step_id`
- console can render eval summary for a completed run

**Step 2: Run test to verify failure**

Run:
```bash
pnpm --filter eval-api test
```
Expected: FAIL

**Step 3: Implement linkage**

**Step 4: Re-run tests**

Run:
```bash
pnpm --filter eval-api test
pnpm --filter harness-console typecheck
```
Expected: PASS

**Step 5: Commit**

```bash
git add apps/eval-api apps/orchestrator-api apps/harness-console
git commit -m "feat: link eval results to runs and steps"
```

### Task 13: Add replayable run history foundation

**Files:**
- Modify: `apps/orchestrator-api/src/index.ts`
- Modify: `packages/state-store/src/index.ts`
- Create: `docs/architecture/run-replay-design.md`

**Step 1: Write failing test for replay history retrieval**

Expected behavior:
- ordered events available per run
- artifact refs preserved
- final result available

**Step 2: Run test to verify failure**

Run:
```bash
pnpm --filter orchestrator-api test
```
Expected: FAIL

**Step 3: Implement minimal replay read model**

**Step 4: Re-run tests**

Run same command.
Expected: PASS

**Step 5: Commit**

```bash
git add apps/orchestrator-api packages/state-store docs/architecture/run-replay-design.md
git commit -m "feat: add replayable run history foundation"
```

### Task 14: Final verification sweep

**Files:**
- Verify whole repo state

**Step 1: Run contracts tests**

```bash
pnpm --filter @hermes-harness-with-missioncontrol/contracts test
```
Expected: PASS

**Step 2: Run service tests**

```bash
pnpm --filter orchestrator-api test
pnpm --filter worker-runtime test
pnpm --filter eval-api test
```
Expected: PASS

**Step 3: Run typechecks**

```bash
pnpm --filter harness-console typecheck
pnpm --filter orchestrator-api typecheck
pnpm --filter worker-runtime typecheck
pnpm --filter eval-api typecheck
```
Expected: PASS

**Step 4: Run full repo checks**

```bash
pnpm test
pnpm typecheck
pnpm build
```
Expected: PASS

**Step 5: Review diff**

```bash
git status -sb
git diff --stat
```
Expected: clean understanding of final deltas

---

Plan complete. This should be executed in sequence, with each task committed independently.
