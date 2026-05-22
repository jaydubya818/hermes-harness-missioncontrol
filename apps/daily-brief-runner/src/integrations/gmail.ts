// Gmail — top N urgent emails.
//
// "Urgent" definition (configurable):
//   • If GMAIL_URGENT_LABELS is set, use those labels.
//   • Otherwise: in:inbox AND (is:starred OR is:important) AND newer_than:1d.
//
// Stub mode: returns demo when no Google creds.

import type { UrgentEmail } from "../types.js";
import { getAccessToken } from "./google-auth.js";

const DEMO_EMAILS: UrgentEmail[] = [
  { from: "[stub] GitHub", subject: "PR #42 ready for review", snippet: "feat/daily-brief-workflow is ready for review — author requested..." },
  { from: "[stub] Stripe", subject: "Weekly revenue summary", snippet: "Your weekly revenue summary is available. Total gross: $..." },
  { from: "[stub] Calendly", subject: "New booking: 3:00 PM PT", snippet: "M. Chen booked a 30-minute slot for Friday at 3:00 PM PT..." },
];

interface GmailListResponse {
  messages?: Array<{ id: string }>;
}

interface GmailMessageResponse {
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
}

export async function fetchUrgentEmails(opts: {
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  labels?: string[];
  max: number;
  fetchImpl?: typeof fetch;
}): Promise<{ emails: UrgentEmail[]; warning?: string }> {
  if (!opts.refreshToken || !opts.clientId) {
    return { emails: DEMO_EMAILS.slice(0, opts.max), warning: "gmail:stub (no Google creds)" };
  }
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
    return { emails: [], warning: `gmail:auth_error (${err instanceof Error ? err.message : String(err)})` };
  }

  const query = (opts.labels && opts.labels.length > 0)
    ? opts.labels.map((label) => `label:${label}`).join(" OR ")
    : "in:inbox AND (is:starred OR is:important) AND newer_than:1d";

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", query);
  listUrl.searchParams.set("maxResults", String(opts.max));

  let listResponse: Response;
  try {
    listResponse = await fetchFn(listUrl.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    return { emails: [], warning: `gmail:list_error (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!listResponse.ok) {
    return { emails: [], warning: `gmail:list_${listResponse.status}` };
  }
  const list = (await listResponse.json()) as GmailListResponse;
  const ids = (list.messages ?? []).slice(0, opts.max).map((entry) => entry.id);

  const emails: UrgentEmail[] = [];
  for (const id of ids) {
    const detailUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
    detailUrl.searchParams.set("format", "metadata");
    detailUrl.searchParams.append("metadataHeaders", "From");
    detailUrl.searchParams.append("metadataHeaders", "Subject");
    try {
      const response = await fetchFn(detailUrl.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
      if (!response.ok) continue;
      const data = (await response.json()) as GmailMessageResponse;
      const headers = data.payload?.headers ?? [];
      const from = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "(unknown)";
      const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "(no subject)";
      emails.push({
        from: cleanFrom(from),
        subject,
        snippet: (data.snippet ?? "").slice(0, 80),
      });
    } catch {
      continue;
    }
  }
  return { emails };
}

function cleanFrom(rawFrom: string) {
  const match = rawFrom.match(/^"?([^"<]+?)"?\s*<.*>$/);
  if (match) return match[1].trim();
  return rawFrom;
}
