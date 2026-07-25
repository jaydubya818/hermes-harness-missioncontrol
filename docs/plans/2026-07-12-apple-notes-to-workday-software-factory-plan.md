# Apple Notes → Workday Software Factory Plan

Date: 2026-07-12
Source window: Apple Notes modified since 2026-07-11T15:27:24Z (last 24h from local PDT extraction)
Extraction count: 5 notes, 7 X links, 1 direct Workday software-factory note

## Executive call

Build this in MissionControl first, not Hermes core and not SellerFi.

## Application status

Applied first slice:
- MissionControl now has factory/work-item contracts, connector scope and loop policy models, fixture-backed factory read-model endpoints, orchestrator tests, and a console Factory tab.
- Hermes Agent was updated to v0.19.0 and now has a reusable `workday-software-factory` skill for routing future Workday/Jira factory work.
- Agentic-Pi-Harness now documents its runtime role in `docs/WORKDAY-FACTORY-RUNTIME-ROLE.md`: Pi is the governed execution lane, not the factory system of record.

Still deferred:
- live Jira/Workday credentials and intake
- approval-gated writeback
- SellerFi adoption
- proactive/time-based loops that can mutate external systems

Reason: the highest-signal note is not “add another agent.” It is “make agent work governable and measurable against real work items.” MissionControl already owns missions, runs, steps, approvals, artifacts, audit, evals, and operator read models. That is the correct control plane for a Workday software factory.

Hermes should remain the thinking/execution runtime. MissionControl should become the factory system of record. SellerFi can consume the same pattern later for beta-blocker execution, but do not drag SellerFi into this until the Workday/Jira loop proves useful.

## Notes reviewed

| # | Note | Modified | Source | Ledger |
|---|---|---:|---|---|
| 1 | New Note | 2026-07-12T14:59:22Z | Oomol/OpenConnector credential-gateway post | applied to credential-scope plan |
| 2 | ericosiu / Jason / Abobsterina links | 2026-07-12T14:47:40Z | Hermes desktop context, PODMEME, Obsidian skill adapter | applied/deferred by bucket |
| 3 | New Note | 2026-07-12T14:29:25Z | Dan Koe articulation article | deferred to comms/leadership layer |
| 4 | Annatar.md / AnatoliKopadze links | 2026-07-12T14:16:30Z | loop types and self-improving agents | applied to MissionControl loop model |
| 5 | Workday software factory note | 2026-07-12T03:43:02Z | direct note text | primary implementation target |

X resolution note: x_search was blocked by xAI credit limit. Resolved the X URLs using local `x-cli tweet get` instead.

## Signal extracted

### 1. Credential gateway / scoped access

Source: OomolStudio / OpenConnector post.

Durable primitive: agents should not receive raw API keys. A gateway should hold credentials and expose scoped capabilities and safe outputs.

Apply to MissionControl:
- Add credential/tool capability scopes to execution envelopes.
- Represent external systems as scoped connectors, not raw env vars.
- Treat Jira, GitHub, Workday, X, Slack, and calendar as connector capabilities with explicit read/write permissions.
- Store credential references as opaque `secret_ref` values; never expose tokens to workers or UI localStorage.

Relevant current risk:
- `apps/harness-console/src/App.tsx` currently reads provider API keys from localStorage and forwards them as request headers for LLM selection. That is fine for local prototype, but wrong for a production factory.

### 2. Hermes desktop / context management

Source: ericosiu post.

Durable primitive: the killer feature is context packaging, not model choice.

Apply to MissionControl:
- Every factory run should start from a “context packet”: Jira item, acceptance criteria, repo scope, relevant docs, prior attempts, approval/risk profile.
- Every run should end with a “receipt packet”: changed files, checks, artifacts, evidence, residual risks, follow-up tasks.

### 3. PODMEME topic-stream idea

Source: Jason post.

Durable primitive: aggregate multiple sources into topic-based review streams.

Defer as a product feature. Useful later for Jay’s briefings, but not on the critical path for Workday factory execution.

Potential later application:
- MissionControl/briefing runner clusters Jira changes, PRs, agent runs, and meetings by initiative and creates a “playable” operator review stream.

### 4. Obsidian skill adapter

Source: Abobsterina post about Obsidian CEO’s Claude skill.

Durable primitive: apps become agent-useful when they ship an adapter that encodes app-specific rules and file formats.

Apply carefully:
- Do not point agents with broad write access at Jay’s personal Obsidian vault.
- For factory work, create adapters for Agentic-KB / safe workspace docs first.
- For Workday, create a `workday-factory` skill/adapter that teaches agents how to interpret Jira fields, acceptance criteria, story hierarchy, approval rules, and receipt requirements.

### 5. Articulation article

Source: Dan Koe article link.

Durable primitive: communication quality matters, but this is not factory infrastructure.

Defer:
- Apply to leadership updates, interview prep, stakeholder messages, and Workday AI operating-model comms.
- Do not implement this in MissionControl v0.1.

### 6. Loop taxonomy and self-improving agents

Source: xieike loop post and AnatoliKopadze/Andrew Ng loop post.

Durable primitive: prompting is not the unit. Loops are the unit.

Apply to MissionControl:
- Model loop type explicitly: turn-based, goal-based, time-based, proactive.
- Add evaluator receipts so goal-based loops can retry until “done” is verified.
- Add budget and timeout gates so loops do not become unattended spend machines.
- Learning candidates must go to review first; do not let the system self-modify its own controls automatically.

### 7. Workday software factory note

Direct note text:
- Build a Workday software factory by combining the software factory, MissionControl, Loom, Hopper, Context, and Workbench ideas.
- Factory must see Jira board, epics, stories, and tasks.
- Operator should see how many stories/tasks each team member closes with agents.
- Target throughput: dozens of stories/day, hundreds of tasks/day.

This is the plan’s primary target.

## Target architecture

```text
Jira / Workday Board
   ↓ connector: read-only first
MissionControl Work Item Intake
   ↓ creates governed missions/runs
Hermes / Worker Runtime
   ↓ executes in envelopes with scoped tools
Verifier / Eval Layer
   ↓ writes receipts and closure evidence
MissionControl Factory Console
   ↓ operator sees throughput, blockers, risks, agent/team attribution
Jira Writeback
   ↓ gated update only after receipt + approval policy
```

## Implementation plan

### Phase 0 — Factory vocabulary and contracts

Goal: make Workday/Jira work items first-class in MissionControl.

Files likely touched:
- `packages/contracts/src/models.ts`
- `packages/contracts/src/enums.ts`
- `packages/contracts/src/events.ts`
- `packages/contracts/src/index.test.ts`
- generated contract outputs if the repo’s generation path requires it

Add models:
- `ExternalWorkItem`
  - `system`: `jira | linear | github | manual`
  - `external_id`, `external_key`, `url`
  - `hierarchy`: epic/story/task/subtask
  - `title`, `description`, `status`, `assignee`, `team`, `priority`
  - `acceptance_criteria`
  - `labels`, `components`, `sprint`, `updated_at`
- `FactoryMissionBinding`
  - links MissionControl `mission_id/run_id` to one or more external work items
- `FactoryThroughputMetric`
  - stories closed, tasks closed, retries, cycle time, blocked time, approval wait, verifier failures, cost estimate
- `ConnectorCapabilityScope`
  - `connector`, `scopes`, `secret_ref`, `allowed_operations`, `risk_level`
- `LoopPolicy`
  - `loop_type`: `turn_based | goal_based | time_based | proactive`
  - evaluator method, max attempts, budget, human approval thresholds

Acceptance criteria:
- TypeScript builds.
- Contract tests prove old missions/runs still work.
- New models do not require Jira credentials.

### Phase 1 — Jira intake adapter, read-only

Goal: ingest Jira board/epic/story/task data without writeback.

Files likely touched:
- new package: `packages/jira-connector` or `packages/work-item-connectors`
- `apps/orchestrator-api/src/index.ts`
- `packages/state-store` usage for local connector snapshots
- docs under `docs/architecture/` and `docs/plans/`

Build:
- Connector interface: `listBoards`, `listSprints`, `listWorkItems`, `getWorkItem`, `mapToExternalWorkItem`.
- Read-only Jira implementation using token from env/secret ref.
- Mock connector fixtures for local tests.
- Orchestrator endpoint: `POST /api/factory/intake/jira/dry-run`.
- Orchestrator endpoint: `POST /api/factory/intake/jira` to create candidate missions, behind operator auth.

Acceptance criteria:
- Dry run prints work item count and sample mapped items.
- No Jira writeback in this phase.
- Missing credentials produce a clear blocked state, not a crash.

### Phase 2 — Work item → MissionControl mission creation

Goal: turn selected Jira items into governed missions with context packets.

Files likely touched:
- `apps/orchestrator-api/src/index.ts`
- `packages/workflow-engine`
- `packages/policy-engine`
- `packages/contracts/src/models.ts`

Build:
- `POST /api/factory/work-items/:id/create-mission`
- Context packet generation:
  - Jira issue data
  - acceptance criteria
  - repo path / writable paths
  - linked docs
  - risk profile
  - required checks
- Policy defaults:
  - plan: read-only
  - implement: scoped writable paths
  - test: test commands only
  - review/writeback: approval-gated

Acceptance criteria:
- A mock Jira story creates a mission/run without touching real Jira.
- Envelope includes connector scopes and repo scopes.
- Mission detail read model displays the bound work item.

### Phase 3 — Factory dashboard

Goal: make throughput visible by team/member/agent, not hidden in logs.

Files likely touched:
- `apps/harness-console/src/App.tsx`
- `packages/ui-kit`
- `apps/orchestrator-api/src/index.ts`

Build:
- Add a `Factory` or `Workday Factory` tab.
- Read models:
  - `GET /api/read-models/factory/overview`
  - `GET /api/read-models/factory/work-items`
  - `GET /api/read-models/factory/throughput`
- Dashboard cards:
  - stories closed today
  - tasks closed today
  - active agent runs
  - blocked/awaiting approval
  - verifier failure rate
  - cycle time by team/member
  - cost/budget warnings
- Drill-down from metric → work item → run → receipt.

Acceptance criteria:
- UI works against fixture data with no Jira credentials.
- Metrics are derived from MissionControl receipts, not raw agent claims.

### Phase 4 — Goal-based loop execution

Goal: support the “agent keeps working until done is verified” loop safely.

Files likely touched:
- `packages/workflow-engine`
- `packages/eval-core`
- `packages/policy-engine`
- `apps/worker-runtime`
- `apps/orchestrator-api/src/index.ts`

Build:
- `LoopPolicy` support in run state.
- Evaluator receipt after each attempt.
- Retry only when:
  - max attempts not exceeded
  - budget not exceeded
  - failure is recoverable
  - approval policy allows it
- Store all attempts and receipts.

Acceptance criteria:
- A mock failing task retries until evaluator passes or budget stops it.
- Operator can see why a loop stopped.
- No proactive loop can write externally without approval.

### Phase 5 — Approval-gated Jira writeback

Goal: close the loop with Jira only after evidence exists.

Files likely touched:
- connector package
- `apps/orchestrator-api/src/index.ts`
- `packages/policy-engine`
- `apps/harness-console/src/App.tsx`

Build:
- Writeback plan artifact first:
  - intended Jira status transition
  - comment body
  - receipt links
  - risk classification
- Approval-gated endpoint: `POST /api/factory/work-items/:id/writeback`.
- Jira comment includes MissionControl receipt and verification summary.

Acceptance criteria:
- Dry-run writeback shows exact Jira mutation without executing.
- Real writeback requires operator approval.
- Failed writeback does not mark MissionControl run complete unless configured.

### Phase 6 — Hermes-side improvements after MissionControl proves the loop

Goal: improve Hermes without putting factory state in Hermes.

Hermes repo candidates:
- Add or improve a Workday/Jira factory skill.
- Add scoped connector/credential guidance to Hermes docs/security docs.
- Improve cron/Notes learning loop to route factory-relevant notes into MissionControl plan candidates.
- Add a context-packet/receipt-packet template skill for factory missions.

Do not do first:
- Do not move MissionControl state into Hermes memory.
- Do not give Hermes raw Jira credentials.
- Do not auto-close Jira tickets from a Hermes cron job.

## Recommended first slice

Start with Phase 0 + a fixture-only Phase 3 stub.

Why: It gives the team the vocabulary and operator surface before touching Jira credentials. It also flushes whether the data model supports the actual Workday operating question: “Who/which agent closed what, with what evidence, at what cost/risk?”

Concrete first PR:
1. Add contracts for `ExternalWorkItem`, `FactoryMissionBinding`, `FactoryThroughputMetric`, `ConnectorCapabilityScope`, and `LoopPolicy`.
2. Add fixture factory read model endpoint backed by local state/fixtures.
3. Add a Factory tab in console using fixture data.
4. Add tests for contract compatibility and read model shape.
5. Document Jira connector/writeback as explicit follow-on, not included.

Verification commands for first PR:

```bash
pnpm --filter @hermes-harness-with-missioncontrol/contracts build
pnpm --filter @hermes-harness-with-missioncontrol/contracts test
pnpm --filter orchestrator-api test
pnpm --filter harness-console typecheck
pnpm -r typecheck
git diff --check
```

## Deferred / not now

- PODMEME-style content stream: useful for briefings, not a factory blocker.
- Dan Koe articulation system: useful for leadership communication, not factory infra.
- Personal Obsidian vault automation: keep read-mostly; no broad write access.
- Production Jira writeback: only after read-only intake, fixtures, receipts, and approval gates are working.
- Raw credential forwarding from UI: acceptable only for prototype/local; must be removed before real Workday/Jira use.

## Decision needed

Approve MissionControl as the primary target repo for the Workday software factory.

If approved, the next action is to implement the first PR above on the current MissionControl branch or a clean feature branch from it.
