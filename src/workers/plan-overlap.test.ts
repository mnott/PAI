import { describe, expect, it } from "vitest";
import { PlanError, parsePlan, type Plan } from "./plan.js";
import { idleText, planStatus, runPlan, type MergeOutcome, type RunLogEntry, type RunnerDeps, type StartRequest, type WorkerOutcome } from "./plan-runner.js";
import { PlanReporter, type Messenger } from "./run-events.js";

const yaml = (parts: string, extra = ""): string => `job: j\nrepo: /r\ngate: gate\nprovider: local\n${extra}units:\n  - id: u\n    parts:\n${parts}`;
const three = (c = "overlap: true"): Plan =>
  parsePlan(yaml(`      - {id: p1, spec: A}\n      - {id: p2, spec: B, depends_on: [p1]}\n      - {id: p3, spec: C, ${c}}\n`), "/x");

const tick = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Workers and merges finish when the test says so; the clock is the test's. */
function manual(failGate: (id: string) => boolean = () => false) {
  const log: RunLogEntry[] = [];
  const t = { now: 0 };
  const workers = new Map<string, () => void>();
  const merges = new Map<string, () => void>();
  const order: string[] = [];
  let live = 0;
  let maxLive = 0;
  const deps: RunnerDeps = {
    now: () => t.now,
    resolveLocal: async (p) => p,
    log: (e) => log.push({ ...e, ts: new Date(t.now).toISOString() }),
    startWorker(r: StartRequest) {
      live++;
      maxLive = Math.max(maxLive, live);
      return new Promise<WorkerOutcome>((res) =>
        workers.set(r.part.id, () => {
          live--;
          res({ id: `w-${r.part.id}`, ok: true, tokens: 10 });
        }),
      );
    },
    merge(id) {
      const part = id.slice(2);
      return new Promise<MergeOutcome>((res) =>
        merges.set(part, () => {
          const ok = !failGate(part);
          if (ok) order.push(part);
          res({ ok, commit: ok ? `c-${part}` : undefined, before: "b", output: ok ? "" : "gate failed" });
        }),
      );
    },
    unitCheck: async () => ({ ok: true, output: "" }),
  };
  return { deps, log, t, workers, merges, order, maxLive: () => maxLive };
}

describe("overlap validation", () => {
  it("rejects overlap on a part that depends on the part before it, directly or through others", () => {
    expect(() => parsePlan(yaml(`      - {id: p1, spec: A}\n      - {id: p2, spec: B, depends_on: [p1], overlap: true}\n`), "/x")).toThrow(/depends on p1/);
    try {
      parsePlan(yaml(`      - {id: p1, spec: A}\n      - {id: p2, spec: B, depends_on: [p1]}\n      - {id: p3, spec: C, depends_on: [p2], overlap: true}\n`), "/x");
      throw new Error("no error");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanError);
      expect((e as PlanError).problems.join()).toMatch(/p3.*depends on p2/);
    }
    expect(() => parsePlan(yaml(`      - {id: p1, spec: A}\n      - {id: p2, spec: B}\n      - {id: p3, spec: C, depends_on: [p1], overlap: true}\n`), "/x")).not.toThrow();
  });
  it("rejects a non-boolean overlap and overlap on the first part; default is off", () => {
    expect(() => parsePlan(yaml(`      - {id: p1, spec: A, overlap: yes please}\n`), "/x")).toThrow(/overlap: must be a boolean/);
    expect(() => parsePlan(yaml(`      - {id: p1, spec: A, overlap: true}\n`), "/x")).toThrow(/first part/);
    expect(three("files: [x]").units[0].parts[2].overlap).toBeUndefined();
    expect(three().units[0].parts[2].overlap).toBe(true);
  });
});

describe("overlap runs", () => {
  it("starts p3 as soon as p2's worker ended, merges in order, records model-idle", async () => {
    const h = manual();
    const run = runPlan(three(), { parallel: 1 }, h.deps);
    await tick();
    h.workers.get("p1")!();
    await tick();
    h.t.now = 700;
    h.merges.get("p1")!();
    await tick();
    expect(h.workers.has("p2")).toBe(true);
    h.t.now = 1000;
    h.workers.get("p2")!(); // p2's worker ends, its gate starts
    h.t.now = 1500;
    await tick();
    expect(h.workers.has("p3")).toBe(true); // p3 started during p2's gate
    expect(h.log.find((e) => e.event === "part-start" && e.part === "p3")?.overlap).toBe(true);
    h.t.now = 4000;
    h.workers.get("p3")!(); // p3 ends first, p2 still gated
    await tick();
    expect(h.merges.has("p3")).toBe(false); // waits for p2's merge
    h.merges.get("p2")!();
    await tick();
    h.merges.get("p3")!();
    const s = await run;
    expect(h.order).toEqual(["p1", "p2", "p3"]);
    expect(s.merged).toEqual(["p1", "p2", "p3"]);
    const idle = h.log.filter((e) => e.event === "model-idle");
    expect(idle.map((e) => [e.part, e.reason])).toContainEqual(["p2", "merge"]);
    expect(idle.find((e) => e.part === "p2")?.ms).toBe(700);
    expect(idle.find((e) => e.part === "p3")?.ms).toBe(0);
    expect(h.log.filter((e) => e.event === "worker-start").map((e) => e.part)).toEqual(["p1", "p2", "p3"]);
    expect(h.log.filter((e) => e.event === "worker-end")).toHaveLength(3);
    const end = h.log.find((e) => e.event === "run-end")!;
    expect(end.overlaps).toBe(1);
    expect(end.idleMs).toBe(idle.reduce((a, e) => a + (e.ms ?? 0), 0));
    const st = planStatus(three(), h.log, 5000);
    expect(st.overlaps).toBe(1);
    expect(st.idleMs).toBe(end.idleMs);
  });

  it("without the flag the next worker waits for the gate", async () => {
    const h = manual();
    const run = runPlan(three("files: [x]"), { parallel: 1 }, h.deps);
    await tick();
    h.workers.get("p1")!();
    await tick();
    h.merges.get("p1")!();
    await tick();
    h.workers.get("p2")!();
    await tick();
    expect(h.workers.has("p3")).toBe(false);
    h.merges.get("p2")!();
    await tick();
    h.workers.get("p3")!();
    await tick();
    h.merges.get("p3")!();
    await run;
    expect(h.log.filter((e) => e.event === "part-start" && e.overlap)).toHaveLength(0);
  });

  it("a gate failure of p2 does not cancel the overlapping p3", async () => {
    const h = manual((p) => p === "p2");
    const run = runPlan(three(), { parallel: 1, forceLocal: true }, h.deps);
    await tick();
    h.workers.get("p1")!();
    await tick();
    h.merges.get("p1")!();
    await tick();
    h.workers.get("p2")!();
    await tick();
    expect(h.workers.has("p3")).toBe(true);
    h.workers.delete("p2");
    h.merges.get("p2")!(); // gate fails -> local retry of p2 queues behind p3's worker (provider cap 1)
    await tick();
    expect(h.maxLive()).toBe(1);
    expect(h.workers.has("p2")).toBe(false);
    h.workers.get("p3")!();
    await tick();
    h.workers.get("p2")!(); // the retry now runs
    await tick();
    expect(h.merges.has("p3")).toBe(false); // p3 waits for p2
    h.merges.get("p2")!();
    await tick();
    h.merges.get("p3")!();
    const s = await run;
    expect(s.needsDecision).toEqual(["p2"]);
    expect(s.merged).toEqual(["p1", "p3"]);
    expect(h.log.some((e) => e.event === "overlap-continue" && e.part === "p3")).toBe(true);
    expect(h.maxLive()).toBe(1);
  });

  it("never exceeds the provider cap", async () => {
    const p = parsePlan(yaml(`      - {id: p1, spec: A}\n      - {id: p2, spec: B, overlap: true}\n      - {id: p3, spec: C, overlap: true}\n      - {id: p4, spec: D, overlap: true}\n`), "/x");
    const h = manual();
    const run = runPlan(p, { parallel: 2 }, h.deps);
    await tick();
    expect([...h.workers.keys()].sort()).toEqual(["p1", "p2"]);
    for (const id of ["p1", "p2"]) h.workers.get(id)!();
    await tick();
    for (const id of ["p3", "p4"]) {
      for (let i = 0; i < 4 && !h.workers.has(id); i++) {
        for (const m of [...h.merges.values()]) m();
        h.merges.clear();
        await tick();
      }
    }
    for (let i = 0; i < 6; i++) {
      for (const w of [...h.workers.values()]) w();
      h.workers.clear();
      for (const m of [...h.merges.values()]) m();
      h.merges.clear();
      await tick();
    }
    await run;
    expect(h.maxLive()).toBeLessThanOrEqual(2);
  });
});

describe("report", () => {
  it("shows idle share, overlap count and splits tokens by provider kind", async () => {
    const sent: string[] = [];
    const msg: Messenger = { toSession: async (_o, t) => (sent.push(t), true), toPailot: async () => true };
    let now = 0;
    const r = new PlanReporter("j", 2, msg, {}, () => now);
    r.onLog({ event: "part-start", part: "a", overlap: true });
    r.onLog({ event: "model-idle", part: "a", tier: "local", ms: 30_000 });
    r.onLog({ event: "part-end", part: "a", tier: "local", tokens: 100 });
    r.onLog({ event: "part-end", part: "b", tier: "sonnet", tokens: 7 });
    r.onLog({ event: "merge", part: "a", ok: true });
    now = 120_000;
    r.onLog({ event: "run-end", ok: true });
    await r.flush();
    expect(sent[0]).toContain("local_tokens=100");
    expect(sent[0]).toContain("cloud_tokens=7");
    expect(sent[0]).toContain("local model idle 30s of 2m00s (25%), 1 overlapped start");
  });
  it("idleText", () => {
    expect(idleText(62_000, 444_000, 2)).toBe("local model idle 1m02s of 7m24s (14%), 2 overlapped starts");
  });
});
