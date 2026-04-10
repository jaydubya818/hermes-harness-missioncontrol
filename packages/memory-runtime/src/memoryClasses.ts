import type { MemoryClass } from "@agentic-harness/shared-types";

export const MEMORY_CLASSES: Record<MemoryClass, { appendOnly: boolean; defaultFile: string }> = {
  profile: { appendOnly: false, defaultFile: "profile.md" },
  hot: { appendOnly: false, defaultFile: "hot.md" },
  working: { appendOnly: true, defaultFile: "task-log.md" },
  learned: { appendOnly: true, defaultFile: "learned.md" },
  rewrite: { appendOnly: true, defaultFile: "rewrites.md" },
  bus: { appendOnly: true, defaultFile: "bus.md" }
};
