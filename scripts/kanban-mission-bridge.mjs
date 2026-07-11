#!/usr/bin/env node
/**
 * Bridge a Hermes Kanban task → MissionControl mission.
 *
 * Usage:
 *   node scripts/kanban-mission-bridge.mjs --task-id t_abc123 [--start] [--project proj_demo] [--repo /path/to/repo]
 *   node scripts/kanban-mission-bridge.mjs --from-ready [--tenant missioncontrol] [--start]
 *
 * Env:
 *   ORCHESTRATOR_URL     default http://localhost:4302
 *   HARNESS_OPERATOR_TOKEN  bearer token for mutating APIs (required)
 */

import { spawnSync } from "node:child_process";

const ORCH = process.env.ORCHESTRATOR_URL ?? "http://localhost:4302";
const TOKEN = process.env.HARNESS_OPERATOR_TOKEN ?? "";
const DEFAULT_PROJECT = process.env.HARNESS_PROJECT_ID ?? "proj_demo";
const DEFAULT_REPO = process.env.HARNESS_REPO_PATH ?? "/Users/jaywest/hermes-harness-missioncontrol";

function usage() {
  console.error(`Usage:
  kanban-mission-bridge.mjs --task-id <id> [--start] [--project <id>] [--repo <path>]
  kanban-mission-bridge.mjs --from-ready [--tenant missioncontrol] [--start] [--project <id>] [--repo <path>]`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { start: false, tenant: "missioncontrol" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task-id") opts.taskId = argv[++i];
    else if (a === "--from-ready") opts.fromReady = true;
    else if (a === "--tenant") opts.tenant = argv[++i];
    else if (a === "--start") opts.start = true;
    else if (a === "--project") opts.projectId = argv[++i];
    else if (a === "--repo") opts.repoPath = argv[++i];
    else if (a === "--help" || a === "-h") usage();
    else {
      console.error(`Unknown arg: ${a}`);
      usage();
    }
  }
  if (!opts.taskId && !opts.fromReady) usage();
  opts.projectId ??= DEFAULT_PROJECT;
  opts.repoPath ??= DEFAULT_REPO;
  return opts;
}

function hermesKanban(args) {
  const r = spawnSync("hermes", ["kanban", ...args, "--json"], {
    encoding: "utf8",
    env: process.env
  });
  if (r.status !== 0) {
    throw new Error(r.stderr?.trim() || r.stdout?.trim() || `hermes kanban failed: ${args.join(" ")}`);
  }
  return JSON.parse(r.stdout);
}

async function orch(path, init = {}) {
  if (!TOKEN) throw new Error("HARNESS_OPERATOR_TOKEN is required");
  const res = await fetch(`${ORCH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(typeof body === "object" && body?.error ? body.error : `${res.status} ${text}`);
  }
  return body;
}

function listReadyTasks(tenant) {
  const args = ["list", "--status", "ready"];
  if (tenant) args.push("--tenant", tenant);
  const data = hermesKanban(args);
  return Array.isArray(data) ? data : (data.tasks ?? []);
}

function showTask(taskId) {
  return hermesKanban(["show", taskId]);
}

function commentTask(taskId, text) {
  spawnSync("hermes", ["kanban", "comment", taskId, text], { stdio: "inherit" });
}

async function bridgeTask(task, opts) {
  const t = task.task ?? task;
  const title = t.title ?? "Kanban task";
  const objective = [t.body, t.result?.summary].filter(Boolean).join("\n\n") || title;

  const mission = await orch("/api/missions", {
    method: "POST",
    body: JSON.stringify({
      title: `[kanban:${t.id}] ${title}`,
      objective,
      project_id: opts.projectId,
      workflow_id: "bugfix",
      repo_path: opts.repoPath,
      profile_ref: t.assignee ?? undefined
    })
  });

  let run = null;
  if (opts.start) {
    run = await orch(`/api/missions/${mission.mission_id}/start`, { method: "POST" });
  }

  const link = run
    ? `MissionControl mission ${mission.mission_id} / run ${run.run_id} created and started. Console: http://localhost:5173`
    : `MissionControl mission ${mission.mission_id} created (not started). Start via harness console or POST /api/missions/${mission.mission_id}/start`;

  commentTask(t.id, link);
  console.log(JSON.stringify({ kanban_task_id: t.id, mission_id: mission.mission_id, run_id: run?.run_id ?? null }, null, 2));
  return { mission, run };
}

async function main() {
  const opts = parseArgs(process.argv);
  const tasks = opts.fromReady
    ? listReadyTasks(opts.tenant)
    : [showTask(opts.taskId)];

  if (!tasks.length) {
    console.log("No tasks to bridge.");
    return;
  }

  for (const raw of tasks) {
    await bridgeTask(raw, opts);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
