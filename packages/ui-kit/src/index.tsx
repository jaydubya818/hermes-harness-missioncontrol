import type { ReactNode } from "react";

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ border: "1px solid #263247", borderRadius: 12, padding: 16, background: "#0f172a", color: "#e2e8f0" }}>
      <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1.2, color: "#7dd3fc", marginBottom: 12 }}>{title}</div>
      {children}
    </section>
  );
}

export function CapacityBar({ value, max }: { value: number; max: number }) {
  const pct = max === 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div>
      <div style={{ fontSize: 12, marginBottom: 6 }}>{value}/{max} ({pct}%)</div>
      <div style={{ height: 8, borderRadius: 999, background: "#1e293b" }}>
        <div style={{ width: `${pct}%`, height: 8, borderRadius: 999, background: pct > 85 ? "#fb7185" : "#38bdf8" }} />
      </div>
    </div>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) return null;
  const max = Math.max(...values, 1);
  const points = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * 100},${100 - (v / max) * 100}`).join(" ");
  return <svg viewBox="0 0 100 100" style={{ width: "100%", height: 42 }}><polyline fill="none" stroke="#38bdf8" strokeWidth="3" points={points} /></svg>;
}

export function StatusRow({ label, value }: { label: string; value: ReactNode }) {
  return <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14 }}><span style={{ color: "#94a3b8" }}>{label}</span><span>{value}</span></div>;
}

export function CostCard({ label, amount }: { label: string; amount: string }) {
  return <div style={{ padding: 12, borderRadius: 10, background: "#111827" }}><div style={{ fontSize: 12, color: "#94a3b8" }}>{label}</div><div style={{ fontSize: 24, fontWeight: 700, color: "#f8fafc" }}>{amount}</div></div>;
}
