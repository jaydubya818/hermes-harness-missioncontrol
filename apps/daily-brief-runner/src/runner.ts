// Orchestrates the brief: fetch all sources in parallel, format, deliver.
// Never throws — degrades sources to warnings rather than blocking delivery.

import { fetchCalendarEvents } from "./integrations/calendar.js";
import { fetchUrgentEmails } from "./integrations/gmail.js";
import { fetchWeather } from "./integrations/weather.js";
import { fetchFeeds } from "./integrations/feeds.js";
import { deliverToTelegram } from "./integrations/telegram.js";
import { formatBrief } from "./format.js";
import type { DailyBrief, DeliveryResult } from "./types.js";

type RunnerConfig = {
  google: { clientId?: string; clientSecret?: string; refreshToken?: string };
  calendar: { ids: string[] };
  gmail: { labels: string[]; max: number };
  weather: { apiKey?: string; lat: number; lon: number };
  feeds: { rssUrls: string[]; maxTotal: number };
  telegram: { botToken?: string; chatId?: string };
  dryRun: boolean;
  tz: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const csv = (v?: string) =>
    (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  return {
    google: {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID || undefined,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || undefined,
      refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN || undefined,
    },
    calendar: { ids: csv(env.GOOGLE_CALENDAR_IDS) },
    gmail: {
      labels: csv(env.GMAIL_URGENT_LABELS),
      max: (() => {
        const raw = Number(env.GMAIL_URGENT_MAX);
        return Number.isFinite(raw) ? Math.max(1, Math.min(10, raw)) : 5;
      })(),
    },
    weather: {
      apiKey: env.OPENWEATHER_API_KEY || undefined,
      lat: Number(env.WEATHER_LAT) || 37.7749,
      lon: Number(env.WEATHER_LON) || -122.4194,
    },
    feeds: { rssUrls: csv(env.FEEDS_RSS_URLS), maxTotal: 3 },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN || undefined,
      chatId: env.TELEGRAM_CHAT_ID || undefined,
    },
    dryRun: env.DAILY_BRIEF_DRY_RUN === "true",
    tz: env.DAILY_BRIEF_TZ || "America/Los_Angeles",
  };
}

export async function buildBrief(config: RunnerConfig, now: Date = new Date()): Promise<DailyBrief> {
  const dateLocal = now.toLocaleDateString("en-CA", { timeZone: config.tz }); // YYYY-MM-DD

  const [cal, mail, weather, feeds] = await Promise.all([
    fetchCalendarEvents({ ...config.google, calendarIds: config.calendar.ids, date: now }),
    fetchUrgentEmails({ ...config.google, labels: config.gmail.labels, max: config.gmail.max }),
    fetchWeather(config.weather),
    fetchFeeds(config.feeds),
  ]);

  const warnings: string[] = [];
  if (cal.warning) warnings.push(cal.warning);
  if (mail.warning) warnings.push(mail.warning);
  if (weather.warning) warnings.push(weather.warning);
  if (feeds.warning) warnings.push(feeds.warning);

  return {
    generated_at: now.toISOString(),
    date_local: dateLocal,
    events: cal.events,
    urgent_emails: mail.emails,
    weather: weather.weather,
    feeds: feeds.feeds,
    warnings,
  };
}

export async function runOnce(config: RunnerConfig = loadConfig()): Promise<{
  brief: DailyBrief;
  text: string;
  delivery: DeliveryResult;
}> {
  const brief = await buildBrief(config);
  const text = formatBrief(brief);
  const delivery = await deliverToTelegram({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
    text,
    dryRun: config.dryRun,
  });
  return { brief, text, delivery };
}
