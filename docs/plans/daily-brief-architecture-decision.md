# Daily Brief — Architectural Decision (deferred)

## Question

`apps/daily-brief-runner` ships as a standalone cron-driven service. The rest of the workspace is organized around **coding missions** (StepKind = `plan | implement | test | review | deploy`) governed by MissionControl contracts. The Daily Brief is an **operational workflow** (cron → fetch → format → deliver) that does not map cleanly onto the existing StepKind enum.

How should operational workflows fit?

## Three viable shapes

### A. Standalone app, no contract integration (what this PR ships)

- `apps/daily-brief-runner` is its own service with its own cron + state.
- Doesn't import from `packages/contracts`.
- Can still be policy-governed via env-classification + secret-vault, but operates outside the mission/run/step lifecycle.
- **Pros:** simplest; ships in one PR; doesn't ripple into contracts/orchestrator/worker-runtime.
- **Cons:** operational workflows multiply (9 are planned). 9 bespoke runners is a maintenance trap. No unified audit trail across coding + operational work.

### B. Extend StepKind to cover operational steps

- Add new StepKind values: `fetch | format | deliver` (or `source | transform | sink`).
- Daily Brief becomes a Mission with 4 steps; each runs in worker-runtime; full audit trail.
- **Pros:** one execution model for everything; reuses approvals, eval, audit.
- **Cons:** big change. The current StepKind enum is tuned for code (review = code review, deploy = ship to staging). Squeezing "send a Telegram message" into the same model conflates fundamentally different operations.

### C. Add a sibling MissionKind: coding vs. operational

- Introduce `MissionKind = coding | operational` at the contract level.
- Operational missions get their own StepKind enum (`fetch | format | deliver | summarize`).
- Same orchestrator-api, same worker-runtime; different step handlers.
- **Pros:** clean separation; both use MissionControl primitives (approvals, policy, audit, eval).
- **Cons:** medium contract change. Schema versioning matters.

## Recommendation

**Ship A now, decide between B and C after building 2 more operational workflows.** Once Humanizer (#6) and Bookmark Inbox (#7) exist as standalone apps, the duplication pressure will tell us whether B or C is right. Today there's not enough signal — premature contract design.

When the decision lands, migration is mechanical: each runner already separates `loadConfig + buildBrief + deliverToTelegram` cleanly. Each becomes a Mission with steps; the integrations become step handlers in `worker-runtime`.

## What this PR commits to

- Operational workflows live in `apps/*` (not `packages/`).
- Every operational workflow follows the same shape: `loadConfig` → parallel source fetches that never throw → pure formatter → guarded delivery → state file with last-run summary.
- Telegram is the default delivery channel (matches the Apple Note source).
- Stub-mode-runs-end-to-end is a hard requirement (validated in `runner.test.ts`).

## Open questions

- **Cron supervision:** today `node-cron` runs in-process. If the service crashes, no run. Worth replacing with a system-level scheduler (launchd / systemd) once we have >1 operational workflow.
- **Secret storage:** `.env` is fine for development. Production needs a vault — and that's a separate cross-cutting decision (1Password CLI? AWS Secrets Manager? Keychain via a Hermes capability?).
- **Multi-channel delivery:** Apple Note source says Telegram. Some workflows (Customer Support Cron #8) need Discord. The delivery layer should generalize before workflow #4 lands.
