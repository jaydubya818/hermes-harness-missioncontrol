# Agentic Engineering Operating Model Crosswalk

Date: 2026-07-10
Source synthesis: `/Users/jaywest/Agentic-KB/wiki/syntheses/synthesis-agentic-engineering-operating-model.md`

## Verdict

MissionControl is mostly aligned with the new operating model.

The repo already has the right core split:

- MissionControl governs.
- Hermes thinks.
- Contracts, not imports, define the boundary.
- MissionControl is the system of record for missions, runs, steps, approvals, artifacts, audit/events, and operator-visible status.

That is the correct “agent as UI / system of record as backend” shape.

## Alignment scorecard

| Principle | Current state | Status |
|---|---|---|
| One visible orchestrator / many backend lanes | MissionControl provides console + conductor; Hermes remains reasoning runtime | Strong |
| Artifact-native completion | Artifacts and audit persistence are first-class; duplicate artifact protection exists | Strong |
| System of record clarity | README explicitly names MissionControl as source of truth for run/step/artifact/audit state | Strong |
| Permissioned context/tools | Governed execution envelope covers worktree, tools/actions, writable paths, timeout, budget, approval mode | Strong |
| Human approval boundary | Approval queues/history and lifecycle normalization exist | Strong |
| Verification receipts | Eval records, event taxonomy, artifact read models exist | Good |
| Outcome metrics beyond activity | Eval summaries exist, but business/operator outcome metric vocabulary is not explicit | Gap |
| Agent navigator/driver framing | Implied by govern/think split, not yet named in operator docs | Gap |
| Learning loop into skills/KB | Memory API and Agentic-KB writeback exist; process-level learning loop is not prominent in the core docs | Gap |

## Recommended repo changes

### 1. Add explicit outcome metric fields to run/eval summaries

Do not stop at tool calls, token use, sessions, or event counts.

Add or document a metric ladder:

```text
activity -> artifact -> quality -> flow -> outcome
```

Candidate fields:

```ts
type OutcomeMetric = {
  kind: 'cycle_time' | 'review_burden' | 'defect_rate' | 'handoff_removed' | 'business_outcome' | 'operator_time_saved';
  baseline?: string;
  observed?: string;
  evidence_uri?: string;
  confidence: 'low' | 'medium' | 'high';
};
```

### 2. Add navigator/driver language to operator-facing docs

Suggested wording:

> The operator/Hermes layer acts as navigator: intent, constraints, acceptance criteria, and review. MissionControl lanes act as drivers: execute inside governed envelopes and produce artifacts with receipts.

This prevents MissionControl from being perceived as “another bot” instead of the governed execution substrate.

### 3. Add `source_of_truth` to mission/step templates

Every mission should declare where final truth belongs:

```yaml
source_of_truth:
  kind: github | taskmaster | agentic_kb | cron | docs | external_system
  uri: string
  artifact_required: true
```

This operationalizes “agent as UI, backend as truth.”

### 4. Make learning writeback explicit

At run close, distinguish:

- task artifact;
- verification artifact;
- durable learning candidate;
- no-learning-needed reason.

Do not auto-mutate skills or canonical docs without review, but capture candidates so learning does not die in chat.

## No immediate code change made here

This file is a crosswalk/audit artifact. The highest-value next implementation slice is contract/schema work around outcome metrics and `source_of_truth`, not another broad architecture rewrite.
