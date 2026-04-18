export interface ContractError {
  error: {
    code:
      | "INVALID_ENVELOPE"
      | "UNAUTHORIZED_TOOL"
      | "STEP_TIMEOUT"
      | "INTERRUPTED"
      | "POLICY_BLOCKED"
      | "INTERNAL_EXECUTION_ERROR"
      | "CONTEXT_LOAD_FAILED";
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}
