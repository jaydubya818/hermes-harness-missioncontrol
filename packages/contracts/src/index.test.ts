import { describe, expect, it } from "vitest";
import {
  ApprovalMode,
  FinalOutcome,
  LearningOutputType,
  LearningTrigger,
  RiskDomain,
  RiskLevel,
  SourceOfTruthKind,
  StepKind,
  StepState,
  VerificationMethod,
  type AcceptanceCriterion,
  type ApprovalDecision,
  type ApprovalRequest,
  type ArtifactManifest,
  type ArtifactRef,
  type EventEnvelope,
  type ExecutionEnvelope,
  type FactoryEvent,
  type LearningCandidate,
  type Mission,
  type OutcomeMetrics,
  type Run,
  type SourceOfTruth,
  type Step,
  type StepExecutionRequest,
  type TaskExecutionResult,
  type VerificationReceipt,
  type WorkOrder,
} from "./index.js";

describe("contracts package exports", () => {
  it("exports canonical enums", () => {
    expect(StepKind.Implement).toBe("implement");
    expect(StepState.Running).toBe("running");
    expect(ApprovalMode.OnPolicyTrigger).toBe("on_policy_trigger");
    expect(FinalOutcome.Success).toBe("success");
    expect(RiskLevel.Low).toBe("low");
    expect(RiskDomain.Ui).toBe("ui");
    expect(VerificationMethod.Typecheck).toBe("typecheck");
    expect(SourceOfTruthKind.Code).toBe("code");
    expect(LearningTrigger.FailedVerifier).toBe("failed_verifier");
    expect(LearningOutputType.NewVerifier).toBe("new_verifier");
  });

  it("supports canonical contract shapes", () => {
    const artifact: ArtifactRef = {
      artifact_id: "art_123",
      kind: "patch",
      uri: "artifact://run_123/patch.diff",
      label: "Implementation diff",
    };

    const result: TaskExecutionResult = {
      execution_id: "exec_123",
      mission_id: "mis_123",
      run_id: "run_123",
      step_id: "step_123",
      final_outcome: FinalOutcome.Success,
      summary: "Implemented governed async start flow",
      artifacts: [artifact],
      changed_files: ["apps/orchestrator-api/src/index.ts"],
      issues: [],
      approval_needed: false,
      recommended_next_step: StepKind.Test,
    };

    const approval: ApprovalRequest = {
      approval_id: "approval_123",
      mission_id: "mis_123",
      run_id: "run_123",
      step_id: "step_123",
      reason: "deploy requires approval",
      decision_scope: "step",
      requested_at: "2026-04-18T18:00:00Z",
    };

    const envelope: ExecutionEnvelope = {
      worktree_path: "/repo/.worktrees/run_123",
      workspace_root: "/repo",
      repo_scope: {
        root_path: "/repo",
        writable_paths: [".hermes-harness", "apps/orchestrator-api/src"]
      },
      allowed_tools: ["filesystem", "git", "process"],
      allowed_actions: ["plan", "read_repo", "write_repo"],
      approval_mode: ApprovalMode.OnPolicyTrigger,
      timeout_seconds: 1800,
      resource_budget: {
        token_budget: 120000,
        max_artifacts: 10,
        max_output_bytes: 1048576
      },
      output_dir: "/repo/.hermes-harness/runs/run_123/step_123",
      environment_classification: "sandbox"
    };

    const event: EventEnvelope<{ result: TaskExecutionResult }> = {
      schema_version: "v1",
      event_id: "evt_123",
      timestamp: "2026-04-18T18:00:00Z",
      sequence: 1,
      source: "hermes",
      type: "step.completed",
      mission_id: "mis_123",
      run_id: "run_123",
      step_id: "step_123",
      execution_id: "exec_123",
      payload: { result },
    };

    const mission: Mission = {
      mission_id: "mis_123",
      title: "Implement contracts package",
      objective: "Adopt mission contract",
      workflow: "implementation",
      project_id: "proj_demo",
      profile_ref: "profile://hermes/default",
      repo_path: "/repo",
      workspace_root: "/repo/.worktrees/run_123",
      status: "running",
      active_run_id: "run_123",
      summary: "Mission in progress",
      created_at: "2026-04-18T18:00:00Z",
      updated_at: "2026-04-18T18:00:00Z",
    };

    const step: Step = {
      step_id: "step_123",
      kind: StepKind.Implement,
      title: "Implement package",
      state: StepState.Running,
      approval_mode: ApprovalMode.OnPolicyTrigger,
      risk: "medium",
      execution_id: "exec_123",
      artifacts: [artifact],
      started_at: "2026-04-18T18:00:00Z",
    };

    const run: Run = {
      run_id: "run_123",
      mission_id: mission.mission_id,
      status: "running",
      current_step_id: step.step_id,
      started_at: "2026-04-18T18:00:00Z",
      summary: "Run in progress",
      created_at: "2026-04-18T18:00:00Z",
      updated_at: "2026-04-18T18:00:00Z",
    };

    const stepRequest: StepExecutionRequest = {
      mission_id: mission.mission_id,
      run_id: run.run_id,
      step_id: step.step_id,
      execution_id: result.execution_id,
      kind: StepKind.Implement,
      repo_path: mission.repo_path,
      branch_name: "hermes/run_123",
      envelope
    };

    expect(event.payload.result.artifacts[0]).toEqual(artifact);
    expect(approval.reason).toContain("approval");
    expect(run.current_step_id).toBe(step.step_id);
    expect(stepRequest.envelope.output_dir).toContain("step_123");
  });

  it("supports Factory v0.1 work-order, evidence, outcome, and learning contracts", () => {
    const acceptanceCriterion: AcceptanceCriterion = {
      id: "AC-1",
      statement: "The SellerFi copy-only change is visible in the existing UI surface.",
      verification_method: VerificationMethod.IndependentReview,
      evidence_required: true,
      expected_evidence: ["diff", "review-note"],
    };

    const sourceOfTruths: SourceOfTruth[] = [
      {
        kind: SourceOfTruthKind.Task,
        system: "missioncontrol",
        uri: "missioncontrol://work-orders/wo_sellerfi_copy_001",
        writeback_required: true,
        verification_required: true,
      },
      {
        kind: SourceOfTruthKind.Code,
        system: "github",
        uri: "https://github.com/jaydubya818/SellerFi",
        writeback_required: true,
        verification_required: true,
      },
      {
        kind: SourceOfTruthKind.Learning,
        system: "agentic-kb",
        uri: "file:///Users/jaywest/Agentic-KB/wiki",
        writeback_required: false,
        verification_required: true,
      },
    ];

    const workOrder: WorkOrder = {
      schema_version: "factory.work_order.v0.1",
      work_order_id: "wo_sellerfi_copy_001",
      title: "Clarify SellerFi marketplace intro copy",
      goal: "Make a low-risk copy-only improvement to a SellerFi UI surface.",
      problem_statement: "Existing intro copy is vague for sellers.",
      desired_outcome: "Sellers understand the next action without changing product behavior.",
      repository: {
        name: "SellerFi",
        path: "/Users/jaywest/projects/SellerFi",
        remote: "https://github.com/jaydubya818/SellerFi.git",
        default_branch: "main",
      },
      base_ref: "main",
      acceptance_criteria: [acceptanceCriterion],
      allowed_paths: ["app/**", "components/**", "docs/**"],
      restricted_paths: ["prisma/**", "lib/auth/**", "lib/stripe/**", ".env*"],
      risk_classification: {
        level: RiskLevel.Low,
        domains: [RiskDomain.Copy, RiskDomain.Ui],
        rationale: "Copy-only UI change, reversible by git revert, human approval required before merge.",
        reversible: true,
        requires_human_approval: true,
      },
      required_human_approvals: ["merge"],
      worker_profile: "sellerfi-safe-product-change",
      max_attempts: 2,
      max_runtime_seconds: 1800,
      max_cost_usd: 2,
      network_policy: "restricted",
      required_checks: ["restricted-paths", "lint", "type-check", "independent-review"],
      expected_artifacts: ["implementation-plan", "patch-diff", "artifact-manifest", "verification-receipt"],
      source_of_truths: sourceOfTruths,
      delivery_target: "github_pull_request",
      auto_merge_eligible: false,
      initiator: "hermes",
      created_at: "2026-07-10T18:00:00Z",
      amendments: [],
    };

    const artifactRef: ArtifactRef = {
      artifact_id: "art_diff_001",
      kind: "diff",
      uri: "artifact://run_factory_001/patch.diff",
      label: "Patch diff",
    };

    const artifactManifest: ArtifactManifest = {
      manifest_id: "manifest_factory_001",
      mission_id: "mis_factory_001",
      run_id: "run_factory_001",
      execution_id: "exec_factory_001",
      work_order_id: workOrder.work_order_id,
      generated_at: "2026-07-10T18:10:00Z",
      produced_by: "pi-worker-runtime",
      artifacts: [artifactRef],
      trace_refs: ["trace://run_factory_001/events.ndjson"],
      completeness: "complete",
    };

    const verificationReceipt: VerificationReceipt = {
      receipt_id: "vr_factory_001",
      mission_id: "mis_factory_001",
      run_id: "run_factory_001",
      work_order_id: workOrder.work_order_id,
      generated_at: "2026-07-10T18:12:00Z",
      verifier_id: "outer-loop-reviewer",
      overall_status: "passed",
      check_results: [
        { check_id: "restricted-paths", status: "passed", evidence_refs: ["artifact://run_factory_001/changed-files.txt"] },
        { check_id: "type-check", status: "passed", evidence_refs: ["terminal://npm-run-type-check"] },
      ],
      acceptance_results: [
        {
          acceptance_criterion_id: "AC-1",
          status: "verified",
          method: VerificationMethod.IndependentReview,
          evidence_refs: [artifactRef.uri],
        },
      ],
      evidence_refs: [artifactRef.uri, "terminal://npm-run-type-check"],
      limitations: ["No production deployment or merge performed."],
    };

    const outcomeMetrics: OutcomeMetrics = {
      mission_id: "mis_factory_001",
      run_id: "run_factory_001",
      work_order_id: workOrder.work_order_id,
      generated_at: "2026-07-10T18:15:00Z",
      primary_outcome: "accepted_verified_value_per_unit_human_attention",
      total_cycle_time_ms: 900000,
      queue_time_ms: 10000,
      execution_time_ms: 600000,
      verification_time_ms: 180000,
      human_approval_time_ms: 110000,
      worker_attempts: 1,
      worker_retries: 0,
      human_review_comment_count: 0,
      human_takeover_required: false,
      checks_passed: 2,
      checks_failed: 0,
      verifier_failures: 0,
      acceptance_criteria_verified: 1,
      acceptance_criteria_total: 1,
      cost_by_model_or_worker: { "worker-runtime": 0 },
      pull_request_created: true,
      pull_request_merged: false,
      reverted: false,
      escaped_defect: false,
    };

    const learningCandidate: LearningCandidate = {
      learning_candidate_id: "learn_factory_001",
      mission_id: "mis_factory_001",
      run_id: "run_factory_001",
      work_order_id: workOrder.work_order_id,
      trigger: LearningTrigger.FailedVerifier,
      observation: "A simulated verifier failure showed that allowed-path evidence should be attached to every safe lane PR.",
      category: "verifier-evidence",
      evidence_refs: ["artifact://run_factory_001/verification.json"],
      frequency: 1,
      impact: "medium",
      confidence: "high",
      recommended_action: "Add or update a deterministic allowed-path verifier in the SellerFi repository.",
      target: "SellerFi",
      proposed_output_type: LearningOutputType.NewVerifier,
      status: "proposed",
      created_at: "2026-07-10T18:16:00Z",
    };

    const approvalDecision: ApprovalDecision = {
      approval_id: "approval_factory_001",
      decision: "approved",
      resolved_at: "2026-07-10T18:14:00Z",
      resolved_by: "jay",
      actor: "human",
      decision_rationale: "Low-risk copy change with verifier evidence attached.",
      evidence_refs: [verificationReceipt.receipt_id],
    };

    const run: Run = {
      run_id: "run_factory_001",
      mission_id: "mis_factory_001",
      status: "completed",
      work_order_id: workOrder.work_order_id,
      source_of_truths: sourceOfTruths,
      outcome_metrics: outcomeMetrics,
      learning_candidates: [learningCandidate],
      created_at: "2026-07-10T18:00:00Z",
      updated_at: "2026-07-10T18:16:00Z",
    };

    const executionEnvelope: ExecutionEnvelope = {
      worktree_path: "/Users/jaywest/hermes-harness-missioncontrol/data/worktrees/run_factory_001",
      workspace_root: workOrder.repository.path,
      repo_scope: {
        root_path: workOrder.repository.path,
        writable_paths: workOrder.allowed_paths,
      },
      allowed_tools: ["filesystem", "git", "process"],
      allowed_actions: ["plan", "read_repo", "write_repo", "test"],
      approval_mode: ApprovalMode.OnPolicyTrigger,
      timeout_seconds: workOrder.max_runtime_seconds,
      resource_budget: {
        token_budget: 120000,
        max_artifacts: 20,
        max_output_bytes: 1048576,
      },
      output_dir: "/Users/jaywest/hermes-harness-missioncontrol/data/worker-runs/run_factory_001",
      environment_classification: "sandbox",
      work_order: workOrder,
      source_of_truths: sourceOfTruths,
    };

    const taskResult: TaskExecutionResult = {
      execution_id: "exec_factory_001",
      mission_id: "mis_factory_001",
      run_id: "run_factory_001",
      step_id: "step_implement",
      final_outcome: FinalOutcome.Success,
      summary: "Produced a governed pull-request-ready patch.",
      artifacts: [artifactRef],
      changed_files: ["components/marketing/Hero.tsx"],
      issues: [],
      approval_needed: true,
      artifact_manifest: artifactManifest,
      verification_receipt: verificationReceipt,
      outcome_metrics: outcomeMetrics,
      learning_candidates: [learningCandidate],
    };

    const factoryEvent: FactoryEvent<{ work_order: WorkOrder }> = {
      schema_version: "v1",
      event_id: "evt_work_order_created_001",
      timestamp: "2026-07-10T18:00:00Z",
      sequence: 1,
      source: "missioncontrol",
      type: "work_order.created",
      mission_id: "mis_factory_001",
      run_id: "run_factory_001",
      actor: "hermes",
      payload: { work_order: workOrder },
    };

    expect(workOrder.auto_merge_eligible).toBe(false);
    expect(executionEnvelope.work_order?.work_order_id).toBe(workOrder.work_order_id);
    expect(taskResult.verification_receipt?.acceptance_results[0]?.acceptance_criterion_id).toBe("AC-1");
    expect(taskResult.outcome_metrics?.primary_outcome).toContain("accepted_verified_value");
    expect(run.learning_candidates?.[0]?.proposed_output_type).toBe(LearningOutputType.NewVerifier);
    expect(approvalDecision.evidence_refs).toContain(verificationReceipt.receipt_id);
    expect(factoryEvent.type).toBe("work_order.created");
  });
});
