import { describe, expect, it } from "vitest";
import { readApiResponse, withQuery } from "./api.js";

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
