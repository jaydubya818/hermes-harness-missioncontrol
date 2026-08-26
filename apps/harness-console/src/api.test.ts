import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrailingThrottle, encodePathSegments, filterCommands, isCurrentStepActionable, isStepRetryable, normalizeOperatorActor, readApiResponse, RETRYABLE_STEP_STATES, withQuery } from "./api.js";

describe("withQuery", () => {
  it("returns the bare url when no params are set", () => {
    expect(withQuery("/orchestrator/api/read-models/audit", {})).toBe("/orchestrator/api/read-models/audit");
  });

  it("skips undefined and empty values instead of sending empty filters", () => {
    expect(withQuery("/api/read-models/artifacts", {
      run_id: "run_1",
      step_id: undefined,
      mission_id: "",
      limit: "20"
    })).toBe("/api/read-models/artifacts?run_id=run_1&limit=20");
  });

  it("url-encodes filter values", () => {
    expect(withQuery("/api/events/stream", { token: "a b&c" })).toBe("/api/events/stream?token=a+b%26c");
  });
});

describe("encodePathSegments", () => {
  it("keeps the separators and escapes each segment", () => {
    expect(encodePathSegments("projects/proj_demo/standards.md")).toBe("projects/proj_demo/standards.md");
    expect(encodePathSegments("projects/proj demo/notes #1.md")).toBe("projects/proj%20demo/notes%20%231.md");
  });

  it("escapes characters that would truncate the request path", () => {
    // "?" starts a query string and "#" a fragment, so an unescaped slug
    // silently asked the API for a different (shorter) article.
    expect(encodePathSegments("projects/p/what?.md")).toBe("projects/p/what%3F.md");
    expect(encodePathSegments("projects/p/a#b.md")).toBe("projects/p/a%23b.md");
  });
});

describe("readApiResponse", () => {
  it("parses JSON bodies", async () => {
    const body = await readApiResponse(new Response(JSON.stringify({ ok: true })));
    expect(body).toEqual({ ok: true });
  });

  it("returns null for empty bodies", async () => {
    expect(await readApiResponse(new Response(""))).toBeNull();
  });

  it("returns raw text for non-JSON bodies (proxy error pages)", async () => {
    expect(await readApiResponse(new Response("<html>502</html>"))).toBe("<html>502</html>");
  });
});

describe("filterCommands", () => {
  const commands = [
    { id: "overview", label: "Open Overview" },
    { id: "missions", label: "Open Missions" },
    { id: "audit", label: "Open Audit" }
  ];

  it("returns everything for an empty or whitespace query", () => {
    expect(filterCommands(commands, "")).toEqual(commands);
    expect(filterCommands(commands, "   ")).toEqual(commands);
  });

  it("matches case-insensitively on label and id", () => {
    expect(filterCommands(commands, "MISS").map((command) => command.id)).toEqual(["missions"]);
    expect(filterCommands(commands, "audit").map((command) => command.id)).toEqual(["audit"]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(filterCommands(commands, " overview ").map((command) => command.id)).toEqual(["overview"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterCommands(commands, "deploy")).toEqual([]);
  });
});

describe("createTrailingThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires immediately when idle", () => {
    const fn = vi.fn();
    const throttled = createTrailingThrottle(fn, 1000);
    throttled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst into one trailing call per window", () => {
    const fn = vi.fn();
    const throttled = createTrailingThrottle(fn, 1000);
    throttled();
    for (let i = 0; i < 50; i += 1) throttled();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("fires immediately again once the window has elapsed", () => {
    const fn = vi.fn();
    const throttled = createTrailingThrottle(fn, 1000);
    throttled();
    vi.advanceTimersByTime(1500);
    throttled();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a pending trailing call", () => {
    const fn = vi.fn();
    const throttled = createTrailingThrottle(fn, 1000);
    throttled();
    throttled();
    throttled.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("normalizeOperatorActor", () => {
  it("trims the stored identity", () => {
    expect(normalizeOperatorActor("  jay  ")).toBe("jay");
  });

  it("treats missing or blank identities as unset so the server default applies", () => {
    // Sending actor: "" would record an empty attribution in the audit
    // trail instead of the orchestrator's "operator" fallback.
    expect(normalizeOperatorActor(null)).toBeUndefined();
    expect(normalizeOperatorActor(undefined)).toBeUndefined();
    expect(normalizeOperatorActor("   ")).toBeUndefined();
  });
});

describe("isStepRetryable", () => {
  it("offers Retry for exactly the states POST /api/runs/:id/retry-step accepts", () => {
    // Pinned against the orchestrator route's own guard:
    //   if (!current || !["failed", "paused", "blocked", "awaiting_approval"]
    //       .includes(current.state)) return 409 "current step not retryable"
    expect([...RETRYABLE_STEP_STATES].sort()).toEqual(["awaiting_approval", "blocked", "failed", "paused"]);
    for (const state of ["paused", "failed", "blocked", "awaiting_approval"]) {
      expect(isStepRetryable(state), state).toBe(true);
    }
  });

  it("does not offer Retry on a cancelled step", () => {
    // Cancel is a close-out: /cancel and /cancel-step have already recorded
    // the run's eval and released its worktree and branch, and the route
    // 409s. Rendering the button anyway gave the operator a control whose
    // only outcome was "current step not retryable".
    expect(isStepRetryable("cancelled")).toBe(false);
  });

  it("does not offer Retry on running, pending, completed or missing states", () => {
    for (const state of ["running", "pending", "completed", undefined]) {
      expect(isStepRetryable(state), String(state)).toBe(false);
    }
  });
});


describe("isCurrentStepActionable", () => {
  it("offers the dispatch controls on a running current step", () => {
    expect(isCurrentStepActionable({ step_id: "implement", state: "running" }, { current_step_id: "implement" })).toBe(true);
  });

  it("does not offer them on a running step that is not the run's current step", () => {
    // executeCurrent() posts to /api/runs/:id/execute-current, which takes
    // only a run_id: rendered under a non-current step the button silently
    // dispatches a different step than the operator pointed at. The sibling
    // Interrupt/Resume/Retry/Cancel-step controls already gate on this same
    // condition. Reachable through persisted state -- rehydrateRecords
    // validates only run_id and that steps is an array -- so a run can hold a
    // running step that current_step_index has moved past.
    expect(isCurrentStepActionable({ step_id: "plan", state: "running" }, { current_step_id: "implement" })).toBe(false);
  });

  it("does not offer them on a current step that is not running", () => {
    // /steps/:stepId/complete 409s "step is not current runnable step", and
    // /execute-current refuses a run that is not running.
    for (const state of ["pending", "paused", "awaiting_approval", "blocked", "completed", "failed", "cancelled", undefined]) {
      expect(isCurrentStepActionable({ step_id: "implement", state }, { current_step_id: "implement" }), String(state)).toBe(false);
    }
  });

  it("does not match a step with no id against a run with no current step", () => {
    // Same `undefined === undefined` trap the orchestrator's artifact dedupe
    // fell into: a persisted step with no step_id must not read as current.
    expect(isCurrentStepActionable({ state: "running" }, {})).toBe(false);
  });
});
