# AGENTS.md

Guidance for coding agents working in this repository.

## What this repo is

TypeScript MissionControl control plane for governed Hermes execution: mission/run/step
lifecycle, policy and approval gates, execution envelopes, artifact/audit persistence,
eval recording, and an operator console. Hermes itself lives elsewhere; the boundary is
defined by contracts (`packages/contracts`), not imports. See `README.md` and
`docs/architecture/` for the full picture.

## Layout

- `apps/orchestrator-api` (4302) — lifecycle, approvals, read models, SSE event stream
- `apps/worker-runtime` (4304) — governed execution, worktree isolation, deploy planning
- `apps/memory-api` (4301) — Agentic-KB vault read/write, writeback, promotion
- `apps/eval-api` (4303) — eval records and summaries
- `apps/harness-console` (5173) — operator UI (React + SWR + Vite)
- `packages/*` — contracts, workflow-engine, policy-engine, state-store, shared-types,
  memory-runtime, eval-core, ui-kit
- `vault/agentic-kb` — markdown knowledge vault used by memory-api
- `data/` (gitignored) — local JSON state, worker runs, worktrees

## Build and test

```bash
pnpm install --frozen-lockfile
pnpm --filter './packages/**' build   # REQUIRED before tests: apps resolve workspace deps from dist/
pnpm -r test                          # vitest across all packages/apps
pnpm typecheck                        # builds packages first, then tsc everywhere
```

Running `pnpm -r test` on a clean checkout without building packages first fails with
"Failed to resolve entry for package @hermes-harness-with-missioncontrol/state-store".

## Conventions and invariants

- Conventional commits: `fix:`, `feat:`, `test:`, `docs:`, `chore:`, `perf:` with scope
  (e.g. `fix(orchestrator-api): ...`).
- Every service binds loopback (`127.0.0.1`) by default and honors
  `HARNESS_OPERATOR_TOKEN` bearer auth plus a CORS allowlist. Do not weaken these
  defaults; set `HOST`/`CORS_ALLOWED_ORIGINS` explicitly to opt into wider exposure.
- Validate request bodies at the route (types, closed unions, safe ids) — malformed
  input must 400, never 500. Path inputs go through the existing containment helpers
  (`safeWikiPath`, `relativeWithin`, `safeVaultPath`); never `join` user input to a root
  without one.
- Anything crossing a service boundary is untrusted, including worker `step_events`.
  `normalizeEventRecord` is the choke point: event ids must stay plain bounded tokens
  (they are echoed into the SSE `id:` line), timestamps must be coerced to strings
  (hydration sorts them with `localeCompare`), and mission/run/step/execution ids are
  re-scoped to the dispatch while `actor` is cleared (worker events are never operator
  actions, and `actor` drives audit attribution and the actor filters). Keep new
  ingestion paths behind it.
- The canonical event taxonomy lives in `packages/contracts` as `CANONICAL_EVENT_TYPES`;
  add new types there, not in per-service copies.
- Markdown vault files are parsed line-anchored ("- " entries, "### " candidates,
  "## " log sections); user-supplied text is inlined/escaped before it is appended.
  Keep new writers consistent with these formats.
- State files are JSON written atomically via `packages/state-store`; read-modify-write
  appends are serialized through module-level queues. Follow those patterns for any new
  persistence.
- Never commit secrets. Tokens come from env (`HARNESS_OPERATOR_TOKEN`,
  `VITE_OPERATOR_TOKEN`); there are no committed credentials and it must stay that way.
- Tests live next to sources as `src/*.test.ts` using vitest + `app.request(...)`
  against the exported Hono `app` (no live servers). Match that style.
