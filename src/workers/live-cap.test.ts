/**
 * A saved config change reaches running processes without a restart: the capacity
 * gate re-reads the cap on every poll, the cached workers loader follows the file
 * mtimes, the pool host re-reads its settings. Fake clocks, temp config only.
 */

import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capacityGate, type CapacityInfo } from "./capacity.js";
import { defaultWorkersConfig, type WorkersConfig } from "./config.js";
import type { WorkerStatus } from "./status.js";
import { createPoolHost } from "./pool-host.js";

const DEAD = 999999;
const st = (id: string, over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id, pid: 100, provider: "p", state: "running", turns: 0, origin: "spawn", ...over }) as WorkerStatus;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function gate(holders: WorkerStatus[], capOf: (t: number) => number | undefined, cap = 1) {
  const logDir = mkdtempSync(join(tmpdir(), "live-cap-"));
  dirs.push(logDir);
  let t = 0;
  const waits: (CapacityInfo | null)[] = [];
  const base = {
    logDir,
    self: { id: "self", provider: "p", pid: 200 },
    cap,
    capOf: () => capOf(t),
    config: defaultWorkersConfig().capacity,
    onWait: (w: CapacityInfo | null) => waits.push(w),
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      if (t > 600_000) throw new Error("never admitted within ten virtual minutes");
    },
    load: () => holders,
    isAlive: (pid: number) => pid !== DEAD,
  };
  return { base, waits, at: () => t };
}

describe("capacityGate re-reads the cap while waiting", () => {
  it("a raised cap admits a waiting run within one poll", async () => {
    const h = gate([st("a")], (t) => (t >= 20_000 ? 2 : 1));
    const r = await capacityGate(h.base);
    expect(r).not.toBeNull();
    expect(r!.cap).toBe(2);
    expect(h.at()).toBeGreaterThanOrEqual(20_000);
    expect(h.at()).toBeLessThan(60_000);
    expect(h.waits.at(-1)).toBeNull();
  });

  it("without capOf the start cap stays (the holder never leaves, so the harness gives up)", async () => {
    const h = gate([st("a")], () => undefined);
    await expect(capacityGate(h.base)).rejects.toThrow(/never admitted/);
  });

  it("a lowered cap never touches a holder: the run keeps waiting until holders drop below it", async () => {
    const a = st("a"), b = st("b");
    // cap 2 -> 1 from the start; a leaves at 40 s (one holder left: still full), b at 80 s
    const h = gate([a, b], () => 1, 2);
    const r = await capacityGate({
      ...h.base,
      load: () => [h.at() >= 40_000 ? st("a", { state: "done", pid: DEAD }) : a, h.at() >= 80_000 ? st("b", { state: "done", pid: DEAD }) : b],
    });
    expect(r!.cap).toBe(1);
    expect(h.at()).toBeGreaterThanOrEqual(80_000);
    expect([a.state, b.state]).toEqual(["running", "running"]);
  });
});

describe("readWorkersCached follows the config files", () => {
  const saved = { home: process.env.HOME, pai: process.env.PAI_HOME, cfg: process.env.PAI_CONFIG_FILE, yaml: process.env.PAI_WORKERS_YAML };
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "live-cap-home-"));
    process.env.HOME = home;
    // A PAI_HOME equal to HOME makes ~/.pai/<x> look like an old location of <home>/<x>.
    process.env.PAI_HOME = join(home, "pai-home");
    process.env.PAI_CONFIG_FILE = join(home, "config.yaml");
    process.env.PAI_WORKERS_YAML = join(home, "workers.yaml");
    writeFileSync(process.env.PAI_CONFIG_FILE, "{}\n");
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of [["HOME", saved.home], ["PAI_HOME", saved.pai], ["PAI_CONFIG_FILE", saved.cfg], ["PAI_WORKERS_YAML", saved.yaml]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("reuses the parsed config until a file's mtime moves, then reloads", async () => {
    const { readWorkersCached, workersConfigStamp } = await import("./config.js");
    const yaml = process.env.PAI_WORKERS_YAML!;
    const { writeWorkersYamlText, starterWorkersYamlText } = await import("./workers-config.js");
    const { addProvider, setProviderCap } = await import("./providers.js");
    writeWorkersYamlText(yaml, starterWorkersYamlText());
    addProvider({ name: "loc", baseUrl: "http://127.0.0.1:8123", model: "m" });
    setProviderCap("loc", 2);
    utimesSync(yaml, 1_800_000_000, 1_800_000_000);
    const a = readWorkersCached();
    expect(a.providers.loc?.maxConcurrent).toBe(2);
    expect(readWorkersCached()).toBe(a); // same object: no re-parse
    const stamp = workersConfigStamp();
    setProviderCap("loc", 5);
    utimesSync(yaml, 1_800_000_100, 1_800_000_100);
    expect(workersConfigStamp()).not.toBe(stamp);
    expect(readWorkersCached().providers.loc?.maxConcurrent).toBe(5);
  });
});

describe("pool host re-reads its settings", () => {
  const cfg = (maxSlots: number, spares = 0): WorkersConfig => {
    const c = defaultWorkersConfig();
    return { ...c, pool: { ...c.pool, enabled: true, maxSlots, spares } };
  };

  it("a changed maxSlots applies after the stamp moves, at most every 5 s", () => {
    const logDir = mkdtempSync(join(tmpdir(), "live-cap-pool-"));
    dirs.push(logDir);
    let stamp = "v1";
    let live = cfg(2);
    let t = 1_000_000;
    const host = createPoolHost({
      config: live,
      logDir,
      configStamp: () => stamp,
      readConfig: () => live,
      now: () => new Date(t),
      noReaper: true,
      envFor: () => ({}),
      cmdHead: () => ["fake-claude"],
    });
    expect(host.settings().maxSlots).toBe(2);
    live = cfg(6, 1);
    expect(host.reloadSettings()).toBe(false); // stamp unchanged
    stamp = "v2";
    expect(host.reloadSettings()).toBe(false); // checked less than 5 s ago
    expect(host.settings().maxSlots).toBe(2);
    t += 5_000;
    expect(host.reloadSettings()).toBe(true);
    expect(host.settings().maxSlots).toBe(6);
    expect(host.settings().spares).toBe(1);
    stamp = "v3";
    live = cfg(1);
    expect(host.reloadSettings(true)).toBe(true); // force skips the 5 s guard
    expect(host.settings().maxSlots).toBe(1);
    void host.shutdown();
  });

  it("the workers config follows the reload: a provider added later is offered without a restart", () => {
    const logDir = mkdtempSync(join(tmpdir(), "live-cap-pool-cfg-"));
    dirs.push(logDir);
    const withProviders = (providers: WorkersConfig["providers"]): WorkersConfig => ({ ...cfg(1), providers });
    let stamp = "v1";
    let live = withProviders({});
    let t = 1_000_000;
    const host = createPoolHost({
      config: live,
      logDir,
      configStamp: () => stamp,
      readConfig: () => {
        if (stamp === "v2") throw new Error("half-written file");
        return live;
      },
      now: () => new Date(t),
      noReaper: true,
      envFor: () => ({}),
      cmdHead: () => ["fake-claude"],
    });
    expect(host.offersModel("newprov", "nm")).toBe(false);
    live = withProviders({ newprov: { enabled: true, protocol: "anthropic", baseUrl: "https://example.invalid", keyFile: null, models: { default: "nm" }, env: {} } });
    stamp = "v2";
    t += 5_000;
    expect(host.reloadSettings()).toBe(false); // parse failure: the old config stays in force
    expect(host.offersModel("newprov", "nm")).toBe(false);
    stamp = "v3";
    expect(host.reloadSettings(true)).toBe(true);
    expect(host.offersModel("newprov", "nm")).toBe(true);
    void host.shutdown();
  });
});
