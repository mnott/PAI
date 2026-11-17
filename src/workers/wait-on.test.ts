import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { waitOn, realDeps, statusQueue, WAIT_RECIPE, WAIT_VERBS, type WaitOnDeps } from "./wait-on.js";
import { saveStatus, type WorkerStatus } from "./status.js";

/** Fake clock: sleep advances time; the process is alive until `diesAt` ms; rc files served from a map. */
function fake(o: { diesAt?: number; initial?: "alive" | "gone" | "foreign"; start?: number; files?: Record<string, string>; t0?: number }) {
  let t = o.t0 ?? 1_000_000;
  const out: string[] = [];
  let first = true;
  const deps: WaitOnDeps = {
    probe: () => {
      if (first) {
        first = false;
        return o.initial ?? "alive";
      }
      return o.diesAt !== undefined && t >= (o.t0 ?? 1_000_000) + o.diesAt ? "gone" : "alive";
    },
    startTime: () => o.start ?? 1_000_000 - 5000,
    now: () => t,
    sleep: async (ms) => void (t += ms),
    out: (l) => out.push(l),
    // trim like the real reader does, so the served content behaves like a file's
    readFile: (f) => (f in (o.files ?? {}) ? o.files![f].trim() : null),
  };
  return { deps, out };
}

const dir = mkdtempSync(join(tmpdir(), "waiton-"));

describe("waitOn --rc and the unknown end", () => {
  it("--rc FILE: a gone pid exits with the file's code", async () => {
    const f = fake({ initial: "gone", files: { "/j.rc": "0\n" } });
    expect(await waitOn({ pid: 42, rcFile: "/j.rc", tail: 0 }, f.deps)).toBe(0);
    expect(f.out[0]).toBe("pid 42 ended, rc 0 (from /j.rc)");
  });

  it("--rc FILE with a nonzero code exits with that code", async () => {
    const g = fake({ initial: "gone", files: { "/j.rc": "7" } });
    expect(await waitOn({ pid: 42, rcFile: "/j.rc", tail: 0 }, g.deps)).toBe(7);
    expect(g.out[0]).toBe("pid 42 ended, rc 7 (from /j.rc)");
  });

  it("--rc FILE missing: exit 4, status unknown — never 1, never 2", async () => {
    const f = fake({ initial: "gone" });
    expect(await waitOn({ pid: 42, rcFile: "/j.rc", tail: 0 }, f.deps)).toBe(4);
    expect(f.out[0]).toBe("pid 42 gone, exit status unknown (no rc file: /j.rc)");
  });

  it("reads --rc when the job dies mid-wait", async () => {
    const f = fake({ diesAt: 5000, files: { "/j.rc": "3" } });
    expect(await waitOn({ pid: 42, rcFile: "/j.rc", tail: 0 }, f.deps)).toBe(3);
    // no proc dep: the run span is unknown, so the line has no "after …" part
    expect(f.out[0]).toBe("pid 42 ended, rc 3 (from /j.rc)");
  });

  it("without --rc: a gone pid with only a log is an unknown end, exit 4", async () => {
    const log = join(dir, "b.log");
    writeFileSync(log, "done\n");
    const f = fake({ initial: "gone" });
    expect(await waitOn({ pid: 42, log, tail: 0 }, f.deps)).toBe(4);
    expect(f.out[0]).toBe("pid 42 gone, exit status unknown (no rc file)");
  });

  it("without --rc: an auto-discovered <log>.rc still carries the code", async () => {
    const log = join(dir, "c.log");
    writeFileSync(log, "x\n");
    writeFileSync(join(dir, "c.rc"), "5\n");
    // readFile is not faked here: the real reader sees the file written above
    const f = fake({ initial: "gone" });
    delete (f.deps as { readFile?: unknown }).readFile;
    expect(await waitOn({ pid: 42, log, tail: 0 }, f.deps)).toBe(5);
    expect(f.out[0]).toBe("pid 42 ended, rc 5");
  });

  it("a pid that never existed (no rc, no log) is still exit 2", async () => {
    expect(await waitOn({ pid: 42 }, fake({ initial: "gone" }).deps)).toBe(2);
  });

  it("pid reuse with no rc anywhere ends unknown (exit 4), never 0", async () => {
    expect(await waitOn({ pid: 42, tail: 0 }, fake({ start: 1_000_000 + 10_000 }).deps)).toBe(4);
  });

  it("a stall kill still exits 4 with its own line, whatever the rc file says", async () => {
    const f = fake({});
    f.deps.logMtime = () => 1_000_000;
    f.deps.killTree = async () => {};
    f.deps.busy = async () => ({ busy: false, why: "no cpu, no i/o" });
    const rc = await waitOn({ pid: 42, log: join(dir, "s.log"), rcFile: "/j.rc", maxSecs: 590, stallMinutes: 0.2, maxMinutes: 100, tail: 0 }, { ...f.deps, readFile: () => "0" });
    expect(rc).toBe(4);
    expect(f.out[0]).toContain("killed process tree");
  });

  it("the contract text names --rc and says exit 4 = ended, status unknown", () => {
    expect(WAIT_RECIPE).toContain("--log $TMPDIR/job.log --rc $TMPDIR/job.rc");
    expect(/exit 4 = ended, status unknown/.test(WAIT_RECIPE)).toBe(true);
    expect(WAIT_VERBS).toContain("wait-on $(cat $TMPDIR/job.pid) --log $TMPDIR/job.log --rc $TMPDIR/job.rc");
    expect(WAIT_VERBS).toContain("exit 4 = ended, status unknown");
  });

  it("a shifted now (activeNow minus past freezes) never ends or kills a live job mid-wait", async () => {
    // the 2026-11-17 misfire: realDeps.now was activeNow — wall minus every freeze ever accounted on the
    // machine. Against wall `ps lstart` times a 2 s old job read 62 min old: the stall rule fired at the
    // first poll and killed it ("pid … gone after 0m00s"). Same shape, fake clock shifted 62 min back.
    const t0 = 4_000_000; // wall: the machine has frozen for 62 min in its past (activeNow's accounts)
    const f = fake({ t0 });
    let t = t0;
    // activeNow's shape: wall minus everything frozen so far. The shift stays under this call's own --max
    // span: a jump past the pid's death is an honest "gone" on any clock; what the old code did was read a
    // YOUNG job as ancient and kill it at the first poll ("pid … gone after 0m00s").
    // a real --max: the loop must run its full budget on wall time, never cut short by the shifted clock.
    const maxSecs = 35;
    let slept = 0;
    f.deps.sleep = async (ms) => {
      slept += ms;
      t += ms;
    };
    f.deps.startTime = () => t0 - 2000; // wall: the job started 2 s before wait-on began
    const log = join(dir, "shifted.log");
    writeFileSync(log, "building\n");
    let killed = 0;
    f.deps.logMtime = () => t - 2000; // written at job start: silent for a whole wait under the shifted clock, current under wall
    f.deps.busy = async () => ({ busy: false, why: "no cpu, no i/o" });
    f.deps.killTree = async () => void killed++;
    const rc = await waitOn({ pid: 42, log, maxSecs, stallMinutes: 5, maxMinutes: 30, tail: 0 }, f.deps);
    expect(rc).toBe(3); // still running, call again — never a kill, never an "end"
    expect(killed).toBe(0);
    expect(slept).toBe(maxSecs * 1000); // the full budget ran: no shifted clock ended the wait early
    expect(f.out.join("\n")).not.toMatch(/gone|ended|killed/);
  });

  it("realDeps.now is the wall clock: liveness rules compare against wall ps start times", () => {
    // activeNow() subtracts frozenTotalMs(); with the live machine's accounts (62 min by 2026-11-17) any
    // gap proves a shift. A test dir isolates the accounts: zero here means realDeps.now == Date.now().
    const saved = process.env.PAI_FREEZE_FILE;
    process.env.PAI_FREEZE_FILE = join(mkdtempSync(join(dir, "wall-")), "freeze.json");
    try {
      expect(Math.abs(realDeps.now() - Date.now())).toBeLessThan(1000);
    } finally {
      if (saved === undefined) delete process.env.PAI_FREEZE_FILE;
      else process.env.PAI_FREEZE_FILE = saved;
    }
  });

  it("statusQueue: a recycled pid matching an old worker status is not a worker", () => {
    const qdir = mkdtempSync(join(dir, "q-"));
    // a live pid (this test process) with a running status whose recorded start is hours off and names no
    // worker in its command line: the OS recycled the pid — ownsPid says the status is stale.
    saveStatus(qdir, {
      id: "20260101-000000-99999",
      pid: process.pid,
      label: "old job",
      cwd: dir,
      term: "",
      provider: "p",
      model: "m",
      state: "running",
      started: "2026-01-01 00:00:00",
      updated: "2026-01-01 00:00:00",
      turns: 0,
      tools: 0,
      last: "",
      rc: null,
      secs: null,
    });
    expect(statusQueue(qdir)(process.pid)).toBeNull();
  });

  it("a worker exemption needs a status that owns its pid; a recycled pid keeps the ceiling", async () => {
    const qdir = mkdtempSync(join(dir, "q2-"));
    saveStatus(qdir, {
      id: "20260101-000000-99998",
      pid: 42,
      label: "stale worker",
      cwd: dir,
      term: "",
      provider: "p",
      model: "m",
      state: "running",
      started: "2026-01-01 00:00:00",
      updated: "2026-01-01 00:00:00",
      turns: 0,
      tools: 0,
      last: "",
      rc: null,
      secs: null,
    });
    const f = fake({});
    let killed = 0;
    f.deps.killTree = async () => void killed++;
    // pid 42 is alive (fake probe), its status file says "worker running" — but the recorded start cannot
    // be this process's: without the ownsPid check it read as a worker, was exempted from the ceiling and
    // wait-on only ever returned 3. With it, the 1-minute ceiling kills at 60 s of the fake clock.
    const rc = await waitOn({ pid: 42, maxSecs: 590, maxMinutes: 1, tail: 0 }, { ...f.deps, queue: statusQueue(qdir) });
    expect(rc).toBe(4);
    expect(killed).toBe(1);
    expect(f.out.join("\n")).toContain("killed process tree");
  });
});

describe("waitOn against real processes (the recipe's shape)", () => {
  const src = joinPath(dirname(fileURLToPath(import.meta.url)), "wait-on.ts");

  it("a detached job started before the wait is alive: exit 3, never gone", async () => {
    // nohup-style: detached from this process group, its own session (setsid). The misfire reported a live
    // build like this as "gone after 0m00s" — via the shifted clock's stall kill; the real probe and the
    // loop must both say alive for a job older than the wait.
    const child = spawn("sh", ["-c", "exec sleep 60"], { detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid!;
    try {
      expect(realDeps.probe(pid)).toBe("alive");
      const st = realDeps.startTime(pid);
      expect(st).not.toBeNull();
      expect(st!).toBeLessThanOrEqual(Date.now()); // the job predates this call: an old start is normal, not reuse
      const out: string[] = [];
      const rc = await waitOn({ pid, maxSecs: 3, tail: 0 }, { ...realDeps, out: (l) => out.push(l) });
      expect(rc).toBe(3); // still running after 3 s — the job was never gone
      expect(out.join("\n")).toMatch(/still running/);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("a genuinely ended job without an rc file still gives exit 4", async () => {
    // the recipe's shape: a detached job writes its log and exits without an rc. The end is known (the log
    // exists), the status is not — exit 4, never 0 or 1. A pid gone with NO trace at all is "never existed"
    // (exit 2): detached children get reaped before wait-on can observe them, so that path needs no process.
    const log = join(dir, `ended-${process.pid}.log`);
    writeFileSync(log, "build done\n");
    expect(await waitOn({ pid: 999_999, log, tail: 0 }, { ...realDeps, out: () => {} })).toBe(4);
  });
});
