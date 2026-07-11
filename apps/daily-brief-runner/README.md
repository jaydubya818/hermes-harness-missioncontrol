# daily-brief-runner

Workflow #1 from [`hermes-harness-missioncontrol#11`](https://github.com/jaydubya818/hermes-harness-missioncontrol/issues/11). Closes [#2](https://github.com/jaydubya818/hermes-harness-missioncontrol/issues/2).

A cron-driven service that assembles a one-message daily brief (calendar + urgent emails + weather + interest-feed headlines) and delivers it to Telegram at 7am local.

## Status — scaffold

This PR ships the **structural scaffold** end-to-end. The workflow runs without any secrets — every integration falls back to a clearly-marked stub when its credentials are unset, and the brief still gets composed, formatted, and delivered (to stdout if no Telegram token).

What's real:
- Hono service with cron scheduler + manual-trigger HTTP API
- Telegram delivery (real API, with dry-run + stdout fallback)
- Weather (real OpenWeatherMap One Call API 3.0)
- RSS / Atom feed parser (regex-based, no extra deps)
- `formatBrief` pure formatter (HTML-escaped, Telegram-safe)
- vitest tests for `format.ts` and `runner.ts` (stub-mode end-to-end)
- State file at `data/daily-brief-state.json` records last run

What's stubbed (TODOs marked `TODO: Real implementation`):
- Google Calendar OAuth + events fetch — clear implementation note in `integrations/calendar.ts`
- Gmail OAuth + urgent-email query — clear implementation note in `integrations/gmail.ts`

The Google integrations are stubbed because the OAuth flow design (refresh-token vs service-account-with-DWD) needs Jay's decision before wiring.

## Running locally

```bash
# Stub mode (no secrets needed) — proves the pipeline end-to-end
pnpm --filter daily-brief-runner run run:once

# Long-running service with cron
cp apps/daily-brief-runner/.env.example apps/daily-brief-runner/.env
# edit .env with your secrets
pnpm --filter daily-brief-runner dev

# Trigger manually while running
curl -X POST http://localhost:4305/run
# Check last run
curl http://localhost:4305/last
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/healthz` | Liveness probe |
| POST | `/run` | Build + deliver a brief now |
| GET  | `/last` | Last run summary (date, warnings, delivery status) |

## Config

See `.env.example` for every env var. Key behavior notes:

- **Any missing source ≠ blocker** — the brief still delivers, with a single `⚠️` warning line at the bottom. Stub-mode demos this end-to-end.
- **`DAILY_BRIEF_DRY_RUN=true`** prints the brief to stdout instead of Telegram. Useful in CI and local dev.
- **`DAILY_BRIEF_CRON`** is validated at startup via `node-cron.validate`; bad expression = exit 1.

## Tests

```bash
pnpm --filter daily-brief-runner test
```

Two suites:
- `format.test.ts` — HTML escaping, empty states, warnings, length budget
- `runner.test.ts` — `loadConfig` parsing rules + `buildBrief` stub-mode end-to-end

## Architecture note

This app is an **operational workflow** (cron → multi-source fetch → format → deliver), not a coding mission (`plan/implement/test/review/deploy`). It does not currently integrate with the MissionControl mission/run/step contracts in `packages/contracts` — those are designed for governed code execution.

See `docs/plans/daily-brief-architecture-decision.md` for the discussion on whether to extend the contracts to cover operational workflows, or keep this as a standalone runner that the policy-engine can still govern via env-classification + Telegram channel approval gates.
