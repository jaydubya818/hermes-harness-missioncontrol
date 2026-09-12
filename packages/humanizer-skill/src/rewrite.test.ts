import { describe, expect, it, vi } from "vitest";
import { buildRewritePrompt, rewrite, type LLMClient } from "./rewrite.js";
import { detect } from "./detect.js";

function fakeClient(responses: string[]): LLMClient {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const out = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return out;
    }),
  };
}

describe("humanizer-skill / rewrite", () => {
  it("skips the LLM when input is already below the score floor", async () => {
    const client = fakeClient(["SHOULD NOT BE CALLED"]);
    const result = await rewrite("Cron runs at 7am. Pulls Gmail. Posts Telegram.", client);
    expect(result.skipped).toBe(true);
    expect(result.attempts).toBe(0);
    expect(result.output).toBe("Cron runs at 7am. Pulls Gmail. Posts Telegram.");
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("calls the LLM when input has AI tells and returns its output", async () => {
    const input = "In today's fast-paced world, we delve into the ever-evolving landscape of game-changing tools.";
    const expectedOutput = "We use new tools. They matter.";
    const client = fakeClient([expectedOutput]);
    const result = await rewrite(input, client);
    expect(result.skipped).toBe(false);
    expect(result.output).toBe(expectedOutput);
    expect(result.attempts).toBe(1);
    expect(result.before.score).toBeGreaterThan(result.after.score);
    expect(client.complete).toHaveBeenCalledOnce();
  });

  it("re-prompts up to maxAttempts when residual tells remain", async () => {
    const input = "We delve into the ever-evolving landscape of cutting-edge tools.";
    const stillBad = "Moreover, we delve into the cutting-edge landscape.";
    const finallyGood = "We use new tools.";
    const client = fakeClient([stillBad, finallyGood]);
    const result = await rewrite(input, client, { maxAttempts: 3 });
    expect(result.attempts).toBe(2);
    expect(result.output).toBe(finallyGood);
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it("stops at maxAttempts even if the score never crosses the floor", async () => {
    const input = "We delve into the ever-evolving cutting-edge landscape.";
    const client = fakeClient([
      "We delve cutting-edge.",
      "Cutting-edge delve.",
      "Delve cutting-edge."
    ]);
    const result = await rewrite(input, client, { maxAttempts: 2 });
    expect(result.attempts).toBe(2);
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it("passes the detection report into the rewrite prompt by tell label", () => {
    const input = "Moreover, we delve into the landscape.";
    const report = detect(input);
    const prompt = buildRewritePrompt(input, report, "casual voice");
    expect(prompt).toContain("casual voice");
    expect(prompt).toContain("delve");
    expect(prompt).toContain("moreover");
    expect(prompt).toContain("---TEXT TO REWRITE---");
    expect(prompt).toContain("---END TEXT---");
    expect(prompt).toContain(input);
  });

  it("caps the match sample in the prompt to avoid prompt-bloat", () => {
    const input = "delve. delve. delve. delve. delve. delve. delve. delve. delve. delve.";
    const report = detect(input);
    const prompt = buildRewritePrompt(input, report, "x");
    expect(prompt).toMatch(/\(10 total\)/);
  });

  it("honors a custom skipIfScoreBelow", async () => {
    const input = "Moreover, this is robust.";
    const baseline = detect(input).score;
    expect(baseline).toBeGreaterThan(0);
    const client = fakeClient(["never called"]);
    const result = await rewrite(input, client, { skipIfScoreBelow: 100 });
    expect(result.skipped).toBe(true);
    expect(client.complete).not.toHaveBeenCalled();
  });
});
