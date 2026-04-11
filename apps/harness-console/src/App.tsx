import { useEffect, useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { CapacityBar, CostCard, Panel, Sparkline, StatusRow } from "@hermes-harness-with-missioncontrol/ui-kit";
import { CommandPalette } from "./CommandPalette.js";

const tabs = ["Overview", "Missions", "Agents", "Memory", "Code", "Audit", "Settings"] as const;
type Tab = (typeof tabs)[number];
const fetcher = (url: string) => fetch(url).then((r) => r.json());

function TopBar({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 12, borderBottom: "1px solid #1e293b", position: "sticky", top: 0, background: "#020617" }}>
      <div style={{ fontWeight: 800, color: "#7dd3fc", marginRight: 12 }}>HERMES-HARNESS-WITH-MISSIONCONTROL</div>
      {tabs.map((tab, index) => (
        <button key={tab} onClick={() => onChange(tab)} style={{ background: active === tab ? "#0f172a" : "transparent", color: active === tab ? "#e2e8f0" : "#94a3b8", border: "1px solid #1e293b", borderRadius: 8, padding: "8px 12px" }}>{index + 1}. {tab}</button>
      ))}
      <div style={{ marginLeft: "auto" }}>
        <button onClick={() => mutate(() => true)} style={{ background: "#0f172a", color: "#e2e8f0", border: "1px solid #1e293b", borderRadius: 8, padding: "8px 12px" }}>Refresh</button>
      </div>
    </div>
  );
}

function Overview() {
  const { data: memory } = useSWR("http://localhost:4301/api/memory/agents/agent_demo/summary", fetcher, { refreshInterval: 15000 });
  const { data: missions } = useSWR("http://localhost:4302/api/missions", fetcher, { refreshInterval: 5000 });
  const missionCount = missions?.missions?.length ?? 0;
  const trend = useMemo(() => [1, 3, 2, 5, 4, 6, 5], []);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16, padding: 16 }}>
      <Panel title="Active Missions"><StatusRow label="Open missions" value={missionCount} /><StatusRow label="Pending approvals" value={0} /><StatusRow label="Recent failures" value={0} /></Panel>
      <Panel title="Memory Health"><CapacityBar value={memory?.learned_count ?? 0} max={20} /><div style={{ height: 12 }} /><StatusRow label="Pending rewrites" value={memory?.pending_rewrites ?? 0} /></Panel>
      <Panel title="Cost Today"><CostCard label="Estimated run cost" amount="$0.00" /></Panel>
      <Panel title="Run Throughput"><Sparkline values={trend} /><StatusRow label="7-day velocity" value="steady" /></Panel>
      <Panel title="Recent Promotions"><StatusRow label="Promotions" value={memory?.recent_promotions ?? 0} /><StatusRow label="Last context bundle" value={memory?.profile_path ?? "n/a"} /></Panel>
      <Panel title="Deploy Health"><StatusRow label="Canary deploys" value="0" /><StatusRow label="Rollbacks" value="0" /></Panel>
    </div>
  );
}

function Missions() {
  const { data } = useSWR("http://localhost:4302/api/missions", fetcher, { refreshInterval: 3000 });
  const [title, setTitle] = useState("Fix duplicate webhook jobs");

  async function createMission() {
    await fetch("http://localhost:4302/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, project_id: "proj_demo" })
    });
    mutate("http://localhost:4302/api/missions");
  }

  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      <Panel title="New Mission">
        <div style={{ display: "flex", gap: 12 }}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} style={{ flex: 1, borderRadius: 10, border: "1px solid #334155", background: "#020617", color: "#e2e8f0", padding: 12 }} />
          <button onClick={createMission} style={{ borderRadius: 10, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0", padding: "12px 16px" }}>Create</button>
        </div>
      </Panel>
      <Panel title="Mission Queue">
        {(data?.missions ?? []).length === 0 ? <div>No missions yet.</div> : <pre>{JSON.stringify(data.missions, null, 2)}</pre>}
      </Panel>
    </div>
  );
}

function Agents() {
  const { data: summary } = useSWR("http://localhost:4301/api/memory/agents/agent_demo/summary", fetcher, { refreshInterval: 10000 });
  const [bundle, setBundle] = useState<unknown>(null);

  async function loadContext() {
    const response = await fetch("http://localhost:4301/api/memory/context/load", {
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
        <button onClick={loadContext} style={{ borderRadius: 10, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0", padding: "12px 16px" }}>Load context bundle</button>
      </Panel>
      <Panel title="Latest Context Bundle">
        {bundle ? <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(bundle, null, 2)}</pre> : <div>No bundle loaded yet.</div>}
      </Panel>
    </div>
  );
}

function Memory() {
  const { data: project } = useSWR("http://localhost:4301/api/memory/projects/proj_demo/summary", fetcher, { refreshInterval: 10000 });
  const { data: search } = useSWR("http://localhost:4301/api/memory/search?q=autonomy", fetcher, { refreshInterval: 10000 });
  const [writeback, setWriteback] = useState<unknown>(null);

  async function closeTaskWriteback() {
    const response = await fetch("http://localhost:4301/api/memory/tasks/close", {
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
    mutate("http://localhost:4301/api/memory/agents/agent_demo/summary");
    mutate("http://localhost:4301/api/memory/projects/proj_demo/summary");
  }

  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Panel title="Project Memory Summary">
          <StatusRow label="Project" value={project?.project_id ?? "proj_demo"} />
          <StatusRow label="Standards" value={(project?.standards ?? []).join(", ") || "none"} />
          <StatusRow label="Recipes" value={(project?.recipes ?? []).join(", ") || "none"} />
          <StatusRow label="Active rewrites" value={(project?.active_rewrites ?? []).length ?? 0} />
        </Panel>
        <Panel title="Knowledge Search">
          {(search?.results ?? []).length === 0 ? <div>No results.</div> : <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(search.results, null, 2)}</pre>}
        </Panel>
      </div>
      <Panel title="Writeback + Promotion Flow">
        <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <button onClick={closeTaskWriteback} style={{ borderRadius: 10, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0", padding: "12px 16px" }}>Run writeback</button>
        </div>
        {writeback ? <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(writeback, null, 2)}</pre> : <div>No writeback executed yet.</div>}
      </Panel>
    </div>
  );
}

function Code() { return <div style={{ padding: 16 }}><Panel title="Code Pipeline">Diffs, tests, reviews, and deploy artifacts will render here.</Panel></div>; }

function Audit() {
  const { data } = useSWR("http://localhost:4302/api/events", fetcher, { refreshInterval: 3000 });
  return <div style={{ padding: 16 }}><Panel title="Audit Ledger">{(data?.events ?? []).length === 0 ? <div>No events yet.</div> : <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(data.events, null, 2)}</pre>}</Panel></div>;
}

function Settings() { return <div style={{ padding: 16 }}><Panel title="Settings">Policies, integrations, and runtime config will render here.</Panel></div>; }

export function App() {
  const [active, setActive] = useState<Tab>("Overview");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const num = Number(event.key);
      if (!Number.isNaN(num) && num >= 1 && num <= tabs.length) {
        setActive(tabs[num - 1]);
      }
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
