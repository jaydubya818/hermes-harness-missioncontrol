# Harness Console Surface Map

Goal: define exactly what to keep, adapt, borrow, and cut when turning MissionControl into the operator console for the agentic software-development harness.

## Decision Summary

Use MissionControl as the base shell and execution console.
Use Hermes HUD UI patterns to simplify the dashboard and make the console faster to scan.
Do not ship broad org/comms/CRM/office surfaces in v1.

## Top-Level v1 Navigation

1. Overview
2. Missions
3. Agents
4. Memory
5. Code
6. Audit
7. Settings

## Keep from MissionControl

### App Shell and Navigation
Keep:
- apps/mission-control-ui/src/App.tsx
- apps/mission-control-ui/src/components/CommandNav.tsx
- apps/mission-control-ui/src/components/TabBar.tsx
- apps/mission-control-ui/src/components/AppTopBar.tsx
- apps/mission-control-ui/src/components/AppSideNav.tsx
- apps/mission-control-ui/src/components/PageHeader.tsx
- apps/mission-control-ui/src/components/ui/*
- apps/mission-control-ui/src/lib/utils.ts

Reason:
- strong operator shell already exists
- sections and tabs map well to a narrower harness console
- command-oriented IA is already present

### Missions / Operations
Keep:
- Kanban.tsx
- KanbanFilters.tsx
- TaskDrawer.tsx
- TaskDrawerTabs.tsx
- TaskComments.tsx
- components/TaskboardStats.tsx
- GoalsView.tsx
- MissionDAGView.tsx
- WorkflowDashboard.tsx
- WorkflowRunPanel.tsx
- WorkflowSelector.tsx
- LiveFeed.tsx
- ApprovalsModal.tsx
- PolicyModal.tsx
- OperatorControlsModal.tsx
- NotificationsModal.tsx
- AuditView.tsx
- TelemetryView.tsx

Use as:
- mission queue
- run graph
- step progress
- approval queue
- runtime event stream
- operator controls
- audit ledger
- runtime telemetry

### Code / Runtime
Keep:
- CodePipelineView.tsx
- ExecutionView.tsx
- DeploymentsView.tsx
- PeerReviewPanel.tsx
- RecorderView.tsx
- MetricsView.tsx
- LoopDetectionPanel.tsx
- FlakyStepsView.tsx
- TestGenerationView.tsx

Use as:
- patch/test/review/deploy surface
- artifact replay
- run diagnostics
- failure analysis
- deployment control

### Agent / Policy / Search
Keep:
- AgentRegistryView.tsx
- AgentDetailFlyout.tsx
- AgentsFlyout.tsx
- PoliciesView.tsx
- MemoryView.tsx
- SkillsView.tsx
- SearchBar.tsx
- DocsView.tsx
- GatewaySettingsView.tsx

Use as:
- agent runtime registry
- per-agent status and context preview
- memory plane surface
- KB browser surface
- guardrail configuration
- cross-plane search

## Keep but Refactor Hard

### MemoryView.tsx
Current coupling:
- Convex agentDocuments and agentLearning tables

Refactor target:
- Agentic-KB-backed memory plane view
- tabs for Profile / Hot / Working / Learned / Rewrites / Promotions / Context Trace

### DocsView.tsx
Refactor target:
- embedded Agentic-KB article browser
- standards, recipes, project docs, postmortems, ADRs

### SearchBar.tsx
Refactor target:
- federated search over missions, runs, agents, memory, standards, incidents, deploys

### GatewaySettingsView.tsx and lib/gatewayClient.ts
Refactor target:
- runtime connectivity panel for orchestrator, event bus, queue, memory plane, evaluator
- remove OpenClaw-specific assumptions from UI contract

### PeerReviewPanel.tsx
Refactor target:
- review findings + policy violations + test failures + memory-based standards hints

### CodePipelineView.tsx and ExecutionView.tsx
Refactor target:
- execution DAG + artifact lineage + confidence + risk + cost + rollback state

## Borrow from Hermes HUD UI

### UX Patterns to Import
- panel-based dashboard cards
- compact top bar with keyboard hints
- command palette interaction model
- SWR-style read-only polling for non-critical surfaces
- capacity bars and lightweight sparklines
- cost panels by model/run/day
- active agents panel with simple, dense status lines

### Best Donor Files
Borrow concepts from:
- frontend/src/components/Panel.tsx
- frontend/src/components/DashboardPanel.tsx
- frontend/src/components/MemoryPanel.tsx
- frontend/src/components/TokenCostsPanel.tsx
- frontend/src/components/AgentsPanel.tsx
- frontend/src/components/CommandPalette.tsx
- frontend/src/components/TopBar.tsx
- frontend/src/hooks/useApi.ts

### Specific Console Improvements
- Overview should become a HUD-like wall of operational panels, not a dense enterprise dashboard
- Cost should be first-class: cost per mission, run, stage, agent, day
- Memory health should show capacity, pending rewrites, promotion backlog, stale standards
- Command palette should jump directly to missions, agents, context bundles, deployments, rewrites, incidents

## Cut from v1

Remove from initial scope:
- CrmView.tsx
- MeetingsView.tsx
- OfficeView.tsx
- LiveOfficeView.tsx
- HiringView.tsx
- PeopleView.tsx
- OrgView.tsx
- TelegraphInbox.tsx
- VoicePanel.tsx
- CalendarView.tsx
- TeamView.tsx
- IdentityDirectoryView.tsx
- ContentPipelineView.tsx
- CapturesView.tsx
- DesignSystemView.tsx
- ApiImportView.tsx
- GherkinStudioView.tsx
- HybridWorkflowView.tsx
- RadarView.tsx
- FactoryView.tsx
- FeedbackView.tsx
- all QC-specific dashboards/modals/views
- Add/Edit person modals
- mission suggestion/discovery surfaces not tied to execution

Reason:
- weak relevance to first product wedge
- increases UI and backend complexity without improving autonomous software delivery

## v1 Screens

### 1. Overview
Panels:
- active missions
- pending approvals
- failed steps in last 24h
- deployment state
- memory health
- top agents by throughput
- cost today / this week
- recent promoted learnings

### 2. Missions
- queue / kanban
- mission DAG
- task drawer with artifacts, comments, approvals, policy decisions
- run history

### 3. Agents
- registry
- status
- assigned run
- last context bundle
- recent writebacks
- eval score trend

### 4. Memory
- agent memory classes
- project standards
- learned patterns
- rewrite queue
- promotion log
- context load traces

### 5. Code
- diffs
- tests
- review findings
- deployment history
- execution trace and terminal artifacts

### 6. Audit
- unified ledger for mission actions, approvals, policy decisions, memory writes, promotions, deploys, rollbacks

### 7. Settings
- policies
- integrations
- runtime config
- model/router config
- cost budgets

## Final UI Positioning

MissionControl provides the operator shell.
Hermes HUD UI provides the ergonomic dashboard language.
The result should feel like:
- a command center, not a project-management tool
- a runtime cockpit, not a CRM
- a memory-aware engineering control plane, not a generic AI agent portal
