# Factory v0.1 Current-State Architecture and Gap Assessment

Date: 2026-07-10

## Decision

Build the first production software-factory lane by extending the existing Hermes + MissionControl + Agentic Pi Harness + GitHub + Agentic-KB architecture. Do not create a second orchestrator or a new framework.

Authority boundaries:

- Hermes remains the Jay-facing navigator and operator.
- MissionControl remains the authoritative control plane and system of record for missions, runs, steps, approvals, artifacts, events, evaluations, outcomes, and learning candidates.
- Agentic Pi Harness remains the governed execution supervisor/runtime lane.
- Worker agents perform bounded implementation and review work.
- GitHub remains source of truth for code, branches, pull requests, review comments, and merge state.
- Agentic-KB remains the durable knowledge and learning plane.
- Repository-local skills, instructions, tests, and verifiers stay versioned with the repository they govern.

## Repositories inspected

- `~/.hermes/hermes-agent`
- `~/hermes-harness-missioncontrol`
- `~/Agentic-Pi-Harness`
- `~/Agentic-KB`
- `~/projects/SellerFi`

## Current architecture discovered

### Hermes Agent

Hermes is already the right Jay-facing surface. It has memory, skills, cron jobs, tools, delegation, browser/terminal/file access, and can coordinate across local repositories. Hermes core guidance explicitly says capability should live at the edges through skills, plugins, services, and CLI commands rather than widening the core model-tool surface. Factory v0.1 should therefore use Hermes as navigator/coordinator, not modify Hermes core.

### MissionControl

MissionControl already contains the right control-plane foundation:

- `packages/contracts/schema/openapi.yaml` is the schema source of truth.
- `packages/contracts/src/models.ts`, `events.ts`, `enums.ts`, and generated OpenAPI/Python models expose typed contracts.
- Existing domain concepts: `Mission`, `Run`, `Step`, `ArtifactRef`, `ApprovalRequest`, `ApprovalResult`, `ExecutionEnvelope`, `StepExecutionRequest`, `TaskExecutionResult`, `EventEnvelope`.
- Existing lifecycle states cover the first execution core: pending/running/awaiting approval/paused/failed/completed/cancelled for mission/run and pending/ready/running/blocked/awaiting approval/paused/failed/completed/cancelled for steps.
- `apps/orchestrator-api` persists missions, runs, approvals, events, audit, and processed event IDs.
- `packages/workflow-engine` owns step transitions and derives run approval visibility from the current awaiting-approval step.
- `packages/policy-engine` has basic approval and policy decisions.
- `packages/eval-core` records eval records and summaries.
- `apps/worker-runtime` already validates execution envelopes, creates git worktrees, applies allowed path/tool/action constraints, captures artifacts/events, and can run deterministic or LLM-backed implementation.

Overlap with requested factory model:

- `ExecutionEnvelope` already exists.
- `ArtifactRef` exists but not a full `ArtifactManifest`.
- `ApprovalRequest`/`ApprovalResult` exist but not a richer `ApprovalDecision` contract.
- `EventEnvelope` is the existing `FactoryEvent` equivalent.
- Eval records exist but do not yet capture the requested outcome metrics.
- Learning writeback exists conceptually in memory-plane work, but no first-class `LearningCandidate` contract exists in MissionControl.
- No first-class `WorkOrder`, `SourceOfTruth`, `VerificationReceipt`, or SellerFi lane policy contract exists yet.

### Agentic Pi Harness

Pi already has strong governed-runtime primitives:

- `src/hermes/contractV2.ts` defines `PiHermesTaskEnvelopeV2`, `PiHermesResultEnvelopeV2`, artifact expected/manifest item schemas, structured events, run states, failure classes, state-transition validation, and artifact manifest hashing.
- `src/subagents/worktree.ts` creates short-lived git worktrees and guards path escape.
- `src/hermes/httpBridge.ts` supports Contract V2 runs and finalization.
- `src/approvals/runtime.ts` has approval packets/responses/decisions.
- Pi has trace/effect/provenance/policy schemas and replay/verification CLIs.

Overlap with requested factory model:

- Pi already supports artifact manifests and runtime envelopes in its own vocabulary.
- Pi has worktree isolation.
- Pi has approval runtime and policy/effect/provenance capture.
- Pi does not yet carry MissionControl's `WorkOrder`, `SourceOfTruth`, `OutcomeMetrics`, or `LearningCandidate` vocabulary as first-class fields in Contract V2.

Boundary risk:

- Pi is technically capable enough to drift into a second orchestrator. Factory docs and contracts must preserve Pi as execution supervisor only. MissionControl owns lifecycle truth; Hermes owns Jay-facing interpretation and approval requests.

### GitHub

GitHub is configured as the code source of truth in the local repos. MissionControl worker-runtime can create branches/worktrees, but Factory v0.1 still needs a narrower GitHub pull-request writeback contract and idempotency policy so retries do not create duplicate branches, PRs, or comments.

### Agentic-KB

Agentic-KB already contains the durable learning plane and recent syntheses:

- Agentic engineering operating model.
- Navigator/driver agentic coding pattern.
- Agent-as-UI/system-of-record-backend pattern.
- Outcome metrics for agent adoption pattern.

Factory v0.1 should write learning candidates to MissionControl first, then promote reviewed patterns/skills/runbooks into Agentic-KB. The meta-loop must not directly modify factory controls in v0.1.

### SellerFi

SellerFi has strong repository-local instructions:

- Next.js 16, TypeScript strict, Prisma 6.19, NextAuth v5, Stripe, Tailwind/shadcn/Radix.
- Critical restrictions: no Prisma schema changes without permission, no new packages without asking, no secrets, no skipped TypeScript errors, docs under `docs/`, read `progress.txt`.
- Existing commands: `npm run lint`, `npm run type-check`, `npm run test:run`, `npm run test:e2e`, `npm run build`, `npm run validate:prod`, `npm run test:security`.

SellerFi is suitable for a first safe lane only if the lane explicitly excludes auth, authorization, Stripe/payments, database migrations/schema changes, infra/IAM/secrets, production deployment, sensitive data, legal/financial claims, and architectural redesign.

## First meaningful gaps

1. MissionControl does not yet have a first-class `WorkOrder` contract.
2. Source-of-truth declarations are not explicit per governed run.
3. Outcome metrics are too coarse; eval records optimize around run outcome/cost/artifact/approval count, not accepted verified value per human attention.
4. Learning candidates are not first-class MissionControl records.
5. Verification receipts do not yet map evidence to individual acceptance criteria.
6. SellerFi lane eligibility is not encoded as a policy contract.
7. PR writeback and GitHub idempotency are not first-class yet.
8. Pi Contract V2 needs to carry or reference the MissionControl work order/source-of-truth/outcome/learning vocabulary instead of inventing a parallel factory vocabulary.

## Target design for Factory v0.1

The minimum lane should be:

1. Hermes creates or validates a structured Work Order.
2. MissionControl records the Work Order, evaluates SellerFi lane eligibility, creates a run, tracks lifecycle, records events, enforces approvals, and aggregates outcome metrics.
3. Pi receives an Execution Envelope and Work Order reference, creates an isolated worktree/branch, supervises worker execution, captures traces/effects/artifacts, and reports results.
4. Worker implements the bounded change, runs inner-loop checks, inspects its diff, and returns an Artifact Manifest.
5. GitHub receives one pull request with MissionControl run reference, acceptance criteria, evidence, risk classification, checks, and rollback instructions.
6. An independent outer-loop verifier produces one Verification Receipt mapping evidence to each acceptance criterion and required check.
7. Human approval is recorded before merge.
8. Outcome metrics and any Learning Candidate are stored in MissionControl.
9. Reviewed learning candidates may later produce skills, tests, verifiers, policies, repo instructions, runbooks, or Agentic-KB patterns.

## Contract-first implementation slice

The first PR should extend MissionControl contracts, because MissionControl is the control-plane source of truth. Reuse existing concepts where possible:

- Keep `ExecutionEnvelope`; extend it rather than replacing it.
- Keep `ArtifactRef`; add `ArtifactManifest` as the aggregate receipt around refs/evidence.
- Keep `ApprovalRequest`/`ApprovalResult`; add `ApprovalDecision` as the richer decision record.
- Keep `EventEnvelope`; expose `FactoryEvent` as the factory alias/typed event envelope.
- Add first-class `WorkOrder`, `RiskClassification`, `SourceOfTruth`, `VerificationReceipt`, `OutcomeMetrics`, and `LearningCandidate`.

OpenAPI remains the source of truth. Generated TypeScript/Python artifacts must be regenerated after schema changes.

## State-transition design

Existing lifecycle states are sufficient for the first contract PR, but later MissionControl integration should map the requested lifecycle into existing/extended states:

- draft/triaged/ready -> mission/work-order intake states
- policy evaluation -> `policy.evaluated` event and run/step pending/ready states
- approval required -> `awaiting_approval`
- queued/running/blocked/failed/cancelled -> existing run/step states
- output ready/verifying/rework required/human review required/verified/approved/delivered/observed/closed -> later lane-specific step states/events or derived read-model phases

Every transition must emit an attributable event and be idempotent by `event_id`/`processed_event_ids`.

## SellerFi lane eligibility policy

Initially eligible:

- One repository: `SellerFi`
- Existing architectural pattern
- Low-risk UI change
- Copy change
- Form validation
- Accessibility fix
- Test addition
- Logging improvement
- Non-sensitive admin UI
- Seed/demo data improvement
- Narrow behavior-preserving refactor
- Testable acceptance criteria
- Reversible by normal Git revert
- Human approval before merge

Initially ineligible:

- Payment or Stripe behavior
- Authentication
- Authorization
- Ownership enforcement
- Database migrations or Prisma schema changes
- Major schema changes
- Infrastructure/IAM/secrets
- Destructive operations
- New external integrations
- Sensitive personal data
- Legal or financial claims
- Production deployment
- Major architectural redesign

## Material architectural decisions

1. Extend MissionControl first; do not start by modifying Hermes core.
2. Preserve Pi as runtime supervisor; Pi consumes/echoes MissionControl contract vocabulary rather than defining the factory lifecycle.
3. Use GitHub as code/PR truth and MissionControl as run/audit/eval/learning truth.
4. Store learning candidates as proposals only in v0.1; no automatic factory-control modification.
5. Prefer deterministic verifiers and existing repo checks before LLM review.
