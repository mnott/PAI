import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { again, canMove, classifySize, composeQueueSpec, move, parseNumstat, parseSettings, QueueStore, renderList, renderReview } from "./queue.js";
import { acceptItems, runQueue, type QueueDeps } from "./queue-runner.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "pai-queue-test-")), "state", "q.json");
const settings = (y = "") => parseSettings(y);

describe("store and transitions", () => {
  it("runQueue hands model and priority to every local worker", async () => {
    const s = new QueueStore(join(mkdtempSync(join(tmpdir(), "q-")), "queue.jsonl"));
    s.add("one", "/r");
    const seen: Array<{ model?: string; priority?: string }> = [];
    const f = fakeDeps({ async startWorker(req) { seen.push({ model: req.model, priority: req.priority }); return { id: "w", ok: true, worktreeDir: "/wt", report: "R ok" }; } });
    await runQueue(s, settings(), { provider: "local", parallel: 1, model: "fast", priority: "front" }, f.deps);
    expect(seen).toEqual([{ model: "fast", priority: "front" }]);
  });
  it("adds items with ids, persists, and enforces transitions", () => {
    const path = tmp();
    const s = new QueueStore(path, () => 0);
    const a = s.add("move the button", "/r", { files: ["a.ts"], image: "/i.png" });
    const b = s.add("fix tooltip", "/r");
    expect([a.id, b.id]).toEqual(["q1", "q2"]);
    expect(existsSync(path)).toBe(true);
    expect(new QueueStore(path).get("q1")).toMatchObject({ state: "pending", files: ["a.ts"], image: "/i.png", created: "1970-01-01T00:00:00.000Z" });
    expect(() => move(s, "q1", "accepted")).toThrow(/cannot become/);
    move(s, "q1", "running");
    move(s, "q1", "ready");
    expect(canMove("accepted", "pending")).toBe(false);
    expect(s.add("c", "/r").id).toBe("q3");
  });

  it("again re-queues with the note, then marks the cloud after two rounds", () => {
    const s = new QueueStore(tmp());
    s.add("x", "/r");
    move(s, "q1", "running");
    move(s, "q1", "ready");
    expect(again(s, "q1", "still not", "diff1")).toMatchObject({ state: "pending", rounds: 1, notes: ["still not"], prevDiff: "diff1" });
    move(s, "q1", "running");
    move(s, "q1", "ready");
    expect(again(s, "q1", "no again", "diff2")).toMatchObject({ state: "cloud", rounds: 2, notes: ["still not", "no again"] });
  });
});

describe("settings, size, spec", () => {
  it("defaults and parses queue.yaml", () => {
    expect(settings()).toMatchObject({ maxFiles: 6, maxLines: 200, gate: undefined });
    expect(settings("gate: make\nmax_files: 3\nmax_lines: 50\nrules: Use tabs.\nmax_parallel: 2")).toMatchObject({ gate: "make", maxFiles: 3, maxLines: 50, rules: "Use tabs.", maxParallel: 2 });
  });

  it("classifies size", () => {
    const s = settings();
    expect(classifySize({ files: 6, lines: 200 }, s)).toBeNull();
    expect(classifySize({ files: 7, lines: 10 }, s)).toMatch(/7 files/);
    expect(classifySize({ files: 1, lines: 201 }, s)).toMatch(/201 lines/);
    expect(parseNumstat("3\t1\ta.ts\n-\t-\timg.png\n\n")).toEqual({ files: 2, lines: 4 });
  });

  it("composes sentence, footer, rules and operator note", () => {
    const s = new QueueStore(tmp());
    const it = s.add("tooltip says Sav", "/r", { files: ["a.ts"] });
    const plain = composeQueueSpec(it, settings("rules: Use tabs."));
    expect(plain).toContain("tooltip says Sav");
    expect(plain).toMatch(/RELATIVE paths/);
    expect(plain).toMatch(/Git add the files.*commit/);
    expect(plain).toMatch(/at most 6 files and 200 changed lines/);
    expect(plain).toMatch(/Do not run a full test suite/);
    expect(plain).toContain("Use tabs.");
    expect(plain).toMatch(/Report with an R message/);
    expect(plain).not.toMatch(/Operator notes/);
    move(s, "q1", "running");
    move(s, "q1", "ready");
    const redo = composeQueueSpec(again(s, "q1", "still clipped", "+new line"), settings("gate: make"));
    expect(redo).toContain("+new line");
    expect(redo).toContain("1. still clipped");
    expect(redo).toMatch(/gate \(make\) is run for you/);
  });
});

describe("review output", () => {
  it("lists only ready items compactly", () => {
    const s = new QueueStore(tmp());
    s.add("one", "/r");
    s.add("two", "/r");
    move(s, "q1", "running");
    move(s, "q1", "ready", { diff: { files: 2, lines: 9, stat: "" }, gate: { ok: true, output: "" }, proof: "/tmp/a.png" });
    expect(renderReview(s.list())).toBe("q1  one  2f/9l  gate ok  proof /tmp/a.png");
    expect(renderList(s.list())).toMatch(/q2  pending/);
    expect(renderReview([])).toBe("nothing ready");
  });
});

function fakeDeps(over: Partial<QueueDeps> = {}, outcomes: Record<string, Array<{ ok: boolean; failure?: string }>> = {}) {
  const started: Array<{ id: string; spec: string; provider: string; tier: string }> = [];
  const calls: string[] = [];
  const deps: QueueDeps = {
    resolveLocal: async (p) => p,
    async startWorker(req) {
      started.push({ id: req.itemId, spec: req.spec, provider: req.provider, tier: req.tier });
      const o = (outcomes[req.itemId] ?? [{ ok: true }]).shift() ?? { ok: true };
      return { id: `w-${req.itemId}-${req.attempt}`, ok: o.ok, failure: o.failure, worktreeDir: "/wt", report: "R ok" };
    },
    async inspect() {
      return { files: 1, lines: 5, stat: "a.ts | 5", commits: 1 };
    },
    async sh(cmd) {
      calls.push(cmd);
      return { ok: true, output: cmd.includes("shot") ? "building\n/tmp/shot.png\n" : "" };
    },
    async merge(_r, id, gate) {
      calls.push(`merge ${id} ${gate}`);
      return { ok: true, commit: "c2", before: "c1", output: "" };
    },
    ...over,
  };
  return { deps, started, calls };
}

describe("runQueue with fake deps", () => {
  it("ready item carries diff, gate, proof, report; nothing is merged", async () => {
    const s = new QueueStore(tmp());
    s.add("a", "/r");
    const f = fakeDeps();
    const r = await runQueue(s, settings("gate: build\nproof: ./shot.sh"), { provider: "local", parallel: 2 }, f.deps);
    expect(r.ready).toEqual(["q1"]);
    expect(s.get("q1")).toMatchObject({ state: "ready", worker: "w-q1-1", proof: "/tmp/shot.png", report: "R ok", gate: { ok: true }, diff: { files: 1, lines: 5 } });
    expect(f.calls).toEqual(["build", "./shot.sh"]);
    expect(f.started[0].provider).toBe("local");
  });

  it("no gate configured: none run", async () => {
    const s = new QueueStore(tmp());
    s.add("a", "/r");
    const f = fakeDeps();
    await runQueue(s, settings(), { provider: "local", parallel: 1 }, f.deps);
    expect(f.calls).toEqual([]);
    expect(s.get("q1")?.gate).toBeUndefined();
  });

  it("too-big is not retried", async () => {
    const s = new QueueStore(tmp());
    s.add("a", "/r");
    const f = fakeDeps({ inspect: async () => ({ files: 9, lines: 5, stat: "", commits: 1 }) });
    const r = await runQueue(s, settings(), { provider: "local", parallel: 1 }, f.deps);
    expect(r.tooBig).toEqual(["q1"]);
    expect(f.started).toHaveLength(1);
    expect(s.get("q1")).toMatchObject({ state: "too-big" });
    expect(s.get("q1")?.why).toMatch(/9 files/);
  });

  it("failure gets one retry with the failure tail, then needs-decision", async () => {
    const s = new QueueStore(tmp());
    s.add("a", "/r");
    const f = fakeDeps({}, { q1: [{ ok: false, failure: "boom at line 3" }, { ok: false, failure: "boom again" }] });
    const r = await runQueue(s, settings(), { provider: "local", parallel: 1 }, f.deps);
    expect(r.needsDecision).toEqual(["q1"]);
    expect(f.started).toHaveLength(2);
    expect(f.started[1].spec).toContain("boom at line 3");
    expect(s.get("q1")).toMatchObject({ state: "needs-decision", why: "boom again" });
  });

  it("failed gate retries once; retry can succeed", async () => {
    const s = new QueueStore(tmp());
    s.add("a", "/r");
    let n = 0;
    const f = fakeDeps({ sh: async () => ({ ok: ++n > 1, output: "type error" }) });
    const r = await runQueue(s, settings("gate: build"), { provider: "local", parallel: 1 }, f.deps);
    expect(r.ready).toEqual(["q1"]);
    expect(f.started[1].spec).toContain("type error");
  });

  it("a spawn refusal twice halts the queue without retrying", async () => {
    const s = new QueueStore(tmp());
    s.add("a", "/r");
    s.add("b", "/r");
    s.add("c", "/r");
    const f = fakeDeps({ async startWorker() { return { id: "", ok: false, spawnRefused: true, failure: "no pane" }; } });
    const r = await runQueue(s, settings(), { provider: "local", parallel: 1 }, f.deps);
    expect(r.spawnRefusal).toBe("no pane");
    expect(s.get("q3")?.state).toBe("pending");
  });

  it("--escalate takes only cloud items, on sonnet", async () => {
    const s = new QueueStore(tmp());
    s.add("a", "/r");
    s.add("b", "/r");
    move(s, "q1", "running");
    move(s, "q1", "ready");
    again(s, "q1", "n1");
    move(s, "q1", "running");
    move(s, "q1", "ready");
    again(s, "q1", "n2");
    const f = fakeDeps();
    const r = await runQueue(s, settings(), { provider: "local", parallel: 2, escalate: true }, f.deps);
    expect(r.ready).toEqual(["q1"]);
    expect(f.started).toMatchObject([{ id: "q1", tier: "sonnet", provider: "anthropic" }]);
    expect(s.get("q2")?.state).toBe("pending");
  });
});

describe("accept", () => {
  it("merges with the gate, then installs", async () => {
    const s = new QueueStore(tmp());
    s.add("a", "/r");
    move(s, "q1", "running");
    move(s, "q1", "ready", { worker: "w1" });
    const f = fakeDeps();
    const r = await acceptItems(s, settings("gate: build\ninstall: ./inst.sh"), ["q1", "q9"], f.deps);
    expect(f.calls).toEqual(["merge w1 build", "./inst.sh"]);
    expect(r.map((x) => x.ok)).toEqual([true, false]);
    expect(s.get("q1")?.state).toBe("accepted");
  });

  it("a failed merge keeps the item ready and skips install", async () => {
    const s = new QueueStore(tmp());
    s.add("a", "/r");
    move(s, "q1", "running");
    move(s, "q1", "ready", { worker: "w1" });
    const f = fakeDeps({ merge: async () => ({ ok: false, output: "gate failed" }) });
    const r = await acceptItems(s, settings("install: ./inst.sh"), ["q1"], f.deps);
    expect(r[0].ok).toBe(false);
    expect(f.calls).toEqual([]);
    expect(s.get("q1")?.state).toBe("ready");
  });
});
