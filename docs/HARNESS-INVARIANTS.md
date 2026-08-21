# Harness invariants

This repo is a supervisor/worker control plane: `orchestrator-api` decides
what runs, `worker-runtime` does the work, `eval-api` and `memory-api` are
sidecars, `harness-console` is the operator surface.

The five invariants below come from the "agent proposes, code disposes"
pattern (KB: `patterns/pattern-code-owns-control-plane`). They are the
checkable properties a harness either has or does not have. This file
records where this repo actually stands against each one, with citations, so
a later pass diffs against it instead of re-deriving it.

Status values: **satisfied**, **partial**, **violated**.
Last audited: 2026-08-21.

Items marked "fixed on 2026-08-21" land through the
`nightly/2026-08-21-improvements` branch and describe that branch's state,
not `main`'s, until it merges.

---

## 1. Deterministic code owns the graph — satisfied

Code decides what phase runs next, how retries happen, and what counts as
done. The worker has no input into any of it.

- `packages/workflow-engine/src/index.ts` — `WORKFLOW_LIBRARY` declares the
  phase sequence statically (`bugfix`: plan, implement, test, review, deploy).
- `transitionCurrentStep()` is the only thing that moves
  `run.current_step_index`, and it is called only from the exported
  `markCurrentStep*` / `retryCurrentStep` / `cancelCurrentStep` helpers.
- "Done" is code-decided: `transitionCurrentStep()` sets
  `run.status = "completed"` only when `nextIndex >= run.steps.length`.
- `apps/orchestrator-api/src/index.ts`, `POST /api/runs/:id/execute-current`
  — the orchestrator selects the step with `getCurrentStep(run)`, builds the
  request itself, and advances only after its own gate.
- `toTaskExecutionResult()` derives `recommended_next_step` from
  `run.steps[stepIndex + 1]?.kind`, i.e. from the orchestrator's own graph.
  The worker never gets to nominate the next phase.

## 2. Agents are bounded nodes that do not self-certify — partial

**Bounded: yes.** `ExecutionEnvelope`
(`packages/contracts/src/models.ts`) pins the worktree, repo scope, allowed
tools and actions, timeout and resource budget. The worker re-validates it
rather than trusting the caller (`apps/worker-runtime/src/index.ts`,
`validateEnvelope`) and refuses a step whose `actionForKind()` is not in
`allowed_actions`. `enforceBudget()` rejects a result over `max_artifacts`.

**Sequencing: not controlled by the agent.** See invariant 1.

**Self-certification: still present.** The worker's `success: boolean` is
taken at face value — `if (!execution.success) await failRun(...)`, and
otherwise the dispatch proceeds to the policy gate. Nothing cross-checks
that claim against the evidence the worker itself attached: the test-report
artifact carries `metadata.exit_code`, and no code asserts
`success === (exit_code === 0)`.

`assertWorkerExecutionShape()` validates `summary`, every `artifacts[]`
entry's `type`/`uri`, and that `step_events` is an array when present. It
does not validate `success` or `execution_id`.

This is a design gap rather than a live defect: both services are authored
together and `runTests()` derives `success` from the real exit code. It is
recorded in the backlog rather than patched, because closing it properly
means deciding what evidence each step kind must produce.

## 3. Typed JSON envelopes are the only way context crosses a boundary — partial

**Outbound (orchestrator to worker): clean.** `StepExecutionRequest` and
`ExecutionEnvelope` are the only channel. `buildStepExecutionRequest()`
constructs them, and `relativeWithin()` confines `worktree_path` and
`output_dir` to the orchestrator's own roots before dispatch.

**Provenance pinning: clean.** `recordExternalEvent()` spreads the worker's
event and then overwrites `mission_id`/`run_id`/`step_id`/`execution_id`
with the orchestrator's own `DispatchScope` and clears `actor`. A worker
response cannot attribute events to another mission, and cannot forge an
operator action.

**Inbound leak.** The worker's `/api/execute-step` reply is built as
`c.json({ run_id, mission_id, execution_id, step_id, ...workspace!, ...result, step_events })`.
Spreading the whole `WorkspaceContext` sends the echoed `envelope` and
absolute host paths (`workdir`, `repoWorkspace`, `worktreePath`) back across
the boundary. The orchestrator's `WorkerExecution` type declares only some
of them, so fields cross that no type on either side describes. Backlogged.

**Closed on 2026-08-21.** Confidence used to cross the *inner* boundary —
orchestrator to eval scorer — only inside a natural-language payload. See
invariant 4 and `packages/eval-core/src/scorer.ts`.

## 4. Gates replace the agent's own claim of completion — partial

A real, code-owned gate exists: `evaluateStepPolicy()` in
`packages/policy-engine/src/index.ts`, called from the dispatch handler
before the step is allowed to complete.

What it genuinely checks, independent of anything the worker says:

- `review-needs-artifact` — a `review` step with zero artifacts is blocked
  outright (`allowed: false`), and the orchestrator fails the run. The
  worker cannot talk its way past this.
- `approval-high-risk` — `deploy` kind or `risk: "high"` always requires
  operator approval.
- Non-finite or out-of-range confidence is clamped to a fail-safe 0.5, which
  is below the 0.6 approval threshold, so a malformed confidence escalates
  to a human rather than silently passing.

What it does not check: the gate's inputs are `kind`, `risk`,
`artifactCount` and the worker's own `confidence`. It verifies *that*
artifacts exist, never *what they say*. There is no acceptance criterion
that reads the test-report's `exit_code`, so "the tests passed" remains the
worker's claim, checked only for plausibility. This is the same gap as
invariant 2 seen from the gate side.

**Fixed on 2026-08-21** (`fix(eval): score the confidence the worker
reported...`): the worker reports a structured per-execution `confidence`,
and the gate consumed it correctly, but it stopped there. The step recorded
only `execution.summary` as free-text `notes`, and the eval scorer recovered
a confidence by regex-scraping those notes
(`step.notes.match(/confidence[:\s]+([0-9.]+)/i)`). The worker's summaries
name no number except on the approval path, so on every normal completed
path the scrape missed and `stepConfidence()` substituted a state constant
of 0.85 — publishing an `EvalRecord.confidence`, and an
`average_confidence` aggregate, that no worker had produced. The value now
travels as `WorkflowRunStep.worker_confidence`, a structured field outside
the prose. An absent confidence stays absent rather than recording the
gate's 0.5 substitution, and is logged at the hop, so the loss is
measurable. (KB: `syntheses/synthesis-telephone-game-per-claim-confidence`.)

## 5. Every event streams into a trace store live — satisfied

- `recordEvent()` in `apps/orchestrator-api/src/index.ts` appends to
  `state.events` and fans out to SSE subscribers in the same call, so a run
  is inspectable while it runs rather than reconstructed afterwards.
- `GET /api/events/stream` replays history and then streams live, with
  per-subscriber queues, heartbeats and subscriber caps.
- `CANONICAL_EVENT_TYPES` (`packages/contracts/src/events.ts`) is a runtime
  array, not just a type union, and is the single source of truth the
  orchestrator validates ingested events against.
- Every event carries `mission_id` / `run_id` / `step_id` / `execution_id`,
  so the trace is queryable phase-by-phase.
- The trace is defended against malformed external input rather than
  assumed well-formed: `normalizeEventId()` (rejects CR/LF injection into
  SSE frames), `normalizeEventTimestamp()`, sequence validation, and
  `processed_event_ids` replay dedupe.

---

## Retries: cheap corrections, not cold restarts — satisfied at step granularity

The pattern's stated trade-off is that a retry should resume the live
session rather than start over.

- `retryCurrentStep()` keeps the mission, the run, all prior steps and their
  artifacts, and the entire event history. It re-runs only the current step
  under a fresh execution id.
- `requestWorkerAbort()` kills the superseded child process, and the
  stale-dispatch guard (`isDispatchStale()` / `discardStaleDispatch()`)
  stops the dead execution's result from landing on a step that has moved
  on.
- The git worktree and the bootstrap cache are keyed by run, so a retry
  reuses the hydrated workspace instead of re-cloning and reinstalling
  (`bootstrapWorkspaceDependencies()`, `sandbox_cache`).

The limit: there is no checkpoint *inside* a step, so a step that failed
near the end redoes all of it. Resumption granularity is the step, which is
what the phase decomposition is for.

---

## Notes for the next pass

- `runCmd`'s `failure_kind: "timed_out"` cannot fire for the test step: the
  outer envelope race in `/api/execute-step` uses the same
  `timeout_seconds` and always wins, producing an `execution.timeout` error
  envelope instead. The classification still matters for the `runCmd` calls
  that use `DEFAULT_CMD_TIMEOUT_MS` (the git invocations in plan/review).
- Verification for this repo is: `pnpm --filter './packages/**' build`
  first (packages resolve through `dist`, so typecheck and tests are
  meaningless without it), then `pnpm -r typecheck`, `pnpm -r test`,
  `pnpm -r build`. There is no lint script and no ESLint config anywhere in
  the workspace.
