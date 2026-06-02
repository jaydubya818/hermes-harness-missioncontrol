# Hermes Agent v0.14 — operator quick reference

MissionControl (this repo) governs missions/runs/steps. **Hermes Agent** (`~/.hermes`, `hermes` CLI) is the thinking/execution runtime. They connect via contracts, not shared code.

## What was applied (2026-05-22)

- Updated Hermes Agent **v0.10.0 → v0.14.0** (`hermes update`)
- Migrated `~/.hermes/config.yaml` **v14 → v23** (`hermes doctor --fix`)
- Initialized Kanban DB (`hermes kanban init`)
- Enabled Kanban auto-decompose with profile routing: orchestrator `default`, default assignee `turing`
- Added `video` to CLI toolsets (video_gen still needs xAI OAuth)
- Synced bundled skills: `kanban-*`, `xurl`, `kanban-codex-lane`, codex, etc.
- Updated Agentic-KB: `wiki/personal/hermes-operating-context.md`

## Seven headline features

| # | Feature | Command / surface |
|---|---------|-------------------|
| 1 | Session memory search | Ask in chat; `session_search` tool |
| 2 | Background tasks | `/background` or `/bg` |
| 3 | xAI Grok OAuth | `hermes model` → xAI Grok OAuth |
| 4 | X post/search | xAI OAuth + `xurl auth oauth2` (user-only) |
| 5 | Codex CLI | OAuth logged in; `kanban-codex-lane` skill |
| 6 | AI video | `video` toolset; Grok Imagine via xAI OAuth |
| 7 | Auto Kanban | `hermes dashboard` → triage column |

## MissionControl ↔ Kanban bridge

Hermes Kanban handles **decomposition and specialist routing**. MissionControl handles **governed execution** (approvals, worktrees, audit). Use both in sequence.

### Recommended workflow

```text
1. Drop goal in Kanban triage (tenant=missioncontrol)
      hermes kanban create "Fix orchestrator orphan sweep" --triage --tenant missioncontrol

2. Gateway auto-decomposes (default profile orchestrates → alan/mira/turing children)

3. When a coding task is ready for governed execution, bridge it:
      HARNESS_OPERATOR_TOKEN=dev-secret pnpm kanban:mission -- --task-id t_abc123 --start

   Or bridge all ready tasks in the missioncontrol tenant:
      HARNESS_OPERATOR_TOKEN=dev-secret pnpm kanban:mission:ready

4. Track in harness console (http://localhost:5173) — mission gets a kanban comment with IDs
```

Prerequisites: orchestrator-api on `:4302`, `HARNESS_OPERATOR_TOKEN` set.

Env overrides: `ORCHESTRATOR_URL`, `HARNESS_PROJECT_ID`, `HARNESS_REPO_PATH`.

### Profile routing (configured)

| Profile | Role |
|---------|------|
| `default` | Kanban orchestrator (decompose, don't execute) |
| `alan` | Research |
| `mira` | Narrative / specs |
| `turing` | Implementation → best candidate for `--start` bridge |

---

## xAI Grok OAuth — step-by-step (do this in your terminal)

Requires SuperGrok or X Premium+.

```bash
# Option A — model picker (opens browser)
hermes model
# → xAI Grok OAuth (SuperGrok / X Premium+)
# → approve in browser → pick grok-4.3 (or latest)

# Option B — auth only
hermes auth add xai-oauth
```

Verify:

```bash
hermes doctor          # xAI OAuth should show ✓
hermes auth list       # should list xai-oauth
```

Then enable gated tools:

```bash
bash scripts/hermes-post-xai-oauth.sh
# or: hermes tools enable x_search video_gen --platform cli
```

Optional X posting (outside agent sessions — uses port **8081** to avoid LobsterBoard on 8080):

```bash
# After creating app at developer.x.com with redirect http://localhost:8081/callback
export X_CLIENT_ID='...'
export X_CLIENT_SECRET='...'
export X_USERNAME='your_handle'   # recommended
pnpm xurl:setup
```

If browser login succeeds but inference returns HTTP 403, fall back to `XAI_API_KEY` in `~/.hermes/.env` and `provider: xai` — see Hermes issue #26847.

---

## Remaining manual steps

1. **xAI OAuth** — see section above (blocks Grok orchestrator, `x_search`, `video_gen` until done).
2. **xurl** — `xurl auth oauth2` outside agent sessions (for posting, not just search).
3. **Gateway** — already running via launchd; restart if needed: `hermes gateway restart`.

When a mission needs governed execution, use this repo's orchestrator + worker. For portfolio recall, async `/background` work, or Kanban fan-out, use local Hermes Agent — then write outcomes back to Agentic-KB as usual.
