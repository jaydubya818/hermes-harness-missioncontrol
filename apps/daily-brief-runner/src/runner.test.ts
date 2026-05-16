import { describe, it, expect } from "vitest";
import { loadConfig, buildBrief } from "./runner.js";

describe("loadConfig", () => {
  it("uses defaults when env is empty", () => {
    const c = loadConfig({});
    expect(c.gmail.max).toBe(5);
    expect(c.feeds.maxTotal).toBe(3);
    expect(c.weather.lat).toBe(37.7749);
    expect(c.tz).toBe("America/Los_Angeles");
    expect(c.dryRun).toBe(false);
  });

  it("parses CSV envs into arrays", () => {
    const c = loadConfig({
      GOOGLE_CALENDAR_IDS: "primary, work@example.com, side",
      FEEDS_RSS_URLS: "https://a.com/rss, https://b.com/atom",
    });
    expect(c.calendar.ids).toEqual(["primary", "work@example.com", "side"]);
    expect(c.feeds.rssUrls).toEqual(["https://a.com/rss", "https://b.com/atom"]);
  });

  it("clamps GMAIL_URGENT_MAX to [1,10]", () => {
    expect(loadConfig({ GMAIL_URGENT_MAX: "0" }).gmail.max).toBe(1);
    expect(loadConfig({ GMAIL_URGENT_MAX: "99" }).gmail.max).toBe(10);
    expect(loadConfig({ GMAIL_URGENT_MAX: "abc" }).gmail.max).toBe(5);
  });

  it("respects DAILY_BRIEF_DRY_RUN=true exactly", () => {
    expect(loadConfig({ DAILY_BRIEF_DRY_RUN: "true" }).dryRun).toBe(true);
    expect(loadConfig({ DAILY_BRIEF_DRY_RUN: "True" }).dryRun).toBe(false); // strict
    expect(loadConfig({ DAILY_BRIEF_DRY_RUN: "1" }).dryRun).toBe(false);
  });
});

describe("buildBrief (stub mode — no creds)", () => {
  it("produces a complete brief with stub warnings, never throws", async () => {
    const config = loadConfig({}); // no secrets → all sources stub
    const brief = await buildBrief(config, new Date("2026-05-16T14:00:00Z"));
    expect(brief.date_local).toBe("2026-05-16");
    expect(brief.events.length).toBeGreaterThan(0);
    expect(brief.urgent_emails.length).toBeGreaterThan(0);
    expect(brief.weather).not.toBeNull();
    expect(brief.feeds.length).toBeGreaterThan(0);
    expect(brief.warnings.length).toBe(4); // four stub warnings
    expect(brief.warnings.every((w) => w.includes(":stub"))).toBe(true);
  });
});
