import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLocalConfig, type RunningServer } from "../../workers/local-tiers.js";
import { localStartView, readLocalStart, readLocalStarts } from "../../workers/local-start.js";
import { readInstances } from "../../workers/local-instances.js";
import { serverLine, startInstance, stopInstance, type StartDeps } from "./worker-config.js";

const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "pai-inst-"));
  const cfg = parseLocalConfig(
    { local_tiers: { big: { engine: "script", provider: "pbig", start: "/x.sh", port: 8035, maxInstances: 3, memoryGb: 10 }, one: { engine: "script", provider: "pone", start: "/y.sh", port: 8050 } } },
    { pbig: { model: "m1" }, pone: { model: "m2" } },
  );
  const live: RunningServer[] = [];
  const launched: number[] = [];
  const deps = (over: StartDeps = {}): StartDeps => ({
    ledger: join(d, "ledger.log"), startDir: d, pollMs: 1, freeGb: async () => 100, bindable: async () => true,
    servers: () => live,
    launch: (plan) => {
      const port = Number(plan.env.PORT);
      launched.push(port);
      const one = plan.argv[1] === "/y.sh";
      live.push({ pid: 1000 + port, rssKb: 1024, port, tier: one ? "one" : "big", provider: one ? "pone" : "pbig" });
      return () => null;
    },
    up: async (port) => live.some((s) => s.port === port),
    ...over,
  });
  return { d, cfg, live, launched, deps };
};

describe("startInstance / stopInstance", () => {
  it("starts two copies of one model on two ports; the second does not stop the first", async () => {
    const { d, cfg, launched, deps } = mk();
    const a = await startInstance(cfg, "big", deps());
    const b = await startInstance(cfg, "big", deps());
    expect([a.id, b.id]).toEqual(["big#1", "big#2"]);
    expect(launched).toEqual([8035, 8036]);
    expect(readInstances(d).map((r) => [r.id, r.port, r.state])).toEqual([["big#1", 8035, "ready"], ["big#2", 8036, "ready"]]);
    expect(readLocalStart(d)).toBeNull();
    expect(readFileSync(join(d, "ledger.log"), "utf8")).toMatch(/LOCAL-START model=big id=big#2 port=8036 pid=9036/);
  });

  it("refuses a start on low memory with the reason, writes nothing, force overrides", async () => {
    const { d, cfg, launched, deps } = mk();
    await expect(startInstance(cfg, "big", deps({ freeGb: async () => 6 }))).rejects.toThrow(/refuse to start big #1: needs ~10 GB, free 6 GB/);
    expect(launched).toEqual([]);
    expect(readInstances(d)).toEqual([]);
    await startInstance(cfg, "big", deps({ freeGb: async () => 6, force: true }));
    expect(launched).toEqual([8035]);
  });

  it("counts a start in flight as used memory", async () => {
    const { d, cfg, deps } = mk();
    const { writeLocalStart } = await import("../../workers/local-start.js");
    writeLocalStart(d, { id: "big#1", tier: "big", provider: "pbig", port: 8035, startedAt: Date.now(), readyMs: 600_000, log: "l", needGb: 10 });
    await expect(startInstance(cfg, "big", deps({ freeGb: async () => 15 }))).rejects.toThrow(/free 5 GB/);
  });

  it("refuses past maxInstances", async () => {
    const { cfg, deps } = mk();
    await startInstance(cfg, "one", deps());
    await expect(startInstance(cfg, "one", deps())).rejects.toThrow(/maxInstances/);
  });

  it("stop one leaves the other; off-style stop all clears the state", async () => {
    const { d, cfg, live, deps } = mk();
    await startInstance(cfg, "big", deps());
    await startInstance(cfg, "big", deps());
    const killed: string[] = [];
    const sd = { ledger: join(d, "ledger.log"), startDir: d, servers: () => live, kill: async (i: { id: string; port: number }) => void (killed.push(i.id), live.splice(live.findIndex((s) => s.port === i.port), 1)) };
    expect((await stopInstance(cfg, "big#1", {}, sd)).map((i) => i.id)).toEqual(["big#1"]);
    expect(readInstances(d).map((r) => r.id)).toEqual(["big#2"]);
    expect(live.map((s) => s.port)).toEqual([8036]);
    await stopInstance(cfg, "big", { all: true }, sd);
    expect(readInstances(d)).toEqual([]);
    expect(killed).toEqual(["big#1", "big#2"]);
    expect(readFileSync(join(d, "ledger.log"), "utf8")).toMatch(/LOCAL-STOP model=big id=big#1/);
  });

  it("stop by model takes the highest number first", async () => {
    const { d, cfg, live, deps } = mk();
    await startInstance(cfg, "big", deps());
    await startInstance(cfg, "big", deps());
    const sd = { ledger: join(d, "l"), startDir: d, servers: () => live, kill: async () => {} };
    expect((await stopInstance(cfg, "big", {}, sd)).map((i) => i.id)).toEqual(["big#2"]);
  });

  it("refuses to stop with requests in flight unless confirmed", async () => {
    const { d, cfg, live, deps } = mk();
    await startInstance(cfg, "big", deps());
    const sd = { ledger: join(d, "l"), startDir: d, servers: () => live, kill: async () => {}, inflight: () => 2 };
    await expect(stopInstance(cfg, "big#1", {}, sd)).rejects.toThrow(/big#1 has 2 request\(s\) in flight/);
    expect(readInstances(d)).toHaveLength(1);
    await stopInstance(cfg, "big#1", {}, { ...sd, confirm: true });
    expect(readInstances(d)).toEqual([]);
  });

  it("records the start while loading and marks that instance failed when the server exits", async () => {
    const { d, cfg, deps } = mk();
    const seen: unknown[] = [];
    let polls = 0;
    await startInstance(cfg, "one", deps({ launch: () => () => null, servers: () => [], up: async () => (seen.push(localStartView(readLocalStart(d))), ++polls > 2) }));
    expect(seen[0]).toMatchObject({ tier: "one", provider: "pone", state: "loading" });
    expect(readLocalStarts(d)).toEqual({});
    await expect(startInstance(cfg, "big", deps({ launch: () => () => 3, servers: () => [], up: async () => false }))).rejects.toThrow(/exited \(3\)/);
    expect(localStartView(readLocalStart(d))).toMatchObject({ state: "failed", message: expect.stringContaining("failed to start, see ") });
    expect(readInstances(d).find((r) => r.id === "big#1")).toMatchObject({ state: "failed", error: "server exited (3)" });
  });

  it("labels a server that no tier or provider claims", () => {
    expect(serverLine({ pid: 5, rssKb: 1024, port: 8011, tier: null, provider: null })).toContain("unknown process on a local-model port");
    expect(serverLine({ pid: 5, rssKb: 1024, port: 8011, tier: null, provider: "local30" })).toContain("provider=local30");
  });
});
