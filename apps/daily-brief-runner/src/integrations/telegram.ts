// Telegram delivery.
//
// Sends one message to a configured chat. If DAILY_BRIEF_DRY_RUN=true OR
// TELEGRAM_BOT_TOKEN is unset, prints to stdout instead.

import type { DeliveryResult } from "../types.js";

const MAX_TELEGRAM_MESSAGE = 4096;

export async function deliverToTelegram(opts: {
  botToken?: string;
  chatId?: string;
  text: string;
  dryRun: boolean;
}): Promise<DeliveryResult> {
  // Telegram has a 4096-char hard limit; trim with a clear marker rather than failing.
  let text = opts.text;
  if (text.length > MAX_TELEGRAM_MESSAGE) {
    const tail = "\n\n[truncated]";
    text = text.slice(0, MAX_TELEGRAM_MESSAGE - tail.length) + tail;
  }

  if (opts.dryRun || !opts.botToken || !opts.chatId) {
    console.log("─── DAILY BRIEF (stdout / dry-run) ───");
    console.log(text);
    console.log("─── end ───");
    return { ok: true, channel: "stdout" };
  }

  const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: opts.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, channel: "telegram", error: `telegram:http-${res.status}:${body.slice(0, 200)}` };
    }
    const json = (await res.json()) as { ok: boolean; result?: { message_id: number } };
    return { ok: json.ok, channel: "telegram", message_id: json.result?.message_id };
  } catch (err) {
    return { ok: false, channel: "telegram", error: `telegram:fetch-error:${(err as Error).message}` };
  }
}
