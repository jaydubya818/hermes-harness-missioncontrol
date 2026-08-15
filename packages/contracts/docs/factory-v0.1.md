# Factory v0.1 Contract Foundation

This package defines the first MissionControl-owned contracts for the SellerFi Safe Product Change Lane.

MissionControl owns these contracts because it is the control-plane source of truth for missions, runs, steps, approvals, events, artifacts, evaluations, outcomes, and reviewed learning proposals. Hermes may create or summarize work orders, Pi may consume and echo execution envelopes, GitHub may hold code and PR state, SellerFi may provide repository-local policy/checks, and Agentic-KB may receive reviewed learning. None of those systems should own a second factory lifecycle ledger.

## What Factory v0.1 includes

- Contract vocabulary for governed work intake, evidence, verification, outcomes, and learning proposals.
- Backward-compatible extensions to existing MissionControl execution/result/run contracts.
- Example objects that tell one coherent safe-lane story.
- A focused validation script for schema/example coherence and generated Python syntax.

## What Factory v0.1 does not include

This package does not implement:

- MissionControl lifecycle enforcement.
- Pi execution integration.
- GitHub issue, branch, comment, or PR automation.
- SellerFi lane policy enforcement.
- Automatic merge.
- Deployment.
- Automatic meta-loop modification of skills, policies, tests, or Agentic-KB.

## Authority boundaries

- Hermes: Jay-facing navigator/operator; may draft work orders and summarize approvals.
- MissionControl: authoritative contract, run, event, artifact, approval, outcome, and learning-proposal record.
- Pi: governed execution supervisor/runtime; consumes MissionControl envelopes and reports artifacts/results.
- GitHub: source of truth for code, branches, commits, pull requests, review comments, and merge state.
- SellerFi: repository-local implementation target with its own instructions, checks, and policy constraints.
- Agentic-KB: durable knowledge plane; receives reviewed learning after human/system acceptance.

## Contracts added

- `WorkOrder`: structured, policy-evaluable task intake.
- `RiskClassification`: lane risk level, domains, reversibility, and rationale.
- `SourceOfTruth`: explicit authoritative systems for task, code, review, execution state, artifacts, learning, and delivery.
- `ArtifactManifest`: aggregate artifact receipt for run outputs.
- `VerificationReceipt`: evidence-backed outer-loop verification mapped to checks and acceptance criteria.
- `OutcomeMetrics`: cycle time, attempts/retries, checks, PR status, approval burden, and defect/revert indicators. Time fields use `_ms` suffix and integer milliseconds.
- `LearningCandidate`: reviewed proposal for improving skills, tests, verifiers, policies, runbooks, repo instructions, or Agentic-KB patterns.
- `ApprovalDecision`: richer decision record with actor, rationale, and evidence refs.
- `FactoryEvent`: generated-client compatibility shape for factory event payloads; see decision below.

## Existing abstractions extended

- `ExecutionEnvelope` remains the runtime boundary and now optionally carries `work_order` and `source_of_truths`.
- `Run` can now carry `work_order_id`, `source_of_truths`, `outcome_metrics`, and `learning_candidates`.
- `TaskExecutionResult` can now include `artifact_manifest`, `verification_receipt`, `outcome_metrics`, and `learning_candidates`.
- `EventSource` now includes Hermes, MissionControl, Pi, worker, GitHub, and verifier sources.
- `CanonicalEventType` now includes work-order, policy-evaluation, verification, outcome, learning-candidate, GitHub PR, and manual-takeover event types.

## Source-of-truth semantics

Each `SourceOfTruth` identifies:

- `kind`: the responsibility area, such as task, code, review, execution state, artifacts, learning, or final delivery.
- `system`: the authoritative system name.
- `uri`: the stable location for that authority.
- `writeback_required`: whether the run must write results back to that system.
- `verification_required`: whether the run must verify that system before delivery.

This keeps MissionControl authoritative for run/audit state while preserving GitHub as code/PR truth and Agentic-KB as reviewed-learning truth.

## Acceptance-criterion verification

`WorkOrder.acceptance_criteria[].id` is the stable traceability key. `VerificationReceipt.acceptance_results[].acceptance_criterion_id` must reference those IDs and attach `evidence_refs` for each verified, failed, or unverified criterion.

`ArtifactManifest.artifacts[].uri` and receipt evidence refs use URI-shaped strings so future storage backends can resolve them without changing the contract shape.

## Outcome metrics

`OutcomeMetrics` is intentionally explicit rather than a loose map. It captures:

- elapsed time fields in integer milliseconds via `_ms` suffixes,
- worker attempts/retries,
- human review burden,
- check and verifier outcomes,
- acceptance-criterion coverage,
- PR creation/merge state,
- reverts and escaped defects,
- cost by model or worker.

The primary interpretation is accepted, verified value per unit of human attention, not raw PR count.

## Learning-candidate boundaries

`LearningCandidate` is a proposal, not an automatic mutation. In v0.1, learning candidates may recommend a skill, deterministic test, static rule, verifier, policy, runbook, repository instruction, Agentic-KB pattern, exception, or no-action decision. They must remain reviewable artifacts and must not automatically alter factory controls.

## FactoryEvent decision

Decision: preserve one authoritative event system and represent factory activity through existing `EventEnvelope` / `CanonicalEventType` semantics.

TypeScript exports `FactoryEvent<T>` as an alias-compatible event type. The OpenAPI schema includes a dedicated `FactoryEvent` object with the same envelope fields because the current generated-client path handles concrete objects more reliably than `allOf` aliasing. This is not a separate ledger and should not become one. Future migration path: once generated clients support aliases/wrappers cleanly, collapse the OpenAPI `FactoryEvent` schema back onto `EventEnvelope` without changing runtime semantics.

## Compatibility and migration

The new fields on existing contracts are optional. Existing consumers of `ExecutionEnvelope`, `Run`, and `TaskExecutionResult` can ignore the Factory v0.1 fields until they adopt the lane. Generated TypeScript and Python artifacts are regenerated from `schema/openapi.yaml`; do not hand-edit generated outputs.

## Examples

- `examples/factory-v0.1-work-order.json`
- `examples/factory-v0.1-artifact-manifest.json`
- `examples/factory-v0.1-verification-receipt.json`
- `examples/factory-v0.1-outcome-metrics.json`
- `examples/factory-v0.1-learning-candidate.json`

These are non-production fixtures. They do not imply merge, deployment, or production approval.

## Validation

Run:

```bash
pnpm --filter @hermes-harness-with-missioncontrol/contracts generate
pnpm --filter @hermes-harness-with-missioncontrol/contracts validate:factory
pnpm --filter @hermes-harness-with-missioncontrol/contracts typecheck
pnpm --filter @hermes-harness-with-missioncontrol/contracts test
pnpm --filter @hermes-harness-with-missioncontrol/contracts build
python3 -m py_compile packages/contracts/generated/python_models.py
```

`validate:factory` parses OpenAPI YAML, validates Factory example JSON against the intended schema subset, checks cross-example ID/evidence coherence, and syntax-checks generated Python models.

## Known limitations

- Runtime Python object validation depends on `pydantic`; this repository does not currently declare a dedicated Python environment for that validation path. The contract package therefore keeps generated Python syntax validation via `py_compile` as the minimum check.
- SellerFi policy enforcement, GitHub writeback idempotency, and Pi runtime consumption are intentionally deferred to later PRs.

## Intended next PR

Next: MissionControl lifecycle integration and event recording for WorkOrder intake and verification states. Do not start Pi integration, GitHub writeback, SellerFi lane policy enforcement, automatic merge, deployment, or automated learning mutation until the lifecycle slice is reviewed.
