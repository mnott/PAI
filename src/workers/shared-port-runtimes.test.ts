/**
 * Runtimes sharing one port: the running one is the runtime whose --config
 * model_name the server reports on /v1/models; stop refuses another runtime's
 * server, start stops the holder first. All I/O is stubbed (fetch, config files).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkersConfig } from "./config.js";
import { computeInventory, type InventoryDeps, type InventoryInput } from "./model-inventory.js";
import { expectedRuntimeModel, foreignPortHolder, type RuntimeCommands } from "./model-runtimes.js";
import { runtimeStartStop } from "../router/cockpit-actions.js";

const cfgDir = mkdtempSync(join(tmpdir(), "pai-shared-port-"));
mkdirSync(join(cfgDir, "r2"));
writeFileSync(join(cfgDir, "r2", "gm-new.json"), JSON.stringify({ model_name: "qwen3.8-flash-next-gyro-m" }));
writeFileSync(join(cfgDir, "r2", "cl-mtp.json"), JSON.stringify({ model_name: "qwen3.8-flash-next-gyro-coder-l" }));
process.on("exit", () => rmSync(cfgDir, { recursive: true, force: true }));

const startCmd = (file: string) => `cd /tmp && exec python serve/server.py --engine strata --config "${cfgDir}/r2/${file}" --port 8035`;
const stop = "kill $(lsof -nP -iTCP:8035 -sTCP:LISTEN -t)";
const commands: Record<string, RuntimeCommands> = {
  "gyro-m": { start: startCmd("gm-new.json"), stop, ready: "http://127.0.0.1:8035/v1/models" },
  "coder-l": { start: startCmd("cl-mtp.json"), stop, ready: "http://127.0.0.1:8035/v1/models" },
};
const GM = "qwen3.8-flash-next-gyro-m";
const CL = "qwen3.8-flash-next-gyro-coder-l";

const prov = (model: string) => ({ enabled: true, protocol: "anthropic" as const, baseUrl: "http://127.0.0.1:8035", keyFile: null, env: {}, models: { default: model, fast: model } });
const providers = { "gyro-m": prov(GM), "coder-l": prov(CL) } as unknown as WorkersConfig["providers"];

const invInput = (cmds: Record<string, RuntimeCommands> | undefined): InventoryInput => ({
  providers,
  commands: cmds,
  embedding: { backend: "transformers-cpu-q8", ollamaUrl: "http://127.0.0.1:11434", inProcessModel: "snowflake" },
  runtimes: [],
  consumers: [],
});
const invDeps = (served: string | null): InventoryDeps => ({
  getJson: async (url) => (url === "http://127.0.0.1:8035/v1/models" && served ? { data: [{ id: served }] } : null),
  run: async () => null,
  memory: async () => undefined,
});
const row = (inv: Awaited<ReturnType<typeof computeInventory>>, name: string) => inv.runtimes.find((r) => r.name === name);

describe("expectedRuntimeModel", () => {
  it("reads model_name from the --config JSON, expanding $HOME", () => {
    expect(expectedRuntimeModel(commands["coder-l"])).toBe(CL);
    expect(expectedRuntimeModel({ start: 'x --config "$HOME/a.json"' }, (p) => (p.endsWith("/a.json") && !p.includes("$") ? '{"model_name":"m"}' : "{}"))).toBe("m");
  });
  it("is undefined without a config, a readable file or a model_name", () => {
    expect(expectedRuntimeModel({ start: "ollama serve" })).toBeUndefined();
    expect(expectedRuntimeModel({ start: "x --config /nonexistent.json" })).toBeUndefined();
    expect(expectedRuntimeModel({ start: "x --config /a.json" }, () => "{}")).toBeUndefined();
  });
});

describe("inventory with two runtimes on one port", () => {
  it("attributes the server to coder-l when /v1/models reports the coder-l model", async () => {
    const inv = await computeInventory(invInput(commands), invDeps(CL));
    expect(row(inv, "coder-l")?.status).toBe("running");
    expect(row(inv, "gyro-m")?.status).toBe("stopped");
    expect(row(inv, "gyro-m")?.portNote).toBe("port in use by coder-l");
  });
  it("attributes it to gyro-m when that model is loaded", async () => {
    const inv = await computeInventory(invInput(commands), invDeps(GM));
    expect(row(inv, "gyro-m")?.status).toBe("running");
    expect(row(inv, "coder-l")?.status).toBe("stopped");
  });
  it("falls back to the port-only rule when no model can be determined", async () => {
    const inv = await computeInventory(invInput({}), invDeps(CL));
    expect(inv.runtimes.filter((r) => r.port === 8035)).toHaveLength(1);
    expect(row(inv, "gyro-m")?.status).toBe("running");
  });
  it("a single runtime on its port is unchanged", async () => {
    const one = { "gyro-m": providers["gyro-m" as keyof typeof providers] } as WorkersConfig["providers"];
    const inv = await computeInventory({ ...invInput(commands), providers: one }, invDeps(GM));
    expect(inv.runtimes.filter((r) => r.port === 8035).map((r) => [r.name, r.status])).toEqual([["gyro-m", "running"]]);
  });
});

describe("stop / start across a shared port", () => {
  const mkDeps = (served: string[] | null, ran: string[], spawned: string[] = []) =>
    ({
      home: cfgDir,
      ledger: join(cfgDir, "ledger.log"),
      workers: {},
      runtimeCommands: commands,
      runtimeOps: {
        runShell: async (cmd: string, log: string) => (ran.push(log.split("/").pop()!.replace(".log", "") + ": " + cmd), { code: 0 }),
        spawnDetached: (cmd: string) => (spawned.push(cmd), { exit: new Promise<{ code: number | null }>(() => {}) }),
        getUrl: async () => served !== null,
        runCmd: async () => 1,
        servedModels: async () => served,
        now: () => 0,
        sleep: async () => undefined,
      },
    }) as never;

  it("foreignPortHolder names coder-l for gyro-m while coder-l runs", async () => {
    expect(await foreignPortHolder("gyro-m", commands, async () => [CL])).toBe("coder-l");
    expect(await foreignPortHolder("coder-l", commands, async () => [CL])).toBeNull();
    expect(await foreignPortHolder("gyro-m", commands, async () => null)).toBeNull();
  });
  it("stop gyro-m refuses while coder-l runs, and runs nothing", async () => {
    const ran: string[] = [];
    const r = await runtimeStartStop("gyro-m", "stop", mkDeps([CL], ran));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("belongs to coder-l");
    expect(ran).toEqual([]);
  });
  it("stop gyro-m --force runs the stop command", async () => {
    const ran: string[] = [];
    const r = await runtimeStartStop("gyro-m", "stop", mkDeps([CL], ran), { force: true });
    expect(r.ok).toBe(true);
    expect(ran).toHaveLength(1);
  });
  it("stop coder-l (the owner) runs", async () => {
    const ran: string[] = [];
    expect((await runtimeStartStop("coder-l", "stop", mkDeps([CL], ran))).ok).toBe(true);
    expect(ran).toHaveLength(1);
  });
  it("start gyro-m while coder-l holds the port stops coder-l first and says so", async () => {
    const ran: string[] = [];
    const spawned: string[] = [];
    const r = await runtimeStartStop("gyro-m", "start", mkDeps([CL], ran, spawned));
    expect(ran).toEqual([expect.stringMatching(/^coder-l: kill/)]);
    expect(spawned).toHaveLength(1);
    expect(r.message).toContain("stopped coder-l first");
  });
});
