import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan } from "./plan.js";
import { runPlan, readRunLog, appendRunLog, type GateEvent, type RunnerDeps, type RunLogEntry } from "./plan-runner.js";
import { GateParser } from "./plan-deps.js";
import { GATE_MARK, splitGate } from "./worktree.js";
import { PlanTracker, followPlanLog, gatePhaseName, loadPlanStatus, loadPlanStatuses, planRows, planRunId, planLogTail, renderPlanLines } from "./plan-status.js";
import { cockpitQueue } from "../router/cockpit.js";
import { psOutput } from "./viewer.js";
import type { WorkersConfig } from "./config.js";

const twoParts = () =>
  parsePlan(`job: tiny\nrepo: /r\ngate: npx tsc --noEmit && npx tsdown && npx vitest run\nprovider: local\nunits:\n  - id: u1\n    unit_check: chk\n    parts:\n      - {id: a, spec: A, files: [f1]}\n      - {id: b, spec: B, files: [f2], depends_on: [a]}\n`, "/x");

/** Fake spawner: the gate reports three timed commands through the observer. */
function fakeDeps(tracker: PlanTracker, jsonl: string, phases: string[]): RunnerDeps {
  let n = 0;
  let clock = 1000;
  return {
    now: () => clock,
    resolveLocal: async (p) => p,
    log: (e) => appendRunLog(jsonl, e, () => clock),
    phase: (t, refine) => {
      if (!refine) phases.push(t);
      if (refine) tracker.progress(t);
      else tracker.phase(t);
    },
    progress: (m, r) => {
      tracker.merged(m);
      tracker.setRunning(r);
    },
    note: (l) => tracker.log(l),
    async startWorker() {
      return { id: `w${++n}`, ok: true };
    },
    async merge(_id, _gate, on) {
      const cmds = ["npx tsc --noEmit", "npx tsdown", "npx vitest run"];
      on?.({ ev: "gate-start", commands: cmds });
      const ms = [4000, 9000, 41000];
      cmds.forEach((cmd, i) => {
        on?.({ ev: "cmd-start", i, cmd });
        clock += ms[i];
        on?.({ ev: "cmd-end", i, cmd, ms: ms[i], ok: true });
      });
      on?.({ ev: "gate-end", ok: true, ms: 54000 });
      return { ok: true, commit: `c${n}`, before: `b${n}`, output: "" };
    },
    async unitCheck() {
      return { ok: true, output: "" };
    },
  };
}

describe("plan runner phases", () => {
  it("moves the status entry through merging, gate commands, unit check and starting; the jsonl records gate timings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-planph-"));
    const jsonl = join(dir, "tiny.run.jsonl");
    const phases: string[] = [];
    const tracker = new PlanTracker(dir, "tiny", 2, 0, () => 5000);
    await runPlan(twoParts(), { parallel: 1 }, fakeDeps(tracker, jsonl, phases));
    expect(phases).toEqual(["starting a", "merging a", "gate: tsc", "gate: build", "gate: tests", "starting b", "merging b", "gate: tsc", "gate: build", "gate: tests", "unit check u1"]);
    const st = loadPlanStatus(dir, planRunId("tiny"))!;
    expect(st.kind).toBe("plan");
    expect(st.phase).toBe("unit check u1");
    expect(st.parts).toEqual({ merged: 2, total: 2 });
    tracker.end("done");
    expect(loadPlanStatus(dir, st.id)!.state).toBe("done");
    expect(readFileSync(join(dir, `${st.id}.planlog`), "utf8")).toMatch(/\d\d:\d\d:\d\d phase: gate: tsc/);

    const log = readRunLog(jsonl);
    const ends = log.filter((e) => e.event === "gate-end");
    expect(ends).toHaveLength(2);
    expect(ends[0].commands!.map((c) => [c.cmd, c.ms])).toEqual([["npx tsc --noEmit", 4000], ["npx tsdown", 9000], ["npx vitest run", 41000]]);
    expect(ends[0].ms).toBe(54000);
    const starts = log.filter((e) => e.event === "gate-start");
    expect(starts[0].commands!.map((c) => c.cmd)).toEqual(["npx tsc --noEmit", "npx tsdown", "npx vitest run"]);
  });

  it("a gate-less log still resumes: new events are ignored by resume and status", () => {
    const e: RunLogEntry = { event: "gate-end", part: "a", ok: true, ms: 1 };
    expect(e.event).toBe("gate-end");
  });
});

describe("gate markers", () => {
  const mark = (o: object) => `${GATE_MARK}${JSON.stringify(o)}\n`;
  it("GateParser turns markers into events, strips them and counts tests against the known total", () => {
    const ev: GateEvent[] = [];
    const p = new GateParser((e) => ev.push(e), 2600);
    p.feed(mark({ ev: "gate-start", commands: ["npx vitest run"] }) + mark({ ev: "cmd-start", i: 0, cmd: "npx vitest run" }));
    p.feed(" ✓ a.test.ts (200 tests) 5ms\n ✓ b.test.ts (14 te");
    p.feed("sts) 5ms\nplain\n" + mark({ ev: "cmd-end", i: 0, cmd: "npx vitest run", ms: 1200, ok: true }));
    p.end();
    expect(ev.filter((e) => e.ev === "progress").map((e) => (e as { text: string }).text)).toEqual(["gate: tests 200/2600", "gate: tests 214/2600"]);
    const end = ev.find((e) => e.ev === "cmd-end") as { tail: string; ms: number };
    expect(end.ms).toBe(1200);
    expect(end.tail).toContain("plain");
    expect(p.total).toBe(214);
    expect(p.clean).not.toContain("pai-gate");
  });
  it("splitGate splits plain && chains and leaves quoted gates whole", () => {
    expect(splitGate("npx tsc --noEmit && npx tsdown && npx vitest run a b")).toHaveLength(3);
    expect(splitGate("sh -c 'a && b'")).toEqual(["sh -c 'a && b'"]);
  });
  it("names gate phases", () => {
    expect([gatePhaseName("npx tsc --noEmit"), gatePhaseName("npx tsdown"), gatePhaseName("npx vitest run x"), gatePhaseName("make lint all now")]).toEqual(["tsc", "build", "tests", "make lint all"]);
  });
});

describe("plan rows in ps, cockpit and the live log", () => {
  it("renders a running plan as a ps line and a cockpit row; an ended plan has none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-planrow-"));
    let t = 100_000;
    const tr = new PlanTracker(dir, "my job", 4, 1, () => t);
    tr.phase("gate: tests 214/2600");
    tr.setRunning(["b"]);
    t += 75_000;
    const sts = loadPlanStatuses(dir);
    const line = renderPlanLines(sts, t)[0];
    expect(line).toBe("plan my job  1/4 merged  gate: tests 214/2600 (1m15s)  workers: b  local model idle 0s of 1m15s (0%), 0 overlapped starts");
    const row = planRows(sts, t)[0];
    expect(row).toMatchObject({ job: "my job", phase: "gate: tests 214/2600", phaseSec: 75, merged: 1, total: 4, running: ["b"] });
    const ps = psOutput(dir, true, {}, false);
    expect(ps).toContain("plan my job  1/4 merged");
    const q = cockpitQueue(dir, { providers: {}, nativeModels: {} } as unknown as WorkersConfig, Date.now(), () => true);
    expect(q.plans.map((p) => p.job)).toEqual(["my job"]);
    tr.end("done");
    expect(renderPlanLines(loadPlanStatuses(dir), t)).toEqual([]);
    expect(cockpitQueue(dir, { providers: {}, nativeModels: {} } as unknown as WorkersConfig, Date.now(), () => true).plans).toEqual([]);
  });

  it("the pane follow prints the log and what is appended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-planlog-"));
    const tr = new PlanTracker(dir, "j", 1, 0);
    tr.phase("merging a");
    const got: string[] = [];
    let polls = 0;
    await followPlanLog(dir, tr.id, (s) => got.push(s), () => {
      if (polls++ === 0) tr.log("later line");
      return polls > 2;
    }, 1);
    expect(got.join("")).toMatch(/phase: merging a[\s\S]*later line/);
    expect(planLogTail(dir, tr.id, 1)).toMatch(/later line$/);
  });
});

describe("the real gate", () => {
  it("runVerify under PAI_GATE_EVENTS runs the commands one by one and a failure stops the chain", async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const script = join(mkdtempSync(join(tmpdir(), "pai-gate-")), "run.mjs");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(script, `import { runVerify } from ${JSON.stringify(fileURLToPath(new URL("./worktree.ts", import.meta.url)))};\ntry { runVerify(process.cwd(), process.argv[2], "HEAD"); } catch (e) { console.log("threw", String(e.message).slice(0, 40)); }\n`);
    const run = (gate: string) => spawnSync("npx", ["tsx", script, gate], { cwd: tmpdir(), env: { ...process.env, PAI_GATE_EVENTS: "1" }, encoding: "utf8" });
    const ev: GateEvent[] = [];
    const p = new GateParser((e) => ev.push(e));
    const r = run("echo one && false && echo three");
    p.feed(r.stdout + r.stderr);
    p.end();
    expect(ev.map((e) => e.ev)).toEqual(["gate-start", "cmd-start", "cmd-end", "cmd-start", "cmd-end", "gate-end"]);
    expect(ev.filter((e) => e.ev === "cmd-end").map((e) => (e as { ok: boolean }).ok)).toEqual([true, false]);
    expect(p.clean).toContain("one");
    expect(p.clean).not.toContain("three");
  }, 60000);
});
