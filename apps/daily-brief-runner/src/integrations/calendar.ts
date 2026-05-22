// Google Calendar — primary calendar fetch for "today's events".
//
// Stub mode: returns demo events when GOOGLE_OAUTH_REFRESH_TOKEN is unset.
// Real mode: exchanges the refresh token for an access token and queries
// Calendar v3 for each calendar id, then maps to CalendarEvent[].

import type { CalendarEvent } from "../types.js";
import { getAccessToken } from "./google-auth.js";

const DEMO_EVENTS: CalendarEvent[] = [
  { title: "[stub] Morning standup", start_local: "09:30", end_local: "09:45", attendees_count: 4 },
  { title: "[stub] Review Daily Brief scaffold", start_local: "11:00", end_local: "11:30" },
  { title: "[stub] 1:1 with M.", start_local: "15:00", end_local: "15:30", attendees_count: 2 },
];

interface CalendarApiEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  location?: string;
  attendees?: Array<{ email?: string }>;
}

interface CalendarApiList {
  items?: CalendarApiEvent[];
}

export async function fetchCalendarEvents(opts: {
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  calendarIds?: string[];
  date: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ events: CalendarEvent[]; warning?: string }> {
  if (!opts.refreshToken || !opts.clientId) {
    return { events: DEMO_EVENTS, warning: "calendar:stub (no Google creds)" };
  }
  const calendarIds = (opts.calendarIds && opts.calendarIds.length > 0) ? opts.calendarIds : ["primary"];
  const fetchFn = opts.fetchImpl ?? fetch;
  let accessToken: string;
  try {
    accessToken = await getAccessToken({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      refreshToken: opts.refreshToken,
      fetchImpl: fetchFn,
    });
  } catch (err) {
    return { events: [], warning: `calendar:auth_error (${err instanceof Error ? err.message : String(err)})` };
  }
  const dayStart = new Date(Date.UTC(opts.date.getUTCFullYear(), opts.date.getUTCMonth(), opts.date.getUTCDate(), 0, 0, 0));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const events: CalendarEvent[] = [];
  const failures: string[] = [];
  for (const calendarId of calendarIds) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("timeMin", dayStart.toISOString());
    url.searchParams.set("timeMax", dayEnd.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "50");
    try {
      const response = await fetchFn(url.toString(), {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        failures.push(`${calendarId}:${response.status}`);
        continue;
      }
      const data = (await response.json()) as CalendarApiList;
      for (const item of data.items ?? []) {
        const mapped = mapApiEvent(item);
        if (mapped) events.push(mapped);
      }
    } catch (err) {
      failures.push(`${calendarId}:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (events.length === 0 && failures.length > 0) {
    return { events: [], warning: `calendar:partial (${failures.join("; ")})` };
  }
  if (failures.length > 0) {
    return { events, warning: `calendar:partial (${failures.join("; ")})` };
  }
  return { events };
}

function mapApiEvent(item: CalendarApiEvent): CalendarEvent | null {
  const title = item.summary?.trim();
  if (!title) return null;
  const start = item.start?.dateTime ?? item.start?.date;
  const end = item.end?.dateTime ?? item.end?.date;
  if (!start) return null;
  const start_local = formatTime(start);
  const end_local = end ? formatTime(end) : undefined;
  return {
    title,
    start_local,
    end_local,
    location: item.location,
    attendees_count: item.attendees?.length,
  };
}

function formatTime(value: string) {
  if (!value.includes("T")) return value; // all-day event
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(11, 16);
}
