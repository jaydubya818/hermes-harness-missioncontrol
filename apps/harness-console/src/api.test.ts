import { describe, expect, it } from "vitest";
import { filterCommands, readApiResponse, withQuery } from "./api.js";

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
