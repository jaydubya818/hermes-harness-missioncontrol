// Pure formatter: DailyBrief → human-readable string (HTML-safe for Telegram parse_mode=HTML).
// No I/O; fully unit-testable.

import type { DailyBrief } from "./types.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatBrief(brief: DailyBrief): string {
  const lines: string[] = [];
  lines.push(`<b>☀️ Daily Brief — ${brief.date_local}</b>`);

  // Calendar
  lines.push("");
  lines.push("<b>📅 Calendar</b>");
  if (brief.events.length === 0) {
    lines.push("Nothing on the calendar today.");
  } else {
    for (const e of brief.events) {
      const time = e.end_local ? `${e.start_local}–${e.end_local}` : e.start_local;
      const att = e.attendees_count ? ` · ${e.attendees_count}p` : "";
      const loc = e.location ? ` · ${escapeHtml(e.location)}` : "";
      lines.push(`• ${time} — ${escapeHtml(e.title)}${att}${loc}`);
    }
  }

  // Urgent emails
  lines.push("");
  lines.push("<b>📧 Urgent</b>");
  if (brief.urgent_emails.length === 0) {
    lines.push("Inbox clear of starred/important.");
  } else {
    for (const m of brief.urgent_emails) {
      lines.push(`• <b>${escapeHtml(m.from)}</b> — ${escapeHtml(m.subject)}`);
      if (m.snippet) lines.push(`  <i>${escapeHtml(m.snippet)}</i>`);
    }
  }

  // Weather
  lines.push("");
  lines.push("<b>🌤️ Weather</b>");
  if (!brief.weather) {
    lines.push("—");
  } else {
    const w = brief.weather;
    const pop = Math.round(w.precip_probability * 100);
    lines.push(`${w.high_f}°/${w.low_f}° · ${escapeHtml(w.conditions)} · ${pop}% precip`);
  }

  // Feeds
  lines.push("");
  lines.push("<b>📰 Headlines</b>");
  if (brief.feeds.length === 0) {
    lines.push("No headlines configured.");
  } else {
    for (const h of brief.feeds) {
      lines.push(`• <a href="${escapeHtml(h.url)}">${escapeHtml(h.title)}</a> — ${escapeHtml(h.source)}`);
    }
  }

  // Warnings (only shown if any source failed)
  if (brief.warnings.length > 0) {
    lines.push("");
    lines.push(`<i>⚠️ ${escapeHtml(brief.warnings.join(" · "))}</i>`);
  }

  return lines.join("\n");
}
