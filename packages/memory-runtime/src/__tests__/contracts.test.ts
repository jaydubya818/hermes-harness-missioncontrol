import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContract } from "../contracts.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("loadContract", () => {
  it("parses the agent contract shipped in config/agents", async () => {
    // Nothing in the running system loads config/agents/*.yaml yet (see the
    // 2026-08-23 backlog item), so this file has no other validator: a
    // renamed or mistyped field there is invisible until the day something
    // does read it. Pin the shape the loader declares against the fixture
    // the repo actually ships.
    const contract = await loadContract(join(repoRoot, "config", "agents", "agent_demo.yaml"));

    expect(contract.id).toBe("agent_demo");
    expect(["worker", "lead", "orchestrator"]).toContain(contract.tier);
    expect(typeof contract.domain).toBe("string");
    expect(contract.domain).not.toBe("");
    expect(Number.isInteger(contract.budget_bytes)).toBe(true);
    expect(contract.budget_bytes).toBeGreaterThan(0);

    // reads/writes/forbidden_paths address vault entries and are joined onto
    // a vault root by every containment helper in this package, so they have
    // to stay relative and non-empty.
    for (const path of [...contract.reads, ...contract.writes, ...(contract.forbidden_paths ?? [])]) {
      expect(typeof path).toBe("string");
      expect(path).not.toBe("");
      expect(path.startsWith("/")).toBe(false);
      expect(path.split("/")).not.toContain("..");
    }
    expect(contract.reads.length).toBeGreaterThan(0);
    expect(contract.writes.length).toBeGreaterThan(0);
  });

  it("propagates a read failure rather than returning a partial contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memrt-contract-"));
    await expect(loadContract(join(dir, "absent.yaml"))).rejects.toThrow();
  });

  it("throws on malformed YAML", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memrt-contract-"));
    const file = join(dir, "broken.yaml");
    writeFileSync(file, "id: agent_demo\n  tier: [unclosed\n", "utf8");
    await expect(loadContract(file)).rejects.toThrow();
  });

  it("returns well-formed YAML of the wrong shape unchanged, without validating it", async () => {
    // Characterization, not an endorsement: loadContract is a bare
    // `YAML.parse(raw) as AgentContract`, so anything that parses is handed
    // back with the contract type asserted onto it. A caller reading
    // `contract.budget_bytes` off either of these gets undefined at runtime
    // with no type error, which is why the backlog item that asks for a real
    // consumer also has to ask for validation here.
    const dir = mkdtempSync(join(tmpdir(), "memrt-contract-"));

    const scalar = join(dir, "scalar.yaml");
    writeFileSync(scalar, "just a string\n", "utf8");
    expect(await loadContract(scalar)).toBe("just a string" as unknown as never);

    const partial = join(dir, "partial.yaml");
    writeFileSync(partial, "id: agent_partial\n", "utf8");
    const loaded = await loadContract(partial);
    expect(loaded.id).toBe("agent_partial");
    expect(loaded.tier).toBeUndefined();
    expect(loaded.budget_bytes).toBeUndefined();
  });
});
