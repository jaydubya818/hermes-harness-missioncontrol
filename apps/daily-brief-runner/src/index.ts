// Daily Brief runner — Hono service with cron scheduler + manual-trigger HTTP endpoint.
//
// Endpoints:
//   GET  /healthz                  → 200 ok
//   POST /run                      → trigger one brief now; returns { brief, delivery }
//   GET  /last                     → last run summary (date_local, warnings, delivery.ok)
//
// Schedule: cron expression from DAILY_BRIEF_CRON env (default "0 7 * * *", local TZ).

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import cron from "node-cron";
import { resolve } from "node:path";
import { loadJsonFile, saveJsonFile } from "@hermes-harness-with-missioncontrol/state-store";
import { loadConfig, runOnce } from "./runner.js";

const app = new Hono();
app.use("/*", cors());

const STATE_PATH = process.env.DAILY_BRIEF_STATE
  ?? resolve(process.cwd(), "../../data/daily-brief-state.json");

type LastRun = {
  ran_at: string;
  date_local: string;
  warnings: string[];
  delivery_ok: boolean;
  delivery_channel: string;
  delivery_error?: string;
};

async function loadLast(): Promise<LastRun | null> {
  return await loadJsonFile<LastRun | null>(STATE_PATH, null);
}

async function saveLast(last: LastRun): Promise<void> {
  await saveJsonFile(STATE_PATH, last);
}

async function execute(label: string): Promise<LastRun> {
  console.log(`[daily-brief] ${label} running…`);
  const config = loadConfig();
  const { brief, delivery } = await runOnce(config);
  const last: LastRun = {
    ran_at: brief.generated_at,
    date_local: brief.date_local,
    warnings: brief.warnings,
    delivery_ok: delivery.ok,
    delivery_channel: delivery.channel,
    delivery_error: delivery.error,
  };
  await saveLast(last);
  console.log(`[daily-brief] done. delivery=${delivery.channel} ok=${delivery.ok} warnings=${brief.warnings.length}`);
  return last;
}

app.get("/healthz", (c) => c.text("ok"));

app.post("/run", async (c) => {
  const last = await execute("manual-trigger");
  return c.json(last);
});

app.get("/last", async (c) => {
  const last = await loadLast();
  return c.json(last ?? { ran_at: null });
});

const port = Number(process.env.PORT) || 4305;
const cronExpr = process.env.DAILY_BRIEF_CRON || "0 7 * * *";
const tz = process.env.DAILY_BRIEF_TZ || "America/Los_Angeles";

if (!cron.validate(cronExpr)) {
  console.error(`[daily-brief] invalid DAILY_BRIEF_CRON: ${cronExpr}`);
  process.exit(1);
}

cron.schedule(
  cronExpr,
  () => {
    execute(`cron@${cronExpr}`).catch((err) => {
      console.error("[daily-brief] cron run failed:", err);
    });
  },
  { timezone: tz },
);

console.log(`[daily-brief] listening on :${port} · cron="${cronExpr}" tz=${tz}`);
serve({ fetch: app.fetch, port });
