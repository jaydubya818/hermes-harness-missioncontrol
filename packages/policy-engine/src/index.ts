export interface PolicyDecision {
  allowed: boolean;
  requires_approval: boolean;
  reason: string;
  policy_id: string;
}

export function evaluateStepPolicy(input: { kind: string; risk: "low" | "medium" | "high"; artifactCount?: number }): PolicyDecision {
  if (input.kind === "deploy" || input.risk === "high") {
    return { allowed: true, requires_approval: true, reason: "high-risk action requires approval", policy_id: "approval-high-risk" };
  }
  if (input.kind === "review" && (input.artifactCount ?? 0) === 0) {
    return { allowed: false, requires_approval: false, reason: "review step requires at least one artifact", policy_id: "review-needs-artifact" };
  }
  return { allowed: true, requires_approval: false, reason: "step allowed", policy_id: "allow-default" };
}
