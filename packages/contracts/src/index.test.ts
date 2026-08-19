import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CANONICAL_EVENT_TYPES,
  StepKind,
  StepState,
  ApprovalMode,
  FinalOutcome,
  type CanonicalEventType,
  type EventEnvelope,
  type TaskExecutionResult,
  type ApprovalRequest,
  type ArtifactRef,
  type Mission,
  type Run,
  type Step,
  type ExecutionEnvelope,
  type StepExecutionRequest,
} from "./index.js";
import type { components } from "./index.js";

// The canonical taxonomy is duplicated by necessity: it is a TS runtime list
// here, an inline enum in schema/openapi.yaml (which the TS and Python model
// generators read), and a union in the generated types. Compile-time guard
// for the generated-types copy -- assignable both ways means the two sets are
// identical, so adding an event type to only one of them stops `pnpm
// typecheck` instead of silently shipping a type no consumer can express.
type SchemaEventType = components["schemas"]["EventEnvelope"]["type"];
const _canonicalCoversSchema: SchemaEventType[] = [...CANONICAL_EVENT_TYPES];
const _schemaCoversCanonical: CanonicalEventType[] = _canonicalCoversSchema;
void _schemaCoversCanonical;

// Pulls the EventEnvelope.type enum straight out of the YAML the generators
// consume, without adding a YAML parser dependency to this package: find the
// enum block under EventEnvelope's `type` property and read its list items.
function readSchemaEventTypes(): string[] {
  const yaml = readFileSync(new URL("../schema/openapi.yaml", import.meta.url), "utf8");
  const lines = yaml.split("\n");
  const envelopeAt = lines.indexOf("    EventEnvelope:");
  if (envelopeAt === -1) throw new Error("EventEnvelope schema not found in openapi.yaml");
  const typeAt = lines.indexOf("        type:", envelopeAt);
  if (typeAt === -1) throw new Error("EventEnvelope.type property not found in openapi.yaml");
  const enumAt = lines.indexOf("          enum:", typeAt);
  if (enumAt === -1) throw new Error("EventEnvelope.type enum not found in openapi.yaml");
  const values: string[] = [];
  for (const line of lines.slice(enumAt + 1)) {
    const match = /^ {12}- (\S+)$/.exec(line);
    if (!match) break;
    values.push(match[1]!);
  }
  return values;
}

describe("contracts package exports", () => {
  it("exports canonical enums", () => {
    expect(StepKind.Implement).toBe("implement");
    expect(StepState.Running).toBe("running");
    expect(ApprovalMode.OnPolicyTrigger).toBe("on_policy_trigger");
    expect(FinalOutcome.Success).toBe("success");
  });

  it("exports the canonical event taxonomy as a runtime list", () => {
    // The orchestrator validates incoming event types against this list and
    // the console registers one SSE listener per entry, so it has to be a
    // value, unique, and cover every lifecycle family.
    expect(new Set(CANONICAL_EVENT_TYPES).size).toBe(CANONICAL_EVENT_TYPES.length);
    for (const prefix of ["mission.", "run.", "step.", "tool.", "artifact.", "approval.", "eval.", "policy.", "execution."]) {
      expect(CANONICAL_EVENT_TYPES.some((type) => type.startsWith(prefix))).toBe(true);
    }
    const asType: CanonicalEventType = "step.completed";
    expect(CANONICAL_EVENT_TYPES).toContain(asType);
  });

  it("keeps the OpenAPI event enum in step with the canonical taxonomy", () => {
    // openapi.yaml is what generate:ts and generate:py read, so a type added
    // to only one of the two copies ships a schema no generated client can
    // express (the Python models would reject the event outright).
    expect([...readSchemaEventTypes()].sort()).toEqual([...CANONICAL_EVENT_TYPES].sort());
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
});
