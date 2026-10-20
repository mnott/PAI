/**
 * pool-reload.test.ts — the pool host reloads itself onto a newer bundle once idle,
 * and status shows a host that is behind. `pai reload` order lives in cli/commands/reload.test.ts.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPoolHost, type PoolHost } from "./pool-host.js";
import { bundleBuildStamp, poolHostStale, type PoolTaskRequest, type SlotProcess } from "./pool.js";
import { hostBuildText, reloadPoolHost } from "./pool-cli.js";
import { defaultWorkersConfig, type WorkersConfig } from "./config.js";
import { ledgerPath } from "./paths.js";
import { buildPoolPanel } from "../router/pool-panel.js";

const config = (): WorkersConfig => ({
  ...defaultWorkersConfig(),
  caveman: false,
  pool: { enabled: true, maxSlots: 1, idleSecs: 0, port: 0, native: true, spares: 0, idleKillSec: 0, continuation: true },
  providers: { fakeprov: { enabled: true, protocol: "anthropic", baseUrl: "https://example.invalid", keyFile: null, models: { default: "m1" }, env: {} } },
});

/** A slot that takes a task and never answers until finish(). */
class HungSlot implements SlotProcess {
  readonly pid = process.pid;
  private exitCb: ((code: number | null) => void) | null = null;
  write(): boolean {
    return true;
  }
  kill(): boolean {
    return true;
  }
  onLine(cb: (l: string) => void): void {
    queueMicrotask(() => cb(JSON.stringify({ type: "system", subtype: "init", session_id: "s-hung", model: "m1" })));
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }
  finish(): void {
    this.exitCb?.(0);
  }
}

const live: PoolHost[] = [];
afterEach(async () => {
  while (live.length) {
    const h = live.pop()!;
    h.server.closeAllConnections?.();
    await h.shutdown();
  }
});

const req: PoolTaskRequest = {
  id: "w1", label: "x", prompt: "SPEC", provider: "fakeprov", model: "m1", cwd: tmpdir(),
  reportFormat: "ag2", outputFormat: "text", maxMinutes: null, trailer: "",
};

function host(mtime: { v: number }, reexec: () => void) {
  const logDir = mkdtempSync(join(tmpdir(), "pai-pool-reload-"));
  const slot = new HungSlot();
  const h = createPoolHost({
    config: config(),
    logDir,
    usageLogFile: join(logDir, "none.jsonl"),
    spawner: () => slot,
    envFor: () => ({}),
    cmdHead: () => ["fake-claude"],
    bundlePath: "/bundle/worker-pool-host.mjs",
    fileMtime: () => mtime.v,
    reexec,
    noReaper: true,
  });
  live.push(h);
  return { h, slot, logDir };
}

describe("pool host self-update", () => {
  it("records its bundle mtime at start and stays put while the bundle is unchanged", async () => {
    const reexec = vi.fn();
    const { h } = host({ v: 1000 }, reexec);
    expect(h.state().bundleMtimeMs).toBe(1000);
    expect(await h.checkReload()).toBe(false);
    expect(reexec).not.toHaveBeenCalled();
  });

  it("re-execs when the bundle on disk is newer and no slot is busy, with a POOL-HOST-RELOAD ledger line", async () => {
    const mtime = { v: 1000 };
    const reexec = vi.fn();
    const { h, logDir } = host(mtime, reexec);
    mtime.v = 2000;
    expect(await h.checkReload()).toBe(true);
    expect(reexec).toHaveBeenCalledTimes(1);
    expect(readFileSync(ledgerPath(logDir), "utf8")).toContain("POOL-HOST-RELOAD");
    expect(await h.checkReload()).toBe(false); // once
    expect(reexec).toHaveBeenCalledTimes(1);
  });

  it("defers while a slot is busy and reloads once it is idle", async () => {
    const mtime = { v: 1000 };
    const reexec = vi.fn();
    const { h, slot } = host(mtime, reexec);
    const run = h.runTask(req);
    for (let i = 0; i < 50 && !h.state().slots.some((s) => s.busyWith); i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.state().slots.some((s) => s.busyWith)).toBe(true);
    mtime.v = 2000;
    expect(await h.checkReload()).toBe(false);
    expect(reexec).not.toHaveBeenCalled();
    slot.finish();
    await run;
    expect(await h.checkReload()).toBe(true);
    expect(reexec).toHaveBeenCalledTimes(1);
  });
});

describe("stale host in status and the cockpit panel", () => {
  it("poolHostStale compares the started bundle with the disk", () => {
    expect(poolHostStale(1000, 2000)).toBe(true);
    expect(poolHostStale(2000, 2000)).toBe(false);
    expect(poolHostStale(undefined, 2000)).toBe(false);
    expect(poolHostStale(1000, null)).toBe(false);
  });

  it("status text shows the build time and 'stale (newer build on disk)' when behind", () => {
    const state = { hostPid: 1, port: 1, startedAt: "", updatedAt: "", slots: [], tasksServed: 0, tokensCarried: 0, bundleMtimeMs: 1000 };
    expect(hostBuildText(state, 1000)).toBe(`built ${bundleBuildStamp(1000)}`);
    expect(hostBuildText(state, 2000)).toBe(`built ${bundleBuildStamp(1000)}, stale (newer build on disk)`);
  });

  it("the panel data carries hostBuiltAt and hostStale", () => {
    const state = { hostPid: 1, port: 1, startedAt: "s", updatedAt: "", slots: [], tasksServed: 0, tokensCarried: 0, bundleMtimeMs: 1000 };
    const mk = (disk: number) => buildPoolPanel({ enabled: true, hostUp: true, port: 1, maxSlots: 1, idleSecs: 0, state, metrics: [], ledger: [], nowMs: 5000, diskBundleMtimeMs: disk });
    expect(mk(2000)).toMatchObject({ hostStale: true, hostBuiltAt: bundleBuildStamp(1000) });
    expect(mk(1000).hostStale).toBe(false);
  });
});

describe("reloadPoolHost", () => {
  it("waits for busy slots, stops, waits for the port to free, then starts; null when no host runs", async () => {
    const calls: string[] = [];
    let busy = 2;
    let up = true;
    const sleep = async () => {};
    const r = await reloadPoolHost({
      alive: async () => up,
      busy: () => busy-- > 0,
      stop: () => {
        calls.push("stop");
        up = false;
      },
      start: async () => {
        calls.push("start");
        return 42;
      },
      sleep,
    });
    expect(calls).toEqual(["stop", "start"]);
    expect(r).toEqual({ waitedMs: 2000, newPid: 42 });
    expect(await reloadPoolHost({ alive: async () => false, busy: () => false, stop: () => calls.push("x"), start: async () => 1, sleep })).toBeNull();
    expect(calls).toEqual(["stop", "start"]);
  });
});
