# Hermes / Obsidian Operating System Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn the recent Apple Notes/X link review into concrete Hermes + Obsidian operating-system upgrades: reliable X extraction, durable review packets, workflow mining, and receipt-first execution.

**Architecture:** Keep Hermes as the orchestrator, Obsidian as the durable knowledge source, Morning Review as the scheduled intake/review loop, and MissionControl/Kanban as the durable state layer for long work. Avoid a swarm unless a single scoped loop has already proven useful.

**Tech Stack:** Hermes Agent, Obsidian Markdown vault, MorningReview artifacts, Hermes cron, X API/x-cli, web-extract skill fallbacks, MissionControl/Kanban.

---

## Evidence Opened / Reviewed

X/Twitter extraction was re-enabled with X API credentials and `x-cli`; 15 unique status links from the relevant Apple Notes / daily-review corpus were opened via `x-cli tweet get`.

2026-06-01 continuation review:
- Apple Notes 24h window extracted 6 notes and 8 unique URLs.
- Morning Review fetched all 8 links with 0 fetch failures.
- Highest-signal source: CyrilXBT long-form article, “How to Connect Obsidian + Hermes Agent Into One System That Thinks, Remembers, and Runs Your Life.”
- Adapted decision: preserve the operating routines, but do not blindly point Filesystem MCP at Jay's personal vault. Jay's current safer split remains personal vault as human-readable strategy/business layer, Agentic-KB as engineering brain, Morning Review as intake/review loop, and Hermes as synthesis/orchestration layer with explicit receipts.
- New Obsidian resource created: `/Users/jaywest/Documents/Obsidian Vault/08 - Resources/2026-06-01 Apple Notes Hermes Obsidian System Review.md`.

2026-06-04 72-hour continuation review:
- Apple Notes 72h window extracted 14 notes and 32 unique X URLs.
- `x_search` was blocked by xAI/Grok spending-limit status; `x-cli tweet get` fetched all 32 links successfully and is the verified fallback path for this setup.
- Applied setup deltas: second-brain six-layer gate, Kanban/MissionControl for 3+ step work, Dreaming/proposal inbox as review packets, skill/tool audit before adding automation, and personal-vault writes still gated by allowlists/rollback/receipts.
- New Obsidian resource created: `/Users/jaywest/Documents/Obsidian Vault/08 - Resources/2026-06-04 Apple Notes Hermes Obsidian Second Brain Review.md`.
- New Agentic-KB receipt created: `/Users/jaywest/Agentic-KB/wiki/personal/hermes-apple-notes-setup-review-2026-06-04.md`.

High-signal sources:
- `2053231239721885918` — Addy Osmani, "Agent Harness Engineering"
- `2042925773300908103` — Garry Tan, "Thin Harness, Fat Skills"
- `2053127519872614419` — Garry Tan, "Meta-Meta-Prompting"
- `2053095235471761714` — CyrilXBT, "Obsidian + Claude Code = 24/7 personal operating system"
- `2053291096076145097` — CyrilXBT, "Obsidian Vault Into a Full Business Operating System"
- `2056924424838815824` — CyrilXBT, "Obsidian Into a Personal Operating System That Never Breaks Down"
- `2057017304144298383` — Indu Tripathi, "276 Use Cases of Hermes Agent"
- `2053308681299616125` — Nate Herk, "From Zero to Ultimate Hermes Agent Army"
- `2053874292199170132` — MD + HTML should coexist in a human-readable KB

Applied immediately:
- X app credentials stored in `/Users/jaywest/.hermes/.env` without printing values.
- `/Users/jaywest/.config/x-cli/.env` symlinked to Hermes env.
- `x-cli` installed and read access verified.
- Existing Hermes config verified: `model.default=gpt-5.5`, `delegation.model=gpt-5.5`, `goals.max_turns=30`.
- Existing Obsidian resource/wikis verified:
  - `/Users/jaywest/Documents/Obsidian Vault/08 - Resources/2026-05-30 Apple Notes Hermes Obsidian Link Review.md`
  - `/Users/jaywest/Documents/Obsidian Vault/Wiki/Hermes.md`
  - `/Users/jaywest/Documents/Obsidian Vault/Wiki/Obsidian-Vault.md`
  - `/Users/jaywest/Documents/Obsidian Vault/Wiki/Pi-Agent.md`
  - `/Users/jaywest/Documents/Obsidian Vault/Wiki/Morning-Review-System.md`
- Monthly workflow-mining cron created: `monthly-workflow-mining-review` (`3ea7bd8aa8c6`).

---

## Task 1: Locate the Morning Review source-of-truth code

**Objective:** Find the executable source that generates `/Users/jaywest/MorningReview/reports/*` so social-link extraction can be fixed at the source rather than patched in reports.

**Files:**
- Inspect: `/Users/jaywest/MorningReview/`
- Search candidates: `/Users/jaywest/projects/`, `/Users/jaywest/Agentic-KB/`, `/Users/jaywest/.hermes/cron/`, `/Users/jaywest/.hermes/scripts/`
- Create/Modify: source files only after ownership is identified

**Step 1: Identify launch path**

Run:
```bash
launchctl list | grep -i morning || true
```

Expected: Shows the launch agent or no result.

**Step 2: Inspect cron/scripts references**

Run targeted searches for `MorningReview`, `morning-review`, and `2026-05-30-morning-review` across known automation paths.

Expected: One script or launch agent owns the daily run.

**Step 3: Record source owner**

Update this plan with the exact source path once found.

**Verification:** You can point to the script/module that writes `/Users/jaywest/MorningReview/reports/YYYY-MM-DD-morning-review.md`.

---

## Task 2: Add a regression fixture for social/X Apple Notes

**Objective:** Reproduce the 2026-05-30 failure where automated history said `0 links` while manual review found 31.

**Files:**
- Create: test fixture in the Morning Review source repo, e.g. `tests/fixtures/apple_notes/social_x_note.html`
- Create/Modify: test file for note extraction, e.g. `tests/test_apple_notes_link_extraction.py`

**Step 1: Build a minimal fixture**

Fixture should include:
- An Apple Notes-style body
- `https://x.com/<handle>/status/<id>?s=12&t=...`
- One image/media-only block if supported by the source extractor
- One non-X URL to ensure generic links still work

**Step 2: Write failing test**

Expected assertion:
```python
assert extracted.links == [
    "https://x.com/example/status/2053231239721885918?s=12&t=fixture"
]
assert extracted.link_count == 1
```

**Step 3: Run test to verify RED**

Run the narrowest test command for the source repo.

Expected: FAIL before extractor fix.

---

## Task 3: Implement a normalized social-link extractor

**Objective:** Extract X/Twitter links from Apple Notes HTML/text reliably, including trailing punctuation and `twitter.com` aliases.

**Files:**
- Modify: source extractor module identified in Task 1
- Modify: tests from Task 2

**Implementation requirements:**
- Match `https://x.com/<handle>/status/<id>` and `https://twitter.com/<handle>/status/<id>`.
- Strip trailing punctuation: `.`, `,`, backticks, `)`, `]`.
- Normalize `twitter.com` to `x.com` only after preserving the status ID.
- De-duplicate by status ID.
- Preserve original source note title and modified timestamp in the review packet.

**Verification:**
- The regression test from Task 2 passes.
- A dry run against the 2026-05-30 Apple Notes export reports nonzero links.

---

## Task 4: Add X extraction adapter with ordered fallbacks

**Objective:** Make link review resilient when `x_search` is unavailable or rate/credit limited.

**Files:**
- Modify: web/content extraction adapter in Morning Review source
- Already updated skill reference: `web-extract` skill

**Fallback order:**
1. `x-cli -j tweet get <url>` when X API credentials exist.
2. `https://api.fxtwitter.com/status/<id>` for tweet text/media/long-form article blocks.
3. `https://r.jina.ai/http://x.com/<handle>/status/<id>` for readable markdown.
4. `https://cdn.syndication.twimg.com/tweet-result?id=<id>&lang=en` for tweet text only.
5. Mark as unavailable with a receipt; do not silently count as crawled.

**Verification:**
- At least one article-title-only tweet returns title metadata.
- At least one normal text tweet returns tweet text.
- Unavailable/deleted tweets are represented as explicit failures with status and reason.

---

## Task 5: Standardize review packets as receipts

**Objective:** Every Morning Review run should leave enough evidence for Hermes to trust but verify it.

**Files:**
- Modify: report writer in Morning Review source
- Output: `/Users/jaywest/MorningReview/reports/YYYY-MM-DD-morning-review.md`
- Output: `/Users/jaywest/MorningReview/reports/YYYY-MM-DD-actions.json`

**Packet schema:**
- Sources scanned
- Notes reviewed with modified timestamps
- Links extracted with normalized IDs
- Links successfully opened
- Links failed with reason
- Principles extracted
- Decisions: applied / rejected / needs human review
- Files changed
- Verification commands and results
- Residual risks

**Verification:**
- 2026-05-30-style run cannot report `Links crawled: 0` if X links were extracted but failed to open; it must distinguish `extracted`, `opened`, and `failed`.

---

## Task 6: Keep Obsidian as canonical synthesis, not a dump

**Objective:** Continue the applied standard from the link review: promote extracted principles, not raw social content.

**Status:** Active / applied again on 2026-06-01.

**2026-06-01 applied evidence:**
- Created `/Users/jaywest/Documents/Obsidian Vault/08 - Resources/2026-06-01 Apple Notes Hermes Obsidian System Review.md` from 6 recent notes / 8 fetched links.
- Updated `/Users/jaywest/Documents/Obsidian Vault/Wiki/Hermes.md` with the adapted Hermes + Obsidian model.
- Updated `/Users/jaywest/Documents/Obsidian Vault/Wiki/Obsidian-Vault.md` with the latest capture/review standard.
- Preserved seven vault-aware routines as capabilities, not a forced folder restructure: morning brief, inbox processor, project health, connection finder, weekly synthesis, research converter, thinking partner.

**Files:**
- Modify only when new durable principles exist:
  - `/Users/jaywest/Documents/Obsidian Vault/Wiki/Hermes.md`
  - `/Users/jaywest/Documents/Obsidian Vault/Wiki/Obsidian-Vault.md`
  - `/Users/jaywest/Documents/Obsidian Vault/Wiki/Pi-Agent.md`
  - `/Users/jaywest/Documents/Obsidian Vault/Wiki/Morning-Review-System.md`
- Resource notes under `/Users/jaywest/Documents/Obsidian Vault/08 - Resources/`

**Rules:**
- Every promoted finding links to at least one existing wiki/project note.
- Raw X posts stay in source/review notes unless they become durable principles.
- If a page grows too large, create a resource note and link it rather than expanding root wiki pages indefinitely.

**Verification:**
- New promoted notes have frontmatter, tags, and at least one wikilink.

---

## Task 7: Use MissionControl/Kanban for multi-step implementation

**Objective:** Prevent long Hermes/Hermes+Pi tasks from disappearing into one chat thread.

**Files:**
- MissionControl/Kanban board/task store in canonical Hermes workspace once current board path is confirmed.

**Rules:**
- Any implementation with 3+ tasks gets a durable task/board entry.
- Each worker leaves: objective, files changed, verification, residual risk.
- Hermes final answer is synthesis, not raw logs.

**Verification:**
- This plan’s execution has a board/task entry before code changes begin.

---

## Task 8: Monthly workflow-mining automation

**Objective:** Convert repeated manual loops into skills, subagents, cron jobs, or Obsidian operating notes.

**Status:** Applied.

**Created cron:**
- Name: `monthly-workflow-mining-review`
- ID: `3ea7bd8aa8c6`
- Schedule: `0 9 1 * *`
- Model: OpenRouter `anthropic/claude-sonnet-4`
- Output: concise review packet to origin

**Verification:**
- `hermes cron list` includes the job and next run is `2026-06-01T09:00:00-07:00`.

---

## Acceptance Criteria

- X credentials are configured without leaking values.
- X read path works through `x-cli`.
- Hermes config reflects the intended model and `/goal` behavior.
- Obsidian resource and wiki notes preserve the link-review principles.
- A monthly workflow-mining loop exists.
- Morning Review has a concrete code plan to fix the 0-link social extraction failure.
- Future completion claims include receipts: changed files, verification, residual risk.
