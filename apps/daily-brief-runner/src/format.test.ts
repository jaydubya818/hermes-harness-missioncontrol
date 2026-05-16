import { describe, it, expect } from "vitest";
import { formatBrief } from "./format.js";
import type { DailyBrief } from "./types.js";

const SAMPLE: DailyBrief = {
  generated_at: "2026-05-16T14:00:00.000Z",
  date_local: "2026-05-16",
  events: [
    { title: "Standup", start_local: "09:30", end_local: "09:45", attendees_count: 4 },
    { title: "1:1 with Sarah", start_local: "15:00", end_local: "15:30", location: "Zoom" },
  ],
  urgent_emails: [
    { from: "GitHub", subject: "PR ready", snippet: "feat/x ready for review" },
  ],
  weather: { high_f: 68, low_f: 54, precip_probability: 0.1, conditions: "Partly cloudy" },
  feeds: [
    { source: "Hacker News", title: "Show HN: Cool thing", url: "https://example.com/1" },
  ],
  warnings: [],
};

describe("formatBrief", () => {
  it("renders all four sections", () => {
    const out = formatBrief(SAMPLE);
    expect(out).toContain("Daily Brief — 2026-05-16");
    expect(out).toContain("📅 Calendar");
    expect(out).toContain("📧 Urgent");
    expect(out).toContain("🌤️ Weather");
    expect(out).toContain("📰 Headlines");
  });

  it("formats event time range with attendees and location", () => {
    const out = formatBrief(SAMPLE);
    expect(out).toContain("09:30–09:45 — Standup · 4p");
    expect(out).toContain("15:00–15:30 — 1:1 with Sarah · Zoom");
  });

  it("formats weather with precip percentage", () => {
    const out = formatBrief(SAMPLE);
    expect(out).toContain("68°/54° · Partly cloudy · 10% precip");
  });

  it("escapes HTML to be safe for Telegram parse_mode=HTML", () => {
    const out = formatBrief({
      ...SAMPLE,
      events: [{ title: "Demo <script>alert(1)</script>", start_local: "10:00" }],
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("shows empty-state strings when sources are empty", () => {
    const out = formatBrief({
      ...SAMPLE,
      events: [],
      urgent_emails: [],
      feeds: [],
      weather: null,
    });
    expect(out).toContain("Nothing on the calendar today.");
    expect(out).toContain("Inbox clear of starred/important.");
    expect(out).toContain("No headlines configured.");
  });

  it("appends warnings only when present", () => {
    expect(formatBrief({ ...SAMPLE, warnings: [] })).not.toContain("⚠️");
    const warned = formatBrief({ ...SAMPLE, warnings: ["calendar:stub", "weather:no-key"] });
    expect(warned).toContain("⚠️ calendar:stub · weather:no-key");
  });

  it("stays well under Telegram 4096-char limit for typical brief", () => {
    expect(formatBrief(SAMPLE).length).toBeLessThan(4096);
  });
});
