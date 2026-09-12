import { describe, expect, it } from "vitest";
import { detect, listTellIds } from "./detect.js";

describe("humanizer-skill / detect", () => {
  it("returns an empty report for plain, human-sounding prose", () => {
    const report = detect("The cron job runs at 7am. It pulls from Gmail and posts to Telegram.");
    expect(report.totalTells).toBe(0);
    expect(report.totalMatches).toBe(0);
    expect(report.score).toBe(0);
    expect(report.tells).toEqual([]);
  });

  it("fires on the classic 'delve' tell with high severity", () => {
    const report = detect("Let us delve into the data and explore the implications.");
    const delve = report.tells.find((t) => t.id === "delve");
    expect(delve).toBeDefined();
    expect(delve?.severity).toBe("high");
    expect(delve?.matches).toEqual(["delve"]);
  });

  it("aggregates multiple tells from a representative AI-sounding paragraph", () => {
    const input =
      "In today's fast-paced world, it is important to note that we must delve into the ever-evolving landscape of customer support. " +
      "Moreover, we should leverage cutting-edge tools to facilitate a comprehensive guide for our team. " +
      "In conclusion, the bottom line is that this is a game changer.";
    const report = detect(input);

    // Score should be obviously above the "looks human" threshold
    expect(report.score).toBeGreaterThan(20);

    const ids = report.tells.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "in_todays_fast_paced",
        "it_is_important",
        "delve",
        "ever_evolving",
        
        "moreover",
        "leverage",
        "cutting_edge",
        "facilitate",
        "comprehensive_guide",
        "in_conclusion",
        "the_bottom_line",
        "game_changer",
      ])
    );
  });

  it("only fires em_dash_heavy when there are 3+ em dashes", () => {
    expect(detect("one — two — sentences").tells.find((t) => t.id === "em_dash_heavy")).toBeUndefined();
    const triple = detect("one — two — three — four");
    expect(triple.tells.find((t) => t.id === "em_dash_heavy")).toBeDefined();
  });

  it("returns deterministic output across repeated runs for the same input", () => {
    const input = "Moreover, we leverage cutting-edge tools. In conclusion, this is a game changer.";
    const a = detect(input);
    const b = detect(input);
    expect(a).toEqual(b);
  });

  it("ships at least 30 distinct tell categories (spec requirement: 30+)", () => {
    const ids = listTellIds();
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids.length).toBeGreaterThanOrEqual(30);
  });

  it("clamps score to 0..100", () => {
    const ai = "delve ".repeat(500) + "moreover furthermore in conclusion in summary it is important to note " +
               "ever-evolving landscape tapestry plethora vast array cutting-edge state-of-the-art game changer";
    const report = detect(ai);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it("normalizes severity weights so a single 'high' tell outscores a single 'low' tell", () => {
    const high = detect("Let us delve in.").score;
    const low = detect("There is a myriad of options.").score;
    expect(high).toBeGreaterThan(low);
  });
});
