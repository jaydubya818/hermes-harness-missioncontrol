import { describe, expect, it } from "vitest";
import { createLlmClient, resolveProvider } from "./index.js";

describe("llm-client", () => {
  it("resolves provider aliases", () => {
    expect(resolveProvider("anthropic")).toBe("claude");
    expect(resolveProvider("CLAUDE")).toBe("claude");
    expect(resolveProvider("gpt")).toBe("openai");
    expect(resolveProvider("xai")).toBe("grok");
    expect(resolveProvider(undefined)).toBe("mock");
    expect(resolveProvider("unknown-provider")).toBe("mock");
  });

  it("mock client returns deterministic completion for messages", async () => {
    const client = createLlmClient({ provider: "mock" });
    const completion = await client.complete({
      system: "you are a tester",
      messages: [{ role: "user", content: "say hello" }],
      tools: [{ name: "noop", description: "no operation", input_schema: { type: "object" } }],
    });
    expect(client.provider).toBe("mock");
    expect(completion.stop_reason).toBe("end_turn");
    expect(completion.text).toContain("noop");
    expect(completion.text).toContain("say hello");
    expect(completion.tool_calls).toHaveLength(0);
  });
});
