import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitOn, WAIT_RECIPE, WAIT_VERBS, type WaitOnDeps } from "./wait-on.js";

/** Fake clock: sleep advances time; the process is alive until `diesAt` ms; rc files served from a map. */
function fake(o: { diesAt?: number; initial?: "alive" | "gone" | "foreign"; start?: number; files?: Record<string, string> }) {
  let t = 1_000_000;
  const out: string[] = [];
  let first = true;
  const deps: WaitOnDeps = {
    probe: () => {
      if (first) {
        first = false;
        return o.initial ?? "alive";
      }
      return o.diesAt !== undefined && t >= 1_000_000 + o.diesAt ? "gone" : "alive";
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
});
