export interface PolicyDecision {
  allowed: boolean;
  requires_approval: boolean;
  reason: string;
  policy_id: string;
  confidence_score: number;
}

export function evaluateStepPolicy(input: { kind: string; risk: "low" | "medium" | "high"; artifactCount?: number; workerConfidence?: number }): PolicyDecision {
  const confidence = input.workerConfidence ?? 0.5;
  if (input.kind === "review" && (input.artifactCount ?? 0) === 0) {
    return { allowed: false, requires_approval: false, reason: "review step requires at least one artifact", policy_id: "review-needs-artifact", confidence_score: confidence };
  }
  if (input.kind === "deploy" || input.risk === "high") {
    return { allowed: true, requires_approval: true, reason: "high-risk action requires approval", policy_id: "approval-high-risk", confidence_score: confidence };
  }
  if (confidence < 0.6) {
    return { allowed: true, requires_approval: true, reason: "low confidence requires operator approval", policy_id: "approval-low-confidence", confidence_score: confidence };
  }
  return { allowed: true, requires_approval: false, reason: "step allowed", policy_id: "allow-default", confidence_score: confidence };
}
