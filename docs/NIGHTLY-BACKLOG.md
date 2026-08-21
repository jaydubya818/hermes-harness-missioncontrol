# Nightly backlog

Standing list for the scheduled nightly maintenance run. Items land here when
they are worth doing but out of scope for the night that found them, or when
they were investigated and deliberately ruled out. Check this file before
proposing work so the same ground is not re-covered every night.

## Open

- [ ] 2026-08-21 — Declare a Node `engines` range — nothing enforces the `.nvmrc: 22` pin; `.nvmrc` is advisory and only nvm-family tools read it, so a contributor on another major installs and builds with no signal. Deliberately not added tonight: pnpm's `engine-strict` would start failing installs on Node 24 machines, so this needs a decision on whether to warn or block first.
- [ ] 2026-08-21 — Backfill timestamps when hydrating legacy persisted runs — `hydrateState` validates run shape and calls `syncRunState`, but does not stamp a missing `run.updated_at` or step `started_at`/`completed_at`. Read models each paper over this with their own `?? ""` fallbacks, which is how the artifacts date-filter bug hid; normalizing once at hydration would remove the whole class.
- [ ] 2026-08-21 — Test the console's stateful components — `apps/harness-console/src/App.tsx` (879 lines) and `CommandPalette.tsx` have no tests. Only the pure helpers extracted into `api.ts` are covered, so filter/stream/palette wiring regressions are invisible to CI.

## Closed

- [x] 2026-08-21 → 2026-08-21 — `@types/node` on the `^24` line against a Node 22 runtime — the types described APIs the pinned runtime lacks, so `tsc` green-lit calls that throw. Pinned to `^22`; verified by a probe using `URLPattern` (a global only from Node 24) that typechecks under `@types/node` 24 and fails under 22.
- [x] 2026-08-21 → 2026-08-21 — Date filter hid records it was never given a range for — `inDateRange()` returned false for a timestampless record even with no `from`/`to`, dropping it from the unfiltered read model. Returns true when neither bound is supplied; regression test pins both halves.

## Checked, not applicable

- 2026-08-21 — Node 22 EOL / `.nvmrc` bump — Node 22 is Maintenance LTS through 2027-04-30. The pin is current and needs no action. Do not re-raise before 2027.
- 2026-08-21 — `VITE_OPERATOR_TOKEN` shipped to the browser — already mitigated and not a live finding. `vite.config.ts` aborts `vite build` while the variable is set (override: `ALLOW_OPERATOR_TOKEN_IN_BUNDLE=1`), the console prefers a `localStorage` token entered in Settings, and `worker-runtime` strips both `VITE_OPERATOR_TOKEN` and `HARNESS_OPERATOR_TOKEN` from spawned repo commands with no allow-list escape.
- 2026-08-21 — Root lint script — there is no `lint` script and no ESLint config anywhere in the workspace, root or per-package. Verification level V1 for this repo therefore means typecheck only, and typecheck requires `pnpm --filter './packages/**' build` first because packages resolve through `dist`.
- 2026-08-21 — Committed secrets — clean. `data/` is gitignored and no `data/*.json` state file, `.env`, or secret-shaped string has ever been added in the repo's 258-commit history. `vault/` holds only `agent_demo` / `proj_demo` fixtures, no real PII or captured message content.
- 2026-08-21 — Operator token in the SSE stream URL — `/api/events/stream?token=...` is a deliberate, documented tradeoff (`EventSource` cannot set an `Authorization` header) and the query token is compared with `timingSafeEqual` like the header path. Worth knowing that the token reaches the access log of any reverse proxy in front of the orchestrator, but it is not a defect to fix here.
