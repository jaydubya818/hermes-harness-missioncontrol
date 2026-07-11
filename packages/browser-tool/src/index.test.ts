import { describe, expect, it } from "vitest";
import { createBrowserSession, isDomainAllowed } from "./index.js";

describe("browser-tool", () => {
  it("matches exact and subdomain entries", () => {
    expect(isDomainAllowed("https://hermes-workspace.com/", ["hermes-workspace.com"])).toBe(true);
    expect(isDomainAllowed("https://api.hermes-workspace.com/", ["hermes-workspace.com"])).toBe(true);
    expect(isDomainAllowed("https://api.hermes-workspace.com/", ["*.hermes-workspace.com"])).toBe(true);
    expect(isDomainAllowed("https://example.com/", ["hermes-workspace.com"])).toBe(false);
  });

  it("rejects all when allowedDomains is empty", () => {
    expect(isDomainAllowed("https://example.com/", [])).toBe(false);
  });

  it("stub session blocks disallowed navigation and accepts allowed domains", async () => {
    const session = await createBrowserSession({ allowedDomains: ["allowed.test"], forceStub: true });
    const blocked = await session.navigate("https://disallowed.test/");
    expect(blocked.ok).toBe(false);
    expect(blocked.blocked_reason).toContain("allowed list");
    const allowed = await session.navigate("https://allowed.test/page");
    expect(allowed.ok).toBe(true);
    const snapshot = await session.snapshot();
    expect(snapshot.snapshot).toContain("playwright not installed");
    await session.close();
  });
});
