import { useEffect, useMemo, useState } from "react";
import { filterCommands } from "./api.js";

export interface CommandItem {
  id: string;
  label: string;
  action: () => void;
}

export function CommandPalette({ commands }: { commands: CommandItem[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // Toggling always starts a fresh search: reopening with the previous
        // session's stale query would show a pre-filtered list.
        setQuery("");
        setHighlight(0);
        setOpen((prev) => !prev);
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === "Escape") setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  // Typing can shrink the list below the highlighted index; clamp instead of
  // letting Enter silently do nothing.
  const activeIndex = Math.min(highlight, Math.max(filtered.length - 1, 0));

  function runCommand(command: CommandItem) {
    command.action();
    setOpen(false);
    setQuery("");
    setHighlight(0);
  }

  if (!open) return null;

  return (
    <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.75)", display: "flex", justifyContent: "center", paddingTop: "18vh", zIndex: 1000 }}>
      <div onClick={(event) => event.stopPropagation()} style={{ width: 560, border: "1px solid #334155", borderRadius: 14, background: "#020617", overflow: "hidden", boxShadow: "0 24px 80px rgba(15,23,42,0.6)" }}>
        <input
          autoFocus
          value={query}
          onChange={(event) => { setQuery(event.target.value); setHighlight(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlight(Math.min(activeIndex + 1, Math.max(filtered.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight(Math.max(activeIndex - 1, 0));
            } else if (event.key === "Enter" && filtered[activeIndex]) {
              event.preventDefault();
              runCommand(filtered[activeIndex]);
            }
          }}
          placeholder="Jump to view or action..."
          style={{ width: "100%", background: "#020617", color: "#e2e8f0", padding: 16, border: 0, borderBottom: "1px solid #1e293b", fontSize: 15, outline: "none" }}
        />
        <div style={{ maxHeight: 320, overflow: "auto" }}>
          {filtered.map((command, index) => (
            <button
              key={command.id}
              onClick={() => runCommand(command)}
              onMouseEnter={() => setHighlight(index)}
              style={{ width: "100%", textAlign: "left", border: 0, borderBottom: "1px solid #0f172a", background: index === activeIndex ? "#111827" : "transparent", color: "#e2e8f0", padding: 14, cursor: "pointer" }}
            >
              {command.label}
            </button>
          ))}
          {filtered.length === 0 && <div style={{ padding: 16, color: "#94a3b8" }}>No matching commands.</div>}
        </div>
      </div>
    </div>
  );
}
