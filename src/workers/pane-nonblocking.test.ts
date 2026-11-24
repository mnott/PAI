/**
 * pane-nonblocking.test.ts — the daemon's pane tasks never hold the event loop on an external call:
 * a fake `ps` / `osascript` that sleeps 10 s is killed at its limit while a loop timer keeps firing.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { psTableAsync } from "./ps-table.js";
import { osascriptJxa } from "./pane.js";

let bin: string;
let oldPath: string | undefined;
beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "slow-bin-"));
  for (const n of ["ps", "osascript"]) {
    writeFileSync(join(bin, n), "#!/bin/sh\nexec sleep 10\n");
    chmodSync(join(bin, n), 0o755);
  }
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
});
afterEach(() => {
  process.env.PATH = oldPath;
  rmSync(bin, { recursive: true, force: true });
});

/** Longest gap between 10 ms timer ticks while `work` runs: the loop's responsiveness (an IPC read waits at most this long). */
async function maxLoopGap(work: Promise<unknown>): Promise<number> {
  let last = performance.now();
  let max = 0;
  const t = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 10);
  await work.catch(() => undefined);
  clearInterval(t);
  return max;
}

describe("daemon pane tasks never block the loop", () => {
  it("a 10 s ps is killed at its limit and the loop stays responsive", async () => {
    const t0 = performance.now();
    const gap = await maxLoopGap(psTableAsync("command=", 400));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(gap).toBeLessThan(100);
    await expect(psTableAsync("command=", 200)).rejects.toThrow();
  });

  it("a 10 s osascript is killed at its limit and the loop stays responsive", async () => {
    const t0 = performance.now();
    let err: unknown;
    const gap = await maxLoopGap(osascriptJxa("1", [], 400).catch((e) => { err = e; }));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(String(err)).toMatch(/timed out/);
    expect(gap).toBeLessThan(100);
  });
});
