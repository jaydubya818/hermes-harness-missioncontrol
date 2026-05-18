# Morning Review Proposals — 2026-05-17

These proposals were surfaced by the weekly Morning Review synthesizer and routed
to this repo because they were tagged with the `hermes` target. They are
proposals only — review, refine, and decide whether to act.

---

## Audit current Hermes capabilities against 9-workflow blueprint

A detailed 9-workflow blueprint for an AI Chief of Staff was captured. Several
of these workflows overlap with existing or planned Hermes capabilities (daily
brief, Obsidian wiki, bookmark ingestion, meeting prep). Use this note as a gap
analysis checklist to identify what Hermes already does, what's partially
built, and what's missing.

**TODO**: Pull the 9-workflow blueprint note from the vault, map each workflow
to current Hermes capability (have / partial / missing), and file follow-up
issues for any meaningful gaps.

Source: `weekly_2026-05-17.md` candidate `163cbc49-d2c`

---

## Extract Asana's agent architecture patterns for Hermes design reference

The Asana JD reveals a mature agent platform architecture: separate teams for
Agent Orchestration, AI Chat, Teammates Platform (execution engine + capability
layer), and Teammates Experience (UI). They explicitly separate model
integration/rollout, proactive agent behavior, developer platform, and
quality/eval infrastructure as distinct ownership areas. This maps closely to
Hermes concerns.

**TODO**: Sketch how Hermes's current modules map onto Asana's decomposition
(orchestrator vs. capability vs. execution engine vs. eval). Identify any
module that's currently doing double duty across these layers and propose a
seam.

Source: `weekly_2026-05-17.md` candidate `d1e1c164-e41`

---

## Extract reusable RAG and citation-engine architecture patterns from PolicyCite memo

The PolicyCite memo contains specific, opinionated architectural guidance on
building citation-backed RAG systems: chunk by semantic section not token
count, store page/section metadata at ingest, return citations as structured
objects not inline text, build retrieval evaluation before scaling, use
confidence scoring with refusal thresholds. Directly relevant to Hermes and
any future retrieval-augmented agent work.

**TODO**: Cross-check current Hermes ingestion + retrieval against these five
patterns. For each pattern not yet followed, decide: adopt now, defer, or
intentionally diverge (with reason).

Source: `weekly_2026-05-17.md` candidate `996eb4c7-12d`
