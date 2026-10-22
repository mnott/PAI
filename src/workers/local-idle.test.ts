import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWorkersConfig, type WorkersConfig } from "./config.js";
import { evaluate, localIdleTick, ownerOf, localIdleLine, parseGpuUtilization, takeSample, setMuted, readMuted, type LocalIdleState, type LocalProviderSample, type LocalSample } from "./local-idle.js";

const cfg = defaultWorkersConfig().localIdle;
const MIN = 60_000;
const fresh = (): LocalIdleState => ({ idleSince: null, lastNudge: {} });
const prov = (over: Partial<LocalProviderSample> = {}): LocalProviderSample => ({
  provider: "gyro-m",
  cap: 4,
  queued: 0,
  workers: [
    { id: "w1", activity: "build", iterm: "T1", name: "myapp" },
    { id: "w2", activity: "test", iterm: "T1", name: "myapp" },
  ],
  ...over,
});
const at = (t: number, gpu: number | null, p: LocalProviderSample[]): LocalSample => ({ at: t, gpuPct: gpu, providers: p });

/** Feed samples 30 s apart from t=0 to `mins` minutes; returns every nudge. */
function run(mins: number, gpu: number | null, p: LocalProviderSample[], muted = new Set<string>()) {
  let st = fresh();
  const all = [];
  for (let t = 0; t <= mins * MIN; t += 30_000) {
    const r = evaluate(st, at(t, gpu, p), cfg, muted);
    st = r.state;
    all.push(...r.nudges);
  }
  return { nudges: all, st };
}

describe("local idle watcher", () => {
  it("parses Device Utilization %", () => {
    expect(parseGpuUtilization('"PerformanceStatistics" = {"Device Utilization %"=37,"Renderer Utilization %"=2}')).toBe(37);
    expect(parseGpuUtilization("nothing")).toBeNull();
  });

  it("idle GPU for 2 min, all workers in builds, free slots, empty queue -> exactly one nudge for the owning session", () => {
    const { nudges } = run(5, 0, [prov()]);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].free).toBe(2);
    expect(nudges[0].targets).toEqual([{ iterm: "T1", name: "myapp", ids: ["w1", "w2"] }]);
  });

  it("no nudge before the idle minutes elapse", () => {
    expect(run(1.5, 0, [prov()]).nudges).toHaveLength(0);
  });

  it("backs off 10 min, then nudges again", () => {
    expect(run(11, 0, [prov()]).nudges).toHaveLength(1);
    expect(run(13, 0, [prov()]).nudges).toHaveLength(2);
  });

  it("nobody running counts as idle too (empty target list)", () => {
    const { nudges } = run(3, 0, [prov({ workers: [] })]);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].targets).toEqual([]);
  });

  it("no nudge when a worker is generating", () => {
    const w = prov().workers.concat({ id: "w3", activity: "generating", iterm: "T2" });
    expect(run(5, 0, [prov({ workers: w })]).nudges).toHaveLength(0);
  });

  it("no nudge when local work is queued", () => {
    expect(run(5, 0, [prov({ queued: 1 })]).nudges).toHaveLength(0);
  });

  it("no nudge without a free slot", () => {
    expect(run(5, 0, [prov({ cap: 2 })]).nudges).toHaveLength(0);
  });

  it("no nudge while the GPU is busy (queue or not), or unmeasurable", () => {
    expect(run(5, 60, [prov({ queued: 3 })]).nudges).toHaveLength(0);
    expect(run(5, null, [prov()]).nudges).toHaveLength(0);
  });

  it("a busy sample resets the idle spell", () => {
    let st = fresh();
    const seq: Array<[number, number]> = [[0, 0], [60_000, 0], [90_000, 80], [120_000, 0], [180_000, 0]];
    const got = seq.flatMap(([t, g]) => {
      const r = evaluate(st, at(t, g, [prov()]), cfg);
      st = r.state;
      return r.nudges;
    });
    expect(got).toHaveLength(0);
  });

  it("a muted session is not told", () => {
    const { nudges } = run(3, 0, [prov()], new Set(["myapp"]));
    expect(nudges[0].targets).toEqual([]);
  });

  it("disabled config never nudges", () => {
    const r = evaluate({ idleSince: 0, lastNudge: {} }, at(10 * MIN, 0, [prov()]), { ...cfg, enabled: false });
    expect(r.nudges).toHaveLength(0);
  });

  it("persists mutes and renders the ps line", () => {
    const dir = mkdtempSync(join(tmpdir(), "idle-"));
    expect(setMuted(dir, "a", true)).toEqual(["a"]);
    expect(readMuted(dir)).toEqual(["a"]);
    expect(setMuted(dir, "a", false)).toEqual([]);
    const now = Date.now();
    const line = localIdleLine({ at: new Date(now).toISOString(), gpuPct: 0, idleSince: null, lastNudge: {}, providers: [{ provider: "gyro-m", cap: 4, running: 2, free: 2, queued: 0, activity: { build: 2 } }] }, now);
    expect(line).toBe("local model: GPU 0% idle · gyro-m 2/4 running, 2 free");
    expect(readFileSync(join(dir, "local-idle-muted.json"), "utf8")).toBe("[]");
  });

  it("line names the GPU unambiguously", () => {
    const now = Date.now();
    const f = { at: new Date(now).toISOString(), gpuPct: 87, idleSince: null, lastNudge: {}, providers: [{ provider: "gyro-m", cap: 4, running: 4, free: 0, queued: 0, activity: {} }] };
    expect(localIdleLine(f, now)).toBe("local model: GPU 87% busy · gyro-m 4/4 running, 0 free");
  });

  describe("takeSample lists only served providers", () => {
    const local = (enabled: boolean) => ({ enabled, baseUrl: "http://127.0.0.1:8010/v1", maxConcurrent: 2 });
    const cfg2 = { providers: { gyro: local(true), off: local(false), down: local(true), cloud: { enabled: true, baseUrl: "https://api.example.com" } } } as unknown as WorkersConfig;
    const status = (provider: string | null) => ({ at: new Date().toISOString(), running: provider ? [{ provider, model: "m", why: "" }] : [], down: [], disabled: [] });
    const names = async (dir: string, st: ReturnType<typeof status>) => (await takeSample(dir, cfg2, Date.now(), async () => 50, st)).providers.map((p) => p.provider);
    const tmp = () => mkdtempSync(join(tmpdir(), "pai-li-"));

    it("only the enabled served provider", async () => {
      expect(await names(tmp(), status("gyro"))).toEqual(["gyro"]);
    });
    it("nothing served, no work: nothing listed", async () => {
      expect(await names(tmp(), status(null))).toEqual([]);
    });
    it("a disabled provider is never served", async () => {
      expect(await names(tmp(), status("off"))).toEqual([]);
    });
    it("a provider with a running worker is listed even when unserved", async () => {
      const dir = tmp();
      writeFileSync(join(dir, "w1.status"), JSON.stringify({ id: "w1", provider: "down", state: "running", pid: process.pid, started: new Date().toISOString(), last: "" }));
      expect(await names(dir, status("gyro"))).toEqual(["gyro", "down"]);
    });
  });
});

describe("owner resolution and delivery", () => {
  const myApp = {
    id: "20261020-020000-111",
    cwd: "/Users/someone/dev/MyApp",
    term: "w8t0p0:0A1A0BFE-1111-4222-8333-444455556666",
    provider: "gyro-m",
    state: "running",
    pid: process.pid,
    started: new Date().toISOString(),
    last: "",
    session: { name: "MyApp" },
    spawnerSession: "c0ffee00-spawner",
  };
  const workers = { providers: { "gyro-m": { enabled: true, baseUrl: "http://127.0.0.1:8010/v1", maxConcurrent: 4 } }, localIdle: defaultWorkersConfig().localIdle } as unknown as WorkersConfig;

  it("ownerOf strips the ITERM_SESSION_ID prefix and keeps name and spawner", () => {
    expect(ownerOf(myApp as never)).toEqual({ iterm: "0A1A0BFE-1111-4222-8333-444455556666", name: "MyApp", claudeSession: "c0ffee00-spawner" });
    expect(ownerOf({ term: "" } as never)).toEqual({ iterm: undefined, name: undefined, claudeSession: undefined });
  });

  it("the tick sends to the bare uuid taken from a real status file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-li-"));
    writeFileSync(join(dir, `${myApp.id}.status`), JSON.stringify(myApp));
    const calls: Array<{ iterm?: string; name?: string }> = [];
    const msg = { toSession: async (o: { iterm?: string; name?: string }) => (calls.push(o), true), toPailot: async () => true };
    const sample = await takeSample(dir, workers, 0, async () => 0, null);
    const st = { current: { idleSince: 0, lastNudge: {} } as LocalIdleState };
    await localIdleTick(dir, workers, msg, { sample: async () => ({ ...sample, at: 3 * MIN, providers: sample.providers.map((p) => ({ ...p, workers: p.workers.map((w) => ({ ...w, activity: "build" as const })) })) }), now: () => 3 * MIN }, st);
    expect(calls).toEqual([{ iterm: "0A1A0BFE-1111-4222-8333-444455556666", name: "MyApp", claudeSession: "c0ffee00-spawner" }]);
  });

  it("a failed delivery is logged as LOCAL-IDLE-UNDELIVERED with the reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-li-"));
    const msg = { toSession: async () => false, lastError: "no such session", toPailot: async () => true };
    const p = prov({ workers: [{ id: "w1", activity: "build", iterm: "U1", name: "MyApp" }] });
    await localIdleTick(dir, workers, msg, { sample: async () => at(3 * MIN, 0, [p]), now: () => 3 * MIN }, { current: { idleSince: 0, lastNudge: {} } });
    const led = readFileSync(join(dir, "ledger.log"), "utf8");
    expect(led).toContain("LOCAL-IDLE-UNDELIVERED");
    expect(led).toContain("no such session");
  });

  it("max 6 nudges per hour per session", () => {
    let st = fresh();
    let n = 0;
    for (let t = 0; t <= 60 * MIN; t += 30_000) {
      const r = evaluate(st, at(t, 0, [prov()]), { ...cfg, backoffMinutes: 1 });
      st = r.state;
      n += r.nudges.reduce((a, x) => a + x.targets.length, 0);
    }
    expect(n).toBe(6);
  });
});
