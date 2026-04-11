import { useEffect, useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { CapacityBar, CostCard, Panel, Sparkline, StatusRow } from "@hermes-harness-with-missioncontrol/ui-kit";
import { CommandPalette } from "./CommandPalette.js";

const tabs = ["Overview", "Missions", "Agents", "Memory", "Code", "Audit", "Settings"] as const;
type Tab = (typeof tabs)[number];
const ORCH = import.meta.env.VITE_ORCH_URL ?? "/orchestrator";
const MEM = import.meta.env.VITE_MEMORY_URL ?? "/memory";
const EVAL = import.meta.env.VITE_EVAL_URL ?? "/eval";

function getOperatorToken() {
  return window.localStorage.getItem("harness.operatorToken") ?? "";
}

function authFetch(url: string, init: RequestInit = {}) {
  const token = getOperatorToken();
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  });
}

const fetcher = (url: string) => authFetch(url).then((r) => r.json());

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} style={{ borderRadius: 10, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0", padding: "10px 14px", cursor: "pointer", ...(props.style ?? {}) }} />;
}

function TopBar({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 12, borderBottom: "1px solid #1e293b", position: "sticky", top: 0, background: "#020617", zIndex: 20 }}>
      <div style={{ fontWeight: 800, color: "#7dd3fc", marginRight: 12 }}>HERMES-HARNESS-WITH-MISSIONCONTROL</div>
      {tabs.map((tab, index) => (
        <Button key={tab} onClick={() => onChange(tab)} style={{ background: active === tab ? "#111827" : "transparent", color: active === tab ? "#e2e8f0" : "#94a3b8", padding: "8px 12px" }}>{index + 1}. {tab}</Button>
      ))}
      <div style={{ marginLeft: "auto" }}>
        <Button onClick={() => mutate(() => true)}>Refresh</Button>
      </div>
    </div>
  );
}

function Overview() {
  const { data: memory } = useSWR(`${MEM}/api/memory/agents/agent_demo/summary`, fetcher, { refreshInterval: 15000 });
  const { data: missions } = useSWR(`${ORCH}/api/missions`, fetcher, { refreshInterval: 5000 });
  const { data: approvals } = useSWR(`${ORCH}/api/approvals`, fetcher, { refreshInterval: 5000 });
  const { data: evals } = useSWR(`${EVAL}/api/evals`, fetcher, { refreshInterval: 7000 });
  const trend = useMemo(() => ((evals?.records ?? []) as Array<{ cost_usd: number }>).slice(-7).map((item) => item.cost_usd) || [0], [evals]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16, padding: 16 }}>
      <Panel title="Active Missions"><StatusRow label="Open missions" value={missions?.missions?.length ?? 0} /><StatusRow label="Pending approvals" value={approvals?.approvals?.filter((item: any) => item.status === "pending").length ?? 0} /><StatusRow label="Recent failures" value={missions?.missions?.filter((item: any) => item.status === "failed").length ?? 0} /></Panel>
      <Panel title="Memory Health"><CapacityBar value={memory?.learned_count ?? 0} max={20} /><div style={{ height: 12 }} /><StatusRow label="Pending rewrites" value={memory?.pending_rewrites ?? 0} /></Panel>
      <Panel title="Cost Today"><CostCard label="Estimated run cost" amount={`$${(evals?.summary?.total_cost_usd ?? 0).toFixed?.(2) ?? '0.00'}`} /></Panel>
      <Panel title="Run Throughput"><Sparkline values={trend.length ? trend : [0]} /><StatusRow label="Total runs" value={evals?.summary?.total_runs ?? 0} /></Panel>
      <Panel title="Approval Load"><StatusRow label="Awaiting decision" value={approvals?.approvals?.filter((item: any) => item.status === "pending").length ?? 0} /><StatusRow label="Approved" value={approvals?.approvals?.filter((item: any) => item.status === "approved").length ?? 0} /></Panel>
      <Panel title="Eval Snapshot"><StatusRow label="Success rate" value={`${Math.round((evals?.summary?.success_rate ?? 0) * 100)}%`} /><StatusRow label="Avg cost" value={`$${(evals?.summary?.average_cost_usd ?? 0).toFixed?.(2) ?? '0.00'}`} /></Panel>
    </div>
  );
}

function Missions() {
  const { data } = useSWR(`${ORCH}/api/missions`, fetcher, { refreshInterval: 3000 });
  const { data: runs } = useSWR(`${ORCH}/api/runs`, fetcher, { refreshInterval: 3000 });
  const { data: approvals } = useSWR(`${ORCH}/api/approvals`, fetcher, { refreshInterval: 3000 });
  const [title, setTitle] = useState("Fix duplicate webhook jobs");
  const [repoPath, setRepoPath] = useState("/Users/jaywest/projects/Hermes-harness-with-missioncontrol");

  async function createMission() {
    await authFetch(`${ORCH}/api/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, project_id: "proj_demo", workflow_id: "bugfix", repo_path: repoPath })
    });
    mutate(`${ORCH}/api/missions`);
  }

  async function startMission(missionId: string) {
    await authFetch(`${ORCH}/api/missions/${missionId}/start`, { method: "POST" });
    mutate(`${ORCH}/api/missions`);
    mutate(`${ORCH}/api/runs`);
    mutate(`${ORCH}/api/events`);
  }

  async function completeStep(runId: string, stepId: string) {
    await authFetch(`${ORCH}/api/runs/${runId}/steps/${stepId}/complete`, { method: "POST" });
    mutate(`${ORCH}/api/missions`);
    mutate(`${ORCH}/api/runs`);
    mutate(`${ORCH}/api/approvals`);
    mutate(`${ORCH}/api/events`);
    mutate(`${EVAL}/api/evals`);
    mutate(`${MEM}/api/memory/agents/agent_demo/summary`);
  }

  async function executeCurrent(runId: string) {
    await authFetch(`${ORCH}/api/runs/${runId}/execute-current`, { method: "POST" });
    mutate(`${ORCH}/api/missions`);
    mutate(`${ORCH}/api/runs`);
    mutate(`${ORCH}/api/approvals`);
    mutate(`${ORCH}/api/events`);
    mutate(`${EVAL}/api/evals`);
    mutate(`${MEM}/api/memory/agents/agent_demo/summary`);
  }

  async function respondApproval(approvalId: string, decision: "approved" | "rejected") {
    await authFetch(`${ORCH}/api/approvals/${approvalId}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision })
    });
    mutate(`${ORCH}/api/approvals`);
    mutate(`${ORCH}/api/runs`);
    mutate(`${ORCH}/api/missions`);
    mutate(`${ORCH}/api/events`);
    mutate(`${EVAL}/api/evals`);
  }

  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      <Panel title="New Mission">
        <div style={{ display: "grid", gap: 12 }}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} style={{ flex: 1, borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <input value={repoPath} onChange={(event) => setRepoPath(event.target.value)} style={{ flex: 1, borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <Button onClick={createMission}>Create</Button>
        </div>
      </Panel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Panel title="Mission Queue">
          {(data?.missions ?? []).length === 0 ? <div>No missions yet.</div> : (data.missions as any[]).map((mission) => (
            <div key={mission.mission_id} style={{ padding: 12, borderBottom: "1px solid #1e293b" }}>
              <StatusRow label={mission.title} value={mission.status} />
              <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>{mission.repo_path ?? "no repo path"}</div>
              <div style={{ height: 8 }} />
              <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={() => startMission(mission.mission_id)}>Start</Button>
              </div>
            </div>
          ))}
        </Panel>
        <Panel title="Approvals Queue">
          {(approvals?.approvals ?? []).length === 0 ? <div>No approvals.</div> : (approvals.approvals as any[]).map((approval) => (
            <div key={approval.approval_id} style={{ padding: 12, borderBottom: "1px solid #1e293b" }}>
              <StatusRow label={`${approval.step_id}`} value={approval.status} />
              <div style={{ color: "#94a3b8", fontSize: 13, margin: "8px 0" }}>{approval.reason}</div>
              {approval.status === "pending" && <div style={{ display: "flex", gap: 8 }}><Button onClick={() => respondApproval(approval.approval_id, "approved")}>Approve</Button><Button onClick={() => respondApproval(approval.approval_id, "rejected")} style={{ background: "#3f0d19" }}>Reject</Button></div>}
            </div>
          ))}
        </Panel>
      </div>
      <Panel title="Workflow Runs">
        {(runs?.runs ?? []).length === 0 ? <div>No runs yet.</div> : (runs.runs as any[]).map((run) => (
          <div key={run.run_id} style={{ padding: 12, borderBottom: "1px solid #1e293b" }}>
            <StatusRow label={`${run.run_id} · ${run.workflow_id}`} value={run.status} />
            <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
              {run.steps.map((step: any) => (
                <div key={step.id} style={{ padding: 10, border: "1px solid #1e293b", borderRadius: 8 }}>
                  <StatusRow label={`${step.id} (${step.kind})`} value={step.status} />
                  <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>Risk: {step.risk} · Artifacts: {step.artifacts.length}</div>
                  {step.artifacts.length > 0 && <div style={{ color: "#7dd3fc", fontSize: 12, marginTop: 6 }}>Latest artifact: {step.artifacts[step.artifacts.length - 1].uri}</div>}
                  {step.status === "running" && <div style={{ marginTop: 8, display: "flex", gap: 8 }}><Button onClick={() => executeCurrent(run.run_id)}>Execute current step</Button><Button onClick={() => completeStep(run.run_id, step.id)}>Mark step complete</Button></div>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function Agents() {
  const { data: summary } = useSWR(`${MEM}/api/memory/agents/agent_demo/summary`, fetcher, { refreshInterval: 10000 });
  const [bundle, setBundle] = useState<any>(null);
  async function loadContext() {
    const response = await authFetch(`${MEM}/api/memory/context/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent_demo", agent_role: "coder", project_id: "proj_demo", budget_bytes: 65536 })
    });
    setBundle(await response.json());
  }
  return (
    <div style={{ padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <Panel title="Agent Summary">
        <StatusRow label="Agent" value={summary?.agent_id ?? "agent_demo"} />
        <StatusRow label="Profile" value={summary?.profile_path ?? "n/a"} />
        <StatusRow label="Hot memory" value={summary?.hot_path ?? "n/a"} />
        <StatusRow label="Working log" value={summary?.working_path ?? "n/a"} />
        <StatusRow label="Pending rewrites" value={summary?.pending_rewrites ?? 0} />
        <div style={{ height: 12 }} />
        <Button onClick={loadContext}>Load context bundle</Button>
      </Panel>
      <Panel title="Latest Context Bundle">{bundle ? <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(bundle, null, 2)}</pre> : <div>No bundle loaded yet.</div>}</Panel>
    </div>
  );
}

function Memory() {
  const { data: project } = useSWR(`${MEM}/api/memory/projects/proj_demo/summary`, fetcher, { refreshInterval: 10000 });
  const { data: search } = useSWR(`${MEM}/api/memory/search?q=autonomy`, fetcher, { refreshInterval: 10000 });
  const { data: rewrites } = useSWR(`${MEM}/api/memory/agents/agent_demo/rewrite-candidates`, fetcher, { refreshInterval: 10000 });
  const [writeback, setWriteback] = useState<any>(null);
  const [promotion, setPromotion] = useState<any>(null);
  const [section, setSection] = useState("projects/proj_demo");
  const [selectedArticle, setSelectedArticle] = useState("projects/proj_demo/standards.md");
  const { data: articles } = useSWR(`${MEM}/api/memory/articles?section=${encodeURIComponent(section)}`, fetcher, { refreshInterval: 10000 });
  const { data: article } = useSWR(selectedArticle ? `${MEM}/api/memory/articles/${selectedArticle}` : null, fetcher, { refreshInterval: 10000 });

  async function closeTaskWriteback() {
    const response = await authFetch(`${MEM}/api/memory/tasks/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent_demo",
        project_id: "proj_demo",
        mission_id: "mis_demo",
        run_id: "run_demo",
        step_id: "step_demo",
        outcome: "success",
        summary: "Recorded a successful bounded autonomy writeback from the console.",
        discoveries: [{ title: "Bounded autonomy works better", body: "Keep the harness constrained to low-risk workflows first." }],
        gotchas: [{ title: "Writeback path proven", body: "Console-triggered writeback successfully appended to memory runtime files." }],
        rewrites: [{ target: "wiki/projects/proj_demo/standards.md", kind: "candidate_rewrite", content: "Add explicit note that promotions require review." }],
        artifacts: [{ type: "console", uri: "ui://memory/writeback" }]
      })
    });
    const data = await response.json();
    setWriteback(data);
    mutate(`${MEM}/api/memory/agents/agent_demo/summary`);
    mutate(`${MEM}/api/memory/projects/proj_demo/summary`);
    mutate(`${MEM}/api/memory/agents/agent_demo/rewrite-candidates`);
  }

  async function promoteRewrite(item: any) {
    const response = await authFetch(`${MEM}/api/memory/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: item.id, promoted_by: "agent_demo", target_path: `wiki/projects/proj_demo/promoted-${item.id}.md`, promotion_kind: "standard" })
    });
    setPromotion(await response.json());
  }

  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Panel title="Project Memory Summary">
          <StatusRow label="Project" value={project?.project_id ?? "proj_demo"} />
          <StatusRow label="Standards" value={(project?.standards ?? []).join(", ") || "none"} />
          <StatusRow label="Recipes" value={(project?.recipes ?? []).join(", ") || "none"} />
          <StatusRow label="Active rewrites" value={(rewrites?.items ?? []).length ?? 0} />
        </Panel>
        <Panel title="Knowledge Search">{(search?.results ?? []).length === 0 ? <div>No results.</div> : <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(search.results, null, 2)}</pre>}</Panel>
      </div>
      <Panel title="Writeback + Promotion Flow">
        <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <Button onClick={closeTaskWriteback}>Run writeback</Button>
        </div>
        {writeback ? <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(writeback, null, 2)}</pre> : <div>No writeback executed yet.</div>}
        <div style={{ height: 12 }} />
        <div style={{ display: "grid", gap: 8 }}>
          {(rewrites?.items ?? []).map((item: any) => (
            <div key={item.id} style={{ border: "1px solid #1e293b", borderRadius: 8, padding: 12 }}>
              <div style={{ fontWeight: 700 }}>{item.target}</div>
              <div style={{ color: "#94a3b8", whiteSpace: "pre-wrap", margin: "8px 0" }}>{item.content || "No content"}</div>
              <Button onClick={() => promoteRewrite(item)}>Promote rewrite</Button>
            </div>
          ))}
        </div>
        {promotion && <pre style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{JSON.stringify(promotion, null, 2)}</pre>}
      </Panel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 16 }}>
        <Panel title="Docs Browser">
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input value={section} onChange={(event) => setSection(event.target.value)} style={{ flex: 1, borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
            <Button onClick={() => mutate(`${MEM}/api/memory/articles?section=${encodeURIComponent(section)}`)}>Load</Button>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {(articles?.files ?? []).map((file: string) => (
              <Button key={file} onClick={() => setSelectedArticle(`${section}/${file}`)} style={{ textAlign: "left" }}>{file}</Button>
            ))}
          </div>
        </Panel>
        <Panel title="Article Viewer">
          <div style={{ color: "#94a3b8", marginBottom: 8 }}>{selectedArticle}</div>
          {article?.content ? <pre style={{ whiteSpace: "pre-wrap" }}>{article.content}</pre> : <div>Select an article.</div>}
        </Panel>
      </div>
    </div>
  );
}

function Code() {
  const { data: runs } = useSWR(`${ORCH}/api/runs`, fetcher, { refreshInterval: 4000 });
  const [artifactContent, setArtifactContent] = useState("diff --git a/file.ts b/file.ts\n+ bounded autonomy patch");

  async function addArtifact(runId: string, stepId: string) {
    await authFetch(`${ORCH}/api/runs/${runId}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step_id: stepId, type: "diff", content: artifactContent })
    });
    mutate(`${ORCH}/api/runs`);
  }

  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      <Panel title="Artifact Composer">
        <textarea value={artifactContent} onChange={(event) => setArtifactContent(event.target.value)} style={{ width: "100%", minHeight: 140, borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
      </Panel>
      <Panel title="Run Artifacts">
        {(runs?.runs ?? []).length === 0 ? <div>No runs yet.</div> : (runs.runs as any[]).map((run) => (
          <div key={run.run_id} style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{run.run_id}</div>
            {run.steps.map((step: any) => (
              <div key={step.id} style={{ border: "1px solid #1e293b", borderRadius: 8, padding: 12, marginBottom: 8 }}>
                <StatusRow label={`${step.id}`} value={`${step.artifacts.length} artifacts`} />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <Button onClick={() => addArtifact(run.run_id, step.id)}>Add diff artifact</Button>
                </div>
                {step.artifacts.length > 0 && <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{JSON.stringify(step.artifacts, null, 2)}</pre>}
              </div>
            ))}
          </div>
        ))}
      </Panel>
    </div>
  );
}

function Audit() {
  const { data: events } = useSWR(`${ORCH}/api/events`, fetcher, { refreshInterval: 3000 });
  const { data: audit } = useSWR(`${ORCH}/api/audit`, fetcher, { refreshInterval: 3000 });
  const { data: evals } = useSWR(`${EVAL}/api/evals`, fetcher, { refreshInterval: 4000 });
  const { data: approvals } = useSWR(`${ORCH}/api/approvals`, fetcher, { refreshInterval: 3000 });
  return (
    <div style={{ padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <Panel title="Event Stream">{(events?.events ?? []).length === 0 ? <div>No events yet.</div> : <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(events.events, null, 2)}</pre>}</Panel>
      <Panel title="Audit + Eval">{audit?.audit && <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(audit.audit, null, 2)}</pre>}{evals?.summary && <pre style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{JSON.stringify(evals.summary, null, 2)}</pre>}{approvals?.approvals && <pre style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{JSON.stringify(approvals.approvals, null, 2)}</pre>}</Panel>
    </div>
  );
}

function Settings() {
  const [token, setToken] = useState(getOperatorToken());
  function saveToken() {
    window.localStorage.setItem("harness.operatorToken", token);
    mutate(() => true);
  }
  return (
    <div style={{ padding: 16 }}>
      <Panel title="Settings">
        <StatusRow label="Policy model" value="approval-high-risk" />
        <StatusRow label="Workflow library" value="bugfix, dependency_upgrade" />
        <StatusRow label="Eval endpoint" value={EVAL} />
        <div style={{ height: 16 }} />
        <div style={{ color: "#94a3b8", marginBottom: 8 }}>Operator bearer token</div>
        <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="optional HARNESS_OPERATOR_TOKEN" style={{ width: "100%", borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
        <div style={{ height: 8 }} />
        <Button onClick={saveToken}>Save token</Button>
      </Panel>
    </div>
  );
}

export function App() {
  const [active, setActive] = useState<Tab>("Overview");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const num = Number(event.key);
      if (!Number.isNaN(num) && num >= 1 && num <= tabs.length) setActive(tabs[num - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const commands = useMemo(() => tabs.map((tab) => ({ id: tab.toLowerCase(), label: `Open ${tab}`, action: () => setActive(tab) })), []);
  return (
    <div>
      <CommandPalette commands={commands} />
      <TopBar active={active} onChange={setActive} />
      {active === "Overview" && <Overview />}
      {active === "Missions" && <Missions />}
      {active === "Agents" && <Agents />}
      {active === "Memory" && <Memory />}
      {active === "Code" && <Code />}
      {active === "Audit" && <Audit />}
      {active === "Settings" && <Settings />}
    </div>
  );
}
