import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const app = new Hono();
const runsRoot = process.env.WORKER_RUNTIME_ROOT ?? resolve(process.cwd(), "../../data/worker-runs");

async function runStep(kind: string, workdir: string) {
  await mkdir(workdir, { recursive: true });
  if (kind === "plan") {
    const content = "Plan: inspect, patch, test, review, deploy.";
    await writeFile(join(workdir, "plan.md"), content, "utf8");
    return {
      summary: "Generated implementation plan",
      confidence: 0.93,
      artifacts: [{ type: "plan", uri: `file://${join(workdir, 'plan.md')}`, content }]
    };
  }
  if (kind === "implement") {
    const patch = "diff --git a/src/app.ts b/src/app.ts\n+ // bounded autonomy patch\n";
    await writeFile(join(workdir, "patch.diff"), patch, "utf8");
    return {
      summary: "Created synthetic patch artifact",
      confidence: 0.86,
      artifacts: [{ type: "diff", uri: `file://${join(workdir, 'patch.diff')}`, content: patch }]
    };
  }
  if (kind === "test") {
    const { stdout } = await execFileAsync("/bin/echo", ["PASS: simulated test suite"]);
    await writeFile(join(workdir, "test-report.txt"), stdout, "utf8");
    return {
      summary: "Simulated tests completed",
      confidence: 0.91,
      artifacts: [{ type: "test-report", uri: `file://${join(workdir, 'test-report.txt')}`, content: stdout }]
    };
  }
  if (kind === "review") {
    const content = "Review: diff looks acceptable for low-risk progression.";
    await writeFile(join(workdir, "review.md"), content, "utf8");
    return {
      summary: "Generated review recommendation",
      confidence: 0.84,
      artifacts: [{ type: "review", uri: `file://${join(workdir, 'review.md')}`, content }]
    };
  }
  const content = "Deploy: canary staged and ready for approval.";
  await writeFile(join(workdir, "deploy.txt"), content, "utf8");
  return {
    summary: "Prepared deploy artifact",
    confidence: 0.79,
    artifacts: [{ type: "deploy-note", uri: `file://${join(workdir, 'deploy.txt')}`, content }]
  };
}

app.get("/health", (c) => c.json({ ok: true, service: "worker-runtime" }));
app.post("/api/execute-step", async (c) => {
  const body = await c.req.json<{ run_id: string; step_id: string; kind: string }>();
  const workdir = join(runsRoot, body.run_id, body.step_id);
  const result = await runStep(body.kind, workdir);
  return c.json({ run_id: body.run_id, step_id: body.step_id, workdir, ...result });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4304) });
console.log("worker-runtime listening on http://localhost:4304");
