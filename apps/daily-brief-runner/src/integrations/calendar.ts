// Google Calendar — primary calendar fetch for "today's events".
//
// Stub mode: returns demo events when GOOGLE_OAUTH_REFRESH_TOKEN is unset.
// Real mode: TODO — wire to google-auth-library + googleapis. Left as a stub so
// the workflow runs end-to-end on day 1 without secrets. Implementation is
// straightforward; deferred until OAuth flow is decided (refresh-token vs
// service-account-with-domain-wide-delegation).

import type { CalendarEvent } from "../types.js";

const DEMO_EVENTS: CalendarEvent[] = [
  { title: "[stub] Morning standup", start_local: "09:30", end_local: "09:45", attendees_count: 4 },
  { title: "[stub] Review Daily Brief scaffold", start_local: "11:00", end_local: "11:30" },
  { title: "[stub] 1:1 with M.", start_local: "15:00", end_local: "15:30", attendees_count: 2 },
];

export async function fetchCalendarEvents(opts: {
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  calendarIds?: string[];
  date: Date;
}): Promise<{ events: CalendarEvent[]; warning?: string }> {
  if (!opts.refreshToken || !opts.clientId || !opts.clientSecret) {
    return { events: DEMO_EVENTS, warning: "calendar:stub (no Google creds)" };
  }

  // TODO: Real implementation.
  // 1. Exchange refreshToken for an access_token at https://oauth2.googleapis.com/token
  // 2. For each calendarId, GET https://www.googleapis.com/calendar/v3/calendars/{cal}/events
  //    ?timeMin=<dayStartISO>&timeMax=<dayEndISO>&singleEvents=true&orderBy=startTime
  // 3. Map to CalendarEvent[]. Filter all-day events out unless title is short.
  return { events: [], warning: "calendar:not-implemented (creds present, integration stub)" };
}
