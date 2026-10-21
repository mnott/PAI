import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { endpointRegistry, engineKey, instancesFromProcesses, registeredInstances, readInstances, reconcileInstances, writeInstances, type LocalInstance } from "./local-instances.js";
import { parseLocalConfig } from "./local-tiers.js";

const cfg = parseLocalConfig(
  { local_tiers: { qwen: { provider: "q", model: "/m/qwen", served: "qwen", port: 8034 } } },
  {},
);
const ps = (rows: [number, number][]): string =>
  rows.map(([pid, port]) => `${pid} 1000 /x/python /x/serve_patched.py serve /m/qwen --served-model-name qwen --port ${port}`).join("\n");

const row = (id: string, pid: number, port: number, state: LocalInstance["state"] = "ready"): LocalInstance => ({
  id, model: "qwen", provider: "q", url: `http://127.0.0.1:${port}`, origin: "managed", port, pid, state, startedAt: 1, log: "",
});

describe("reconcileInstances", () => {
  it("drops a row whose pid is gone, keeps failed rows", () => {
    const servers = instancesFromProcesses(ps([[10, 8034]]), cfg, {}, 1);
    const out = reconcileInstances([row("qwen#1", 10, 8034), row("qwen#2", 99, 8035), row("qwen#3", 98, 8036, "failed")], servers, cfg);
    expect(out.map((r) => r.id)).toEqual(["qwen#1", "qwen#3"]);
  });

  it("adopts a server of a catalogue model that has no row", () => {
    const servers = instancesFromProcesses(ps([[10, 8034]]), cfg, {}, 1);
    const out = reconcileInstances([], servers, cfg, 5);
    expect(out).toEqual([{ id: "qwen#1", model: "qwen", provider: "q", url: "http://127.0.0.1:8034", origin: "managed", port: 8034, pid: 10, state: "ready", startedAt: 5, log: "" }]);
  });

  it("ignores a server of an unknown model", () => {
    const servers = instancesFromProcesses("7 1 /x/python /x/serve_patched.py serve /m/other --port 9000", cfg, {}, 1);
    expect(reconcileInstances([], servers, cfg)).toEqual([]);
  });

  it("two processes of one model become #1 and #2, an existing #2 keeps its number", () => {
    const servers = instancesFromProcesses(ps([[10, 8034], [11, 8035]]), cfg, {}, 1);
    expect(reconcileInstances([], servers, cfg).map((r) => [r.id, r.port])).toEqual([["qwen#1", 8034], ["qwen#2", 8035]]);
    const kept = reconcileInstances([row("qwen#2", 11, 8035)], servers, cfg);
    expect(kept.map((r) => [r.id, r.port])).toEqual([["qwen#1", 8034], ["qwen#2", 8035]]);
  });
});

describe("registered endpoints", () => {
  it("come from providers, skip catalogue providers, survive reconcile untouched", () => {
    const reg = registeredInstances(
      { q: { url: "http://127.0.0.1:8034/v1" }, remote: { url: "http://box.lan:8000/", characteristics: { classes: ["t1"], contextTokens: 32000 } }, none: {} },
      cfg,
    );
    expect(reg).toEqual([expect.objectContaining({ id: "remote", origin: "registered", url: "http://box.lan:8000", port: 8000, characteristics: { classes: ["t1"], contextTokens: 32000 } })]);
    expect(reg[0].pid).toBeUndefined();
    expect(reconcileInstances(reg, [], cfg)).toEqual([]);
  });
});

describe("state file and keys", () => {
  it("round-trips atomically and reads a missing or corrupt file as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "inst-"));
    expect(readInstances(dir)).toEqual([]);
    writeInstances(dir, [row("qwen#1", 10, 8034)]);
    expect(readInstances(dir)).toEqual([row("qwen#1", 10, 8034)]);
  });

  it("engine key keeps the bare provider for #1", () => {
    expect(engineKey("q", 1)).toBe("q");
    expect(engineKey("q", 2)).toBe("q#2");
  });
});

describe("endpointRegistry", () => {
  it("merges managed instances with enabled providers that declare characteristics", () => {
    const managed = [row("qwen#1", 10, 8034)];
    const out = endpointRegistry(
      managed,
      {
        q: { baseUrl: "http://127.0.0.1:8034/v1", characteristics: { tags: ["x"] } },
        box: { baseUrl: "http://box.lan:8000", characteristics: { classes: ["t1"] } },
        off: { enabled: false, baseUrl: "http://off.lan:1", characteristics: {} },
        cloud: { baseUrl: "https://api.example.com" },
      },
      cfg,
    );
    expect(out.map((i) => [i.id, i.origin])).toEqual([["qwen#1", "managed"], ["box", "registered"]]);
  });
});
