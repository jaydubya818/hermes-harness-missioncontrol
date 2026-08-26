// Pure request/response helpers shared by the console views. Kept free of
// window/localStorage so they stay unit-testable in a plain node runner.

export function withQuery(url: string, params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const suffix = search.toString();
  return suffix ? `${url}?${suffix}` : url;
}

// Article slugs are wiki-relative paths built from real filenames, and they
// go into the URL *path* (not a query value), so each segment needs escaping
// on its own -- encodeURIComponent over the whole slug would eat the "/"
// separators. Unescaped, a filename containing "?" or "#" silently truncated
// the request (everything after became a query string or fragment) and one
// containing a space produced an invalid URL.
export function encodePathSegments(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

// The operator identity sent with approval decisions. It lands in the audit
// trail (`resolved_by`, the approval.resolved event actor) and drives the
// actor filters, so it must be the person actually operating this console --
// not a build-time constant. Blank means "unset": the request omits `actor`
// and the orchestrator falls back to its own "operator" default rather than
// recording an empty attribution.
export function normalizeOperatorActor(raw: string | null | undefined): string | undefined {
  const actor = (raw ?? "").trim();
  return actor || undefined;
}

export async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// Step states that POST /api/runs/:id/retry-step accepts. Kept here (not
// inline in the run card) so it is unit-testable, and deliberately without
// "cancelled": since the orchestrator closed the retry-step resurrection hole
// the route 409s a cancelled step ("current step not retryable"), so the
// console was rendering a Retry button whose only possible outcome was an
// error toast. Cancel is a close-out -- it has already recorded the run's
// eval and released its worktree and branch -- so there is nothing to retry.
// Mirrors the route's own list; keep the two in step.
export const RETRYABLE_STEP_STATES = ["paused", "failed", "blocked", "awaiting_approval"] as const;

export function isStepRetryable(state: string | undefined): boolean {
  return !!state && (RETRYABLE_STEP_STATES as readonly string[]).includes(state);
}

// Gates the run card's two dispatch controls, "Execute current step" and
// "Mark step complete". Both act on the run's *current* step:
// `/execute-current` takes only a run_id and ignores the step the button was
// rendered under, and `/steps/:stepId/complete` 409s "step is not current
// runnable step" for anything else. Rendered for any `running` step, the
// first silently acts on a different step than the operator pointed at and
// the second can only ever produce an error toast -- the same shape as the
// 2026-08-25 Retry finding. The sibling Interrupt/Resume/Retry/Cancel-step
// controls already carry this condition inline; it lives here instead so it
// is unit-testable (App.tsx has no test coverage, and a JSX condition cannot
// be pinned against the routes it mirrors). The explicit step_id check
// matters: two undefined ids must not compare equal into a match.
export function isCurrentStepActionable(
  step: { step_id?: string; state?: string },
  run: { current_step_id?: string }
): boolean {
  return step.state === "running" && !!step.step_id && step.step_id === run.current_step_id;
}

export function filterCommands<T extends { id: string; label: string }>(commands: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((command) => command.label.toLowerCase().includes(q) || command.id.toLowerCase().includes(q));
}

// Trailing-edge throttle: fire immediately when idle, then coalesce further
// calls into one trailing invocation per window. Used to keep SSE event
// bursts (replay on connect, chatty step dispatches) from triggering a
// refetch storm -- one revalidation per window instead of one per event.
export function createTrailingThrottle(fn: () => void, windowMs: number): { (): void; cancel: () => void } {
  let lastInvokedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invoke = () => {
    lastInvokedAt = Date.now();
    timer = undefined;
    fn();
  };
  const throttled = () => {
    if (timer !== undefined) return;
    const elapsed = Date.now() - lastInvokedAt;
    if (elapsed >= windowMs) invoke();
    else timer = setTimeout(invoke, windowMs - elapsed);
  };
  throttled.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return throttled;
}
