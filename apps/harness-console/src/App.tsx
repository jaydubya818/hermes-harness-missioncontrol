import { useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { CapacityBar, CostCard, Panel, Sparkline, StatusRow } from "@agentic-harness/ui-kit";

const tabs = ["Overview", "Missions", "Agents", "Memory", "Code", "Audit", "Settings"] as const;
type Tab = (typeof tabs)[number];
const fetcher = (url: string) => fetch(url).then((r) => r.json());

function TopBar({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 12, borderBottom: "1px solid #1e293b", position: "sticky", top: 0, background: "#020617" }}>
      <div style={{ fontWeight: 800, color: "#7dd3fc", marginRight: 12 }}>HARNESS CONSOLE</div>
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
  return <div style={{ padding: 16 }}><Panel title="Mission Queue">{(data?.missions ?? []).length === 0 ? <div>No missions yet.</div> : <pre>{JSON.stringify(data.missions, null, 2)}</pre>}</Panel></div>;
}

function Agents() { return <div style={{ padding: 16 }}><Panel title="Agents">Registry and context preview will land here.</Panel></div>; }
function Memory() { return <div style={{ padding: 16 }}><Panel title="Memory Plane">Agentic-KB summaries, rewrites, promotions, and context traces will render here.</Panel></div>; }
function Code() { return <div style={{ padding: 16 }}><Panel title="Code Pipeline">Diffs, tests, reviews, and deploy artifacts will render here.</Panel></div>; }
function Audit() { return <div style={{ padding: 16 }}><Panel title="Audit Ledger">Unified mission, policy, memory, and deploy events will render here.</Panel></div>; }
function Settings() { return <div style={{ padding: 16 }}><Panel title="Settings">Policies, integrations, and runtime config will render here.</Panel></div>; }

export function App() {
  const [active, setActive] = useState<Tab>("Overview");
  return (
    <div>
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
