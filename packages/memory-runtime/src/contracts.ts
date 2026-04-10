import { readFile } from "node:fs/promises";
import YAML from "yaml";

export interface AgentContract {
  id: string;
  tier: "worker" | "lead" | "orchestrator";
  domain: string;
  budget_bytes: number;
  reads: string[];
  writes: string[];
  forbidden_paths?: string[];
}

export async function loadContract(path: string): Promise<AgentContract> {
  const raw = await readFile(path, "utf8");
  return YAML.parse(raw) as AgentContract;
}
