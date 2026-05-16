// Gmail — top N urgent emails.
//
// "Urgent" definition (configurable):
//   • If GMAIL_URGENT_LABELS is set, use those labels.
//   • Otherwise: in:inbox AND (is:starred OR is:important) AND newer_than:1d.
//
// Stub mode: returns demo when no Google creds.

import type { UrgentEmail } from "../types.js";

const DEMO_EMAILS: UrgentEmail[] = [
  { from: "[stub] GitHub", subject: "PR #42 ready for review", snippet: "feat/daily-brief-workflow is ready for review — author requested..." },
  { from: "[stub] Stripe", subject: "Weekly revenue summary", snippet: "Your weekly revenue summary is available. Total gross: $..." },
  { from: "[stub] Calendly", subject: "New booking: 3:00 PM PT", snippet: "M. Chen booked a 30-minute slot for Friday at 3:00 PM PT..." },
];

export async function fetchUrgentEmails(opts: {
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  labels?: string[];
  max: number;
}): Promise<{ emails: UrgentEmail[]; warning?: string }> {
  if (!opts.refreshToken || !opts.clientId || !opts.clientSecret) {
    return { emails: DEMO_EMAILS.slice(0, opts.max), warning: "gmail:stub (no Google creds)" };
  }

  // TODO: Real implementation.
  // 1. Exchange refreshToken for an access_token.
  // 2. Build query string:
  //      labels.length ? labels.map(l => `label:${l}`).join(" OR ")
  //                    : "in:inbox AND (is:starred OR is:important) AND newer_than:1d"
  // 3. GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=<encoded>&maxResults=<max>
  // 4. For each id, GET .../messages/<id>?format=metadata&metadataHeaders=From,Subject
  //    plus snippet from .../messages/<id>?format=full (or skip body for speed)
  // 5. Map to UrgentEmail[]; truncate snippet to ~80 chars.
  return { emails: [], warning: "gmail:not-implemented (creds present, integration stub)" };
}
