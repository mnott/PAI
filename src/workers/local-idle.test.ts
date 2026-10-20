import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_IDLE, evaluate, localIdleLine, parseGpuUtilization, setMuted, readMuted, type LocalIdleState, type LocalProviderSample, type LocalSample } from "./local-idle.js";

const cfg = DEFAULT_LOCAL_IDLE;
const MIN = 60_000;
const fresh = (): LocalIdleState => ({ idleSince: null, lastNudge: {} });
const prov = (over: Partial<LocalProviderSample> = {}): LocalProviderSample => ({
  provider: "gyro-m",
  cap: 4,
  queued: 0,
  workers: [
    { id: "w1", activity: "build", iterm: "T1", name: "caseleaf" },
    { id: "w2", activity: "test", iterm: "T1", name: "caseleaf" },
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
    expect(nudges[0].targets).toEqual([{ iterm: "T1", name: "caseleaf", ids: ["w1", "w2"] }]);
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
    const { nudges } = run(3, 0, [prov()], new Set(["caseleaf"]));
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
    expect(line).toBe("local model: idle 0% · gyro-m 2/4 running, 2 free");
    expect(readFileSync(join(dir, "local-idle-muted.json"), "utf8")).toBe("[]");
  });
});
