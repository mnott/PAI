/**
 * local_tiers sharing one port: the running tier is the one whose config JSON
 * model_name equals the model /v1/models reports. All I/O is stubbed.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkersConfig } from "./config.js";
import { computeInventory, type InventoryDeps, type InventoryInput } from "./model-inventory.js";

const dir = mkdtempSync(join(tmpdir(), "pai-shared-tiers-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const names: Record<string, string> = { iq3s: "flash-next-iq3", udq4: "flash-next-udq4", "coder-l": "gyro-coder-l" };
const cfg = (t: string) => {
  const p = join(dir, `${t}.json`);
  writeFileSync(p, JSON.stringify({ model_name: names[t] }));
  return p;
};
const prov = (model: string) => ({ enabled: true, protocol: "anthropic" as const, baseUrl: "http://127.0.0.1:8035", keyFile: null, env: {}, models: { default: model, fast: model } });
const providers = { "flashnext-iq3": prov(names.iq3s), "flashnext-udq4": prov(names.udq4), "coder-l": prov(names["coder-l"]) } as unknown as WorkersConfig["providers"];
const tiers = [
  { provider: "flashnext-iq3", label: "iq3s", tier: "iq3s", config: cfg("iq3s") },
  { provider: "flashnext-udq4", label: "udq4", tier: "udq4", config: cfg("udq4") },
  { provider: "coder-l", label: "coder-l", tier: "coder-l", config: cfg("coder-l") },
];
const input = (t = tiers): InventoryInput => ({
  providers,
  tiers: t,
  embedding: { backend: "transformers-cpu-q8", ollamaUrl: "http://127.0.0.1:11434", inProcessModel: "snowflake" },
  runtimes: [],
  consumers: [],
});
const deps = (served: string): InventoryDeps => ({
  getJson: async (url) => (url === "http://127.0.0.1:8035/v1/models" ? { data: [{ id: served }] } : null),
  run: async () => null,
  memory: async () => undefined,
});
const on8035 = async (served: string, t = tiers) =>
  Object.fromEntries((await computeInventory(input(t), deps(served))).runtimes.filter((r) => r.port === 8035).map((r) => [r.name, r]));

describe("local tiers on one port", () => {
  it("coder-l loaded -> coder-l running, the others stopped with a port note", async () => {
    const rows = await on8035(names["coder-l"]);
    expect(rows["coder-l"].status).toBe("running");
    for (const n of ["flashnext-iq3", "flashnext-udq4"]) {
      expect(rows[n].status).toBe("stopped");
      expect(rows[n].portNote).toBe("port in use by coder-l");
    }
  });
  it("iq3s loaded -> flashnext-iq3 running", async () => {
    const rows = await on8035(names.iq3s);
    expect(rows["flashnext-iq3"].status).toBe("running");
    expect(rows["coder-l"].status).toBe("stopped");
  });
  it("tiers without a readable config keep the port-only rule (one row)", async () => {
    const rows = await on8035(names["coder-l"], tiers.map((t) => ({ ...t, config: join(dir, "missing.json") })));
    expect(Object.keys(rows)).toHaveLength(1);
  });
});
