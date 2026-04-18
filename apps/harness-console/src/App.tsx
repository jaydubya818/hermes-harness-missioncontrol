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
  return window.localStorage.getItem("harness.operatorToken") ?? import.meta.env.VITE_OPERATOR_TOKEN ?? "";
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

async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function authJson(url: string, init: RequestInit = {}) {
  const response = await authFetch(url, init);
  const body = await readApiResponse(response);
  if (!response.ok) {
    const message = typeof body === "object" && body && "error" in body ? String((body as any).error) : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

const fetcher = (url: string) => authFetch(url).then((r) => r.json());

function withQuery(url: string, params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const suffix = search.toString();
  return suffix ? `${url}?${suffix}` : url;
}

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
  const { data: overview } = useSWR(`${ORCH}/api/read-models/overview`, fetcher, { refreshInterval: 5000 });
  const { data: evals } = useSWR(`${EVAL}/api/evals`, fetcher, { refreshInterval: 7000 });
  const trend = useMemo(() => ((evals?.records ?? []) as Array<{ cost_usd: number }>).slice(-7).map((item) => item.cost_usd) || [0], [evals]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16, padding: 16 }}>
      <Panel title="Active Missions"><StatusRow label="Open missions" value={overview?.metrics?.open_missions ?? 0} /><StatusRow label="Pending approvals" value={overview?.metrics?.pending_approvals ?? 0} /><StatusRow label="Recent failures" value={overview?.metrics?.failed_missions ?? 0} /></Panel>
      <Panel title="Memory Health"><CapacityBar value={memory?.learned_count ?? 0} max={20} /><div style={{ height: 12 }} /><StatusRow label="Pending rewrites" value={memory?.pending_rewrites ?? 0} /></Panel>
      <Panel title="Cost Today"><CostCard label="Estimated run cost" amount={`$${(evals?.summary?.total_cost_usd ?? 0).toFixed?.(2) ?? '0.00'}`} /></Panel>
      <Panel title="Run Throughput"><Sparkline values={trend.length ? trend : [0]} /><StatusRow label="Total runs" value={evals?.summary?.total_runs ?? 0} /></Panel>
      <Panel title="Approval Load"><StatusRow label="Awaiting decision" value={overview?.metrics?.pending_approvals ?? 0} /><StatusRow label="Approved" value={evals?.summary?.approval_count ?? 0} /></Panel>
      <Panel title="Eval Snapshot"><StatusRow label="Success rate" value={`${Math.round((evals?.summary?.success_rate ?? 0) * 100)}%`} /><StatusRow label="Avg cost" value={`$${(evals?.summary?.average_cost_usd ?? 0).toFixed?.(2) ?? '0.00'}`} /></Panel>
    </div>
  );
}

function Missions() {
  const { data } = useSWR(`${ORCH}/api/read-models/missions`, fetcher, { refreshInterval: 3000 });
  const { data: approvalsView } = useSWR(`${ORCH}/api/read-models/approvals`, fetcher, { refreshInterval: 3000 });
  const [title, setTitle] = useState("Fix duplicate webhook jobs");
  const [repoPath, setRepoPath] = useState("/Users/jaywest/projects/Hermes-harness-with-missioncontrol");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<{ runId: string; stepId: string } | null>(null);

  useEffect(() => {
    if (!selectedMissionId && data?.mission_queue?.[0]?.mission_id) setSelectedMissionId(data.mission_queue[0].mission_id);
    if (!selectedRunId && data?.run_cards?.[0]?.run_id) setSelectedRunId(data.run_cards[0].run_id);
  }, [data, selectedMissionId, selectedRunId]);

  const missionDetailUrl = selectedMissionId ? `${ORCH}/api/read-models/missions/${selectedMissionId}` : null;
  const runDetailUrl = selectedRunId ? `${ORCH}/api/read-models/runs/${selectedRunId}` : null;
  const stepDetailUrl = selectedStep ? `${ORCH}/api/read-models/runs/${selectedStep.runId}/steps/${selectedStep.stepId}` : null;
  const stepArtifactsUrl = selectedStep ? withQuery(`${ORCH}/api/read-models/artifacts`, { run_id: selectedStep.runId, step_id: selectedStep.stepId, limit: "20", offset: "0" }) : null;
  const { data: missionDetail } = useSWR(missionDetailUrl, fetcher, { refreshInterval: 3000 });
  const { data: runDetail } = useSWR(runDetailUrl, fetcher, { refreshInterval: 3000 });
  const { data: stepDetail } = useSWR(stepDetailUrl, fetcher, { refreshInterval: 3000 });
  const { data: stepArtifacts } = useSWR(stepArtifactsUrl, fetcher, { refreshInterval: 3000 });

  async function runAction(action: () => Promise<unknown>, successMessage: string) {
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(successMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshAll() {
    mutate(`${ORCH}/api/missions`);
    mutate(`${ORCH}/api/runs`);
    mutate(`${ORCH}/api/approvals`);
    mutate(`${ORCH}/api/events`);
    mutate(`${ORCH}/api/read-models/missions`);
    mutate(`${ORCH}/api/read-models/approvals`);
    mutate(`${ORCH}/api/read-models/approval-history`);
    mutate(`${ORCH}/api/read-models/audit`);
    mutate(`${ORCH}/api/read-models/overview`);
    if (selectedMissionId) mutate(`${ORCH}/api/read-models/missions/${selectedMissionId}`);
    if (selectedRunId) mutate(`${ORCH}/api/read-models/runs/${selectedRunId}`);
    if (selectedStep) {
      mutate(`${ORCH}/api/read-models/runs/${selectedStep.runId}/steps/${selectedStep.stepId}`);
      mutate(withQuery(`${ORCH}/api/read-models/artifacts`, { run_id: selectedStep.runId, step_id: selectedStep.stepId, limit: "20", offset: "0" }));
    }
    mutate(`${EVAL}/api/evals`);
    mutate(`${MEM}/api/memory/agents/agent_demo/summary`);
  }

  async function createMission() {
    await runAction(async () => {
      await authJson(`${ORCH}/api/missions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, project_id: "proj_demo", workflow_id: "bugfix", repo_path: repoPath })
      });
      await refreshAll();
    }, "Mission created.");
  }

  async function startMission(missionId: string) {
    await runAction(async () => {
      await authJson(`${ORCH}/api/missions/${missionId}/start`, { method: "POST" });
      setSelectedMissionId(missionId);
      await refreshAll();
    }, "Mission started.");
  }

  async function completeStep(runId: string, stepId: string) {
    await runAction(async () => {
      await authJson(`${ORCH}/api/runs/${runId}/steps/${stepId}/complete`, { method: "POST" });
      setSelectedRunId(runId);
      await refreshAll();
    }, `Step ${stepId} completed.`);
  }

  async function executeCurrent(runId: string) {
    await runAction(async () => {
      await authJson(`${ORCH}/api/runs/${runId}/execute-current`, { method: "POST" });
      setSelectedRunId(runId);
      await refreshAll();
    }, "Current step executed.");
  }

  async function respondApproval(approvalId: string, decision: "approved" | "rejected") {
    await runAction(async () => {
      await authJson(`${ORCH}/api/approvals/${approvalId}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, actor: "jay" })
      });
      await refreshAll();
    }, `Approval ${decision}.`);
  }

  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      <Panel title="New Mission">
        <div style={{ display: "grid", gap: 12 }}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} style={{ flex: 1, borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <input value={repoPath} onChange={(event) => setRepoPath(event.target.value)} style={{ flex: 1, borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <Button onClick={createMission}>Create</Button>
          {message && <div style={{ color: "#86efac", fontSize: 13 }}>{message}</div>}
          {error && <div style={{ color: "#fca5a5", fontSize: 13 }}>Action failed: {error}. If auth is enabled, save HARNESS_OPERATOR_TOKEN in Settings first.</div>}
        </div>
      </Panel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Panel title="Mission Queue">
          {(data?.mission_queue ?? []).length === 0 ? <div>No missions yet.</div> : (data?.mission_queue ?? []).map((mission: any) => (
            <div key={mission.mission_id} style={{ padding: 12, borderBottom: "1px solid #1e293b" }}>
              <StatusRow label={mission.title} value={mission.status} />
              <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>{mission.repo_path ?? "no repo path"}</div>
              <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>{mission.summary ?? ""}</div>
              <div style={{ height: 8 }} />
              <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={() => startMission(mission.mission_id)}>Start</Button>
                <Button onClick={() => setSelectedMissionId(mission.mission_id)} style={{ background: selectedMissionId === mission.mission_id ? "#111827" : "transparent" }}>Inspect</Button>
              </div>
            </div>
          ))}
        </Panel>
        <Panel title="Approvals Queue">
          {(approvalsView?.pending_approvals ?? []).length === 0 ? <div>No approvals.</div> : (approvalsView?.pending_approvals ?? []).map((approval: any) => (
            <div key={approval.approval_id} style={{ padding: 12, borderBottom: "1px solid #1e293b" }}>
              <StatusRow label={`${approval.step_id}`} value={approval.outcome} />
              <div style={{ color: "#94a3b8", fontSize: 13, margin: "8px 0" }}>{approval.reason}</div>
              <div style={{ color: "#64748b", fontSize: 12, marginBottom: 8 }}>Actor: {approval.actor} · Requested: {approval.requested_at}</div>
              <div style={{ display: "flex", gap: 8 }}><Button onClick={() => respondApproval(approval.approval_id, "approved")}>Approve</Button><Button onClick={() => respondApproval(approval.approval_id, "rejected")} style={{ background: "#3f0d19" }}>Reject</Button></div>
            </div>
          ))}
        </Panel>
      </div>
      <Panel title="Workflow Runs">
        {(data?.run_cards ?? []).length === 0 ? <div>No runs yet.</div> : (data?.run_cards ?? []).map((run: any) => (
          <div key={run.run_id} style={{ padding: 12, borderBottom: "1px solid #1e293b" }}>
            <StatusRow label={`${run.run_id} · ${run.workflow_id}`} value={run.status} />
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>{run.summary ?? ""}</div>
            <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
              {run.steps.map((step: any) => (
                <div key={step.step_id} style={{ padding: 10, border: "1px solid #1e293b", borderRadius: 8 }}>
                  <StatusRow label={`${step.step_id} (${step.kind})`} value={step.state} />
                  <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>Risk: {step.risk} · Artifacts: {step.artifacts_count}</div>
                  {step.blocked_reason && <div style={{ color: "#fbbf24", fontSize: 12, marginTop: 6 }}>{step.blocked_reason}</div>}
                  {step.latest_artifact_uri && <div style={{ color: "#7dd3fc", fontSize: 12, marginTop: 6 }}>Latest artifact: {step.latest_artifact_uri}</div>}
                  <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {step.state === "running" && <><Button onClick={() => executeCurrent(run.run_id)}>Execute current step</Button><Button onClick={() => completeStep(run.run_id, step.step_id)}>Mark step complete</Button></>}
                    <Button onClick={() => setSelectedRunId(run.run_id)} style={{ background: selectedRunId === run.run_id ? "#111827" : "transparent" }}>Inspect run</Button>
                    <Button onClick={() => setSelectedStep({ runId: run.run_id, stepId: step.step_id })} style={{ background: selectedStep?.runId === run.run_id && selectedStep?.stepId === step.step_id ? "#111827" : "transparent" }}>Inspect step</Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Panel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Panel title="Mission Detail">
          {!missionDetail ? <div>Select mission.</div> : <>
            <StatusRow label={missionDetail.mission.title} value={missionDetail.mission.status} />
            <StatusRow label="Active run" value={missionDetail.mission.active_run_id ?? "none"} />
            <StatusRow label="Pending approvals" value={missionDetail.approval_summary.pending} />
            <StatusRow label="Artifacts" value={missionDetail.artifact_summary.total_artifacts} />
            <div style={{ height: 12 }} />
            <div style={{ color: "#94a3b8", fontSize: 12 }}>{missionDetail.mission.summary}</div>
            <div style={{ height: 12 }} />
            {(missionDetail.timeline_summary?.recent ?? []).slice(0, 5).map((item: any, index: number) => (
              <div key={`${item.occurred_at}-${index}`} style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>{item.title} · {item.occurred_at}</div>
            ))}
          </>}
        </Panel>
        <Panel title="Run Detail">
          {!runDetail ? <div>Select run.</div> : <>
            <StatusRow label={runDetail.run.run_id} value={runDetail.run.status} />
            <StatusRow label="Current step" value={runDetail.run.current_step_id ?? "none"} />
            <StatusRow label="Pending approvals" value={runDetail.approval_summary.pending} />
            <StatusRow label="Artifacts" value={runDetail.artifact_summary.total_artifacts} />
            <div style={{ height: 12 }} />
            {(runDetail.steps ?? []).map((step: any) => (
              <div key={step.step_id} style={{ borderTop: "1px solid #1e293b", paddingTop: 8, marginTop: 8 }}>
                <StatusRow label={`${step.step_id} (${step.kind})`} value={step.state} />
                <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>Artifacts: {step.artifacts_count}{step.latest_artifact_uri ? ` · ${step.latest_artifact_uri}` : ""}</div>
              </div>
            ))}
          </>}
        </Panel>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Panel title="Step Detail">
          {!stepDetail ? <div>Select step.</div> : <>
            <StatusRow label={`${stepDetail.step.step_id} (${stepDetail.step.kind})`} value={stepDetail.step.state} />
            <StatusRow label="Execution" value={stepDetail.step.execution_id ?? "none"} />
            <StatusRow label="Risk" value={stepDetail.step.risk ?? "n/a"} />
            <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 8 }}>{stepDetail.step.notes ?? "No notes."}</div>
            {stepDetail.step.blocked_reason && <div style={{ color: "#fbbf24", fontSize: 12, marginTop: 8 }}>{stepDetail.step.blocked_reason}</div>}
            {stepDetail.approval && <div style={{ color: "#64748b", fontSize: 12, marginTop: 8 }}>Approval: {stepDetail.approval.outcome} · {stepDetail.approval.reason}</div>}
            <div style={{ height: 12 }} />
            {(stepDetail.timeline_summary?.recent ?? []).slice(0, 5).map((item: any, index: number) => (
              <div key={`${item.occurred_at}-${index}`} style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>{item.title} · {item.occurred_at}</div>
            ))}
          </>}
        </Panel>
        <Panel title="Step Artifacts">
          {!selectedStep ? <div>Select step.</div> : ((stepArtifacts?.artifacts ?? []).length === 0 ? <div>No artifacts.</div> : (stepArtifacts?.artifacts ?? []).map((artifact: any) => (
            <div key={artifact.artifact_id} style={{ borderTop: "1px solid #1e293b", paddingTop: 8, marginTop: 8 }}>
              <StatusRow label={artifact.artifact_type} value={artifact.artifact_id} />
              <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>{artifact.ref}</div>
              <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>{artifact.summary}</div>
            </div>
          )))}
        </Panel>
      </div>
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
  const { data } = useSWR(`${ORCH}/api/read-models/missions`, fetcher, { refreshInterval: 4000 });
  const [artifactContent, setArtifactContent] = useState("diff --git a/file.ts b/file.ts\n+ bounded autonomy patch");
  const [missionFilter, setMissionFilter] = useState("");
  const [runFilter, setRunFilter] = useState("");
  const [stepFilter, setStepFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [artifactSort, setArtifactSort] = useState("newest");
  const [offset, setOffset] = useState(0);
  const limit = 10;

  const artifactsUrl = withQuery(`${ORCH}/api/read-models/artifacts`, {
    mission_id: missionFilter || undefined,
    run_id: runFilter || undefined,
    step_id: stepFilter || undefined,
    artifact_type: typeFilter || undefined,
    sort: artifactSort,
    limit: String(limit),
    offset: String(offset)
  });
  const { data: artifactsView } = useSWR(artifactsUrl, fetcher, { refreshInterval: 4000 });

  async function addArtifact(runId: string, stepId: string) {
    await authFetch(`${ORCH}/api/runs/${runId}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step_id: stepId, type: "diff", content: artifactContent })
    });
    mutate(`${ORCH}/api/runs`);
    mutate(`${ORCH}/api/read-models/missions`);
    mutate(artifactsUrl);
  }

  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      <Panel title="Artifact Composer">
        <textarea value={artifactContent} onChange={(event) => setArtifactContent(event.target.value)} style={{ width: "100%", minHeight: 140, borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
      </Panel>
      <Panel title="Artifact Filters">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8 }}>
          <input value={missionFilter} onChange={(event) => { setMissionFilter(event.target.value); setOffset(0); }} placeholder="mission" style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <input value={runFilter} onChange={(event) => { setRunFilter(event.target.value); setOffset(0); }} placeholder="run" style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <input value={stepFilter} onChange={(event) => { setStepFilter(event.target.value); setOffset(0); }} placeholder="step" style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <input value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); setOffset(0); }} placeholder="artifact type" style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <select value={artifactSort} onChange={(event) => { setArtifactSort(event.target.value); setOffset(0); }} style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }}>
            <option value="newest">newest</option>
            <option value="oldest">oldest</option>
            <option value="mission">by mission</option>
            <option value="run">by run</option>
            <option value="step">by step</option>
          </select>
        </div>
      </Panel>
      <Panel title="Run Artifacts">
        {(data?.run_cards ?? []).length === 0 ? <div>No runs yet.</div> : (data?.run_cards ?? []).map((run: any) => (
          <div key={run.run_id} style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{run.run_id}</div>
            {run.steps.map((step: any) => (
              <div key={step.step_id} style={{ border: "1px solid #1e293b", borderRadius: 8, padding: 12, marginBottom: 8 }}>
                <StatusRow label={`${step.step_id}`} value={`${step.artifacts_count} artifacts`} />
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <Button onClick={() => addArtifact(run.run_id, step.step_id)}>Add diff artifact</Button>
                  <Button onClick={() => { setRunFilter(run.run_id); setStepFilter(step.step_id); setOffset(0); }} style={{ background: "transparent" }}>Filter artifacts</Button>
                </div>
                {step.latest_artifact_uri && <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{step.latest_artifact_uri}</pre>}
              </div>
            ))}
          </div>
        ))}
      </Panel>
      <Panel title="Artifact Read Model">
        {(artifactsView?.artifacts ?? []).length === 0 ? <div>No artifacts found.</div> : (artifactsView?.artifacts ?? []).map((artifact: any) => (
          <div key={artifact.artifact_id} style={{ borderTop: "1px solid #1e293b", paddingTop: 8, marginTop: 8 }}>
            <StatusRow label={artifact.artifact_type} value={artifact.artifact_id} />
            <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>{[artifact.mission_id, artifact.run_id, artifact.step_id].filter(Boolean).join(" · ")}</div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>{artifact.ref}</div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>By: {artifact.created_by}{artifact.eval_linkage ? ` · Eval: ${artifact.eval_linkage}` : ""}</div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <Button onClick={() => setOffset(Math.max(0, offset - limit))} style={{ background: "transparent" }}>Prev</Button>
          <Button onClick={() => setOffset(offset + limit)} disabled={!artifactsView?.pagination?.has_more}>Next</Button>
          <div style={{ color: "#64748b", fontSize: 12, alignSelf: "center" }}>offset {artifactsView?.pagination?.offset ?? 0} / total {artifactsView?.pagination?.total ?? 0}</div>
        </div>
      </Panel>
    </div>
  );
}

function Audit() {
  const [missionFilter, setMissionFilter] = useState("");
  const [runFilter, setRunFilter] = useState("");
  const [stepFilter, setStepFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [approvalSort, setApprovalSort] = useState("newest");
  const [timelineKind, setTimelineKind] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [timelineSort, setTimelineSort] = useState("newest");

  const auditUrl = withQuery(`${ORCH}/api/read-models/audit`, {
    mission_id: missionFilter || undefined,
    run_id: runFilter || undefined,
    step_id: stepFilter || undefined,
    kind: timelineKind || undefined,
    event_type: eventTypeFilter || undefined,
    sort: timelineSort
  });
  const approvalHistoryUrl = withQuery(`${ORCH}/api/read-models/approval-history`, {
    mission_id: missionFilter || undefined,
    run_id: runFilter || undefined,
    step_id: stepFilter || undefined,
    actor: actorFilter || undefined,
    outcome: outcomeFilter || undefined,
    sort: approvalSort
  });

  const { data: auditView } = useSWR(auditUrl, fetcher, { refreshInterval: 3000 });
  const { data: approvalHistory } = useSWR(approvalHistoryUrl, fetcher, { refreshInterval: 3000 });
  const { data: evals } = useSWR(`${EVAL}/api/evals`, fetcher, { refreshInterval: 4000 });
  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      <Panel title="Filters">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
          <input value={missionFilter} onChange={(event) => setMissionFilter(event.target.value)} placeholder="mission" style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <input value={runFilter} onChange={(event) => setRunFilter(event.target.value)} placeholder="run" style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <input value={stepFilter} onChange={(event) => setStepFilter(event.target.value)} placeholder="step" style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <input value={actorFilter} onChange={(event) => setActorFilter(event.target.value)} placeholder="actor" style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <select value={outcomeFilter} onChange={(event) => setOutcomeFilter(event.target.value)} style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }}>
            <option value="">all outcomes</option>
            <option value="approved">approved</option>
            <option value="rejected">rejected</option>
            <option value="pending">pending</option>
          </select>
          <select value={approvalSort} onChange={(event) => setApprovalSort(event.target.value)} style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }}>
            <option value="newest">approval newest</option>
            <option value="oldest">approval oldest</option>
            <option value="rejected_first">rejected first</option>
            <option value="mission">by mission</option>
            <option value="run">by run</option>
          </select>
          <select value={timelineKind} onChange={(event) => setTimelineKind(event.target.value)} style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }}>
            <option value="">all kinds</option>
            <option value="approval">approval</option>
            <option value="step">step</option>
            <option value="run">run</option>
            <option value="mission">mission</option>
            <option value="deployment">deployment</option>
          </select>
          <select value={timelineSort} onChange={(event) => setTimelineSort(event.target.value)} style={{ borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }}>
            <option value="newest">timeline newest</option>
            <option value="oldest">timeline oldest</option>
            <option value="mission">by mission</option>
            <option value="run">by run</option>
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input value={eventTypeFilter} onChange={(event) => setEventTypeFilter(event.target.value)} placeholder="event type" style={{ flex: 1, borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <Button onClick={() => { setMissionFilter(""); setRunFilter(""); setStepFilter(""); setActorFilter(""); setOutcomeFilter(""); setApprovalSort("newest"); setTimelineKind(""); setEventTypeFilter(""); setTimelineSort("newest"); }}>Clear</Button>
        </div>
      </Panel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Panel title="Run Timeline">
          {(auditView?.timeline ?? []).length === 0 ? <div>No timeline yet.</div> : (auditView?.timeline ?? []).map((item: any, index: number) => (
            <div key={`${item.occurred_at}-${index}`} style={{ padding: 12, borderBottom: "1px solid #1e293b" }}>
              <StatusRow label={item.title} value={item.kind} />
              <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>{item.occurred_at}</div>
              <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>{[item.mission_id, item.run_id, item.step_id].filter(Boolean).join(" · ")}</div>
            </div>
          ))}
        </Panel>
        <Panel title="Approval History + Eval">
          {(approvalHistory?.approvals ?? []).length === 0 ? <div>No approval history yet.</div> : (approvalHistory?.approvals ?? []).map((approval: any) => (
            <div key={approval.approval_id} style={{ padding: 12, borderBottom: "1px solid #1e293b" }}>
              <StatusRow label={`${approval.step_id}`} value={approval.outcome} />
              <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 6 }}>{approval.reason}</div>
              <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>Actor: {approval.actor} · Resolved: {approval.resolved_at}</div>
              <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>{[approval.mission_id, approval.run_id].filter(Boolean).join(" · ")}</div>
            </div>
          ))}
          {evals?.summary && <pre style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{JSON.stringify(evals.summary, null, 2)}</pre>}
        </Panel>
      </div>
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
