import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitOn, type WaitOnDeps } from "./wait-on.js";

/** Fake clock: sleep advances time; the process is alive until `diesAt` ms. */
function fake(o: { diesAt?: number; initial?: "alive" | "gone" | "foreign"; start?: number }) {
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
  };
  return { deps, out };
}
const dir = mkdtempSync(join(tmpdir(), "waiton-"));

describe("waitOn", () => {
  it("returns 0 when the pid exits, with rc and log tail", async () => {
    const log = join(dir, "a.log");
    writeFileSync(log, "l1\nl2\nl3\n");
    writeFileSync(join(dir, "a.rc"), "7\n");
    const f = fake({ diesAt: 5000 });
    expect(await waitOn({ pid: 42, log, tail: 2 }, f.deps)).toBe(0);
    expect(f.out).toEqual(["pid 42 gone, exit code 7", "l2", "l3"]);
  });

  it("returns 3 at --max and caps at 115 s", async () => {
    const f = fake({});
    expect(await waitOn({ pid: 42, maxSecs: 1000 }, f.deps)).toBe(3);
    expect(f.out.at(-1)).toMatch(/still running after 11[45]s/);
  });

  it("prints a heartbeat about every 20 s", async () => {
    const log = join(dir, "h.log");
    writeFileSync(log, "x\n");
    const f = fake({ diesAt: 45_000 });
    await waitOn({ pid: 42, log, tail: 0 }, f.deps);
    expect(f.out.filter((l) => l.startsWith("running "))).toHaveLength(2);
    expect(f.out[0]).toBe("running 20s, log +0 lines");
  });

  it("returns 2 for a pid that never existed, a foreign pid and an invalid pid", async () => {
    expect(await waitOn({ pid: 42 }, fake({ initial: "gone" }).deps)).toBe(2);
    expect(await waitOn({ pid: 1 }, fake({ initial: "foreign" }).deps)).toBe(2);
    expect(await waitOn({ pid: -3 }, fake({}).deps)).toBe(2);
  });

  it("returns 0 for a pid already gone when its log exists", async () => {
    const log = join(dir, "done.log");
    writeFileSync(log, "ok\n");
    expect(await waitOn({ pid: 42, log }, fake({ initial: "gone" }).deps)).toBe(0);
  });

  it("treats a later process start time (pid reuse) as gone", async () => {
    const f = fake({ start: 1_000_000 + 10_000 });
    expect(await waitOn({ pid: 42, tail: 0 }, f.deps)).toBe(0);
    expect(f.out[0]).toBe("pid 42 gone");
  });
});
