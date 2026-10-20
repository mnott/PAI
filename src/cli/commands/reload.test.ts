import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import { lastErrorLines, reloadAll, startStoppedDaemon, type ReloadDeps } from "./reload.js";
import { GROUPS } from "../registry.js";

function daemon(over: Partial<ReloadDeps["daemon"]> = {}): ReloadDeps["daemon"] {
  return {
    pid: () => undefined,
    restart: () => 11,
    serviceInstalled: () => true,
    kickstart: () => true,
    socketUp: async () => true,
    logPath: () => "/tmp/pai-daemon.log",
    ...over,
  };
}

function deps(
  running: { daemon?: boolean; router?: boolean; pool?: boolean },
  calls: string[],
  daemonOver: Partial<ReloadDeps["daemon"]> = {}
): ReloadDeps {
  return {
    codeInfo: () => "v1.2.3 built 2026-10-20 14:00:00",
    daemon: daemon({
      pid: () => (running.daemon ? 10 : undefined),
      kickstart: () => (calls.push("kickstart"), true),
      ...daemonOver,
    }),
    router: { pid: () => (running.router ? 20 : undefined), restart: async () => (calls.push("router"), 21) },
    pool: { reload: async () => (running.pool ? (calls.push("pool"), { oldPid: 30, newPid: 31, builtAt: "2026-10-20 14:00:00" }) : null) },
  };
}

const noSleep = async () => undefined;

describe("pai reload", () => {
  it("restarts daemon, router, pool host in that order, one line each with old/new pid and code version", async () => {
    const calls: string[] = [];
    const { lines } = await reloadAll(deps({ daemon: true, router: true, pool: true }, calls));
    expect(calls).toEqual(["router", "pool"]);
    expect(lines).toEqual([
      "daemon: pid 10 -> 11, v1.2.3 built 2026-10-20 14:00:00",
      "router: pid 20 -> 21, v1.2.3 built 2026-10-20 14:00:00",
      "pool host: pid 30 -> 31, v1.2.3 built 2026-10-20 14:00:00 (bundle built 2026-10-20 14:00:00)",
    ]);
  });

  it("starts a stopped daemon through its installed service and reports started, not skipped", async () => {
    const calls: string[] = [];
    // pid() answers only once the daemon is up: a running daemon would be restarted, not kickstarted
    const { lines, daemonFailed } = await reloadAll(
      deps({ router: true }, calls, { pid: () => (calls.includes("kickstart") ? 42 : undefined) }),
      {
      timeoutMs: 200,
      pollMs: 100,
        sleep: noSleep,
      }
    );
    expect(daemonFailed).toBe(false);
    expect(calls).toEqual(["kickstart", "router"]);
    expect(lines[0]).toBe("daemon: started pid 42, v1.2.3 built 2026-10-20 14:00:00");
    expect(lines[1]).toBe("router: pid 20 -> 21, v1.2.3 built 2026-10-20 14:00:00");
    expect(lines[2]).toBe("pool host: not running, skipped");
  });

  it("reports FAILED with the log tail when the daemon does not come up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-reload-test-"));
    const log = join(dir, "daemon.log");
    writeFileSync(log, "Error: crash loop\nError: crash loop\n", "utf8");
    const calls: string[] = [];
    const { lines, daemonFailed } = await reloadAll(
      deps({ router: true }, calls, { socketUp: async () => false, logPath: () => log }),
      { timeoutMs: 200, pollMs: 100, sleep: noSleep },
    );
    expect(daemonFailed).toBe(true);
    expect(lines[0]).toBe("daemon: FAILED to start — Error: crash loop");
    expect(lines[1]).toBe("  Error: crash loop");
    expect(lines[2]).toBe("router: pid 20 -> 21, v1.2.3 built 2026-10-20 14:00:00");
  });

  it("reports no service installed when there is none", async () => {
    const calls: string[] = [];
    const { lines, daemonFailed } = await reloadAll(deps({ router: true }, calls, { serviceInstalled: () => false }), {
      timeoutMs: 200,
      pollMs: 100,
      sleep: noSleep,
    });
    expect(daemonFailed).toBe(true);
    expect(calls).toEqual(["router"]); // no kickstart: nothing is installed to kickstart
    expect(lines[0]).toBe("daemon: FAILED to start — not running (no service installed; pai daemon install)");
  });

  it("only restarts what is running", async () => {
    const calls: string[] = [];
    const { lines } = await reloadAll(deps({ daemon: true, router: true }, calls));
    expect(calls).toEqual(["router"]);
    expect(lines[0]).toBe("daemon: pid 10 -> 11, v1.2.3 built 2026-10-20 14:00:00");
    expect(lines[2]).toBe("pool host: not running, skipped");
  });

  it("is registered as a top-level command", () => {
    expect(GROUPS.flatMap((g) => g.commands).some((c) => c.name === "reload")).toBe(true);
  });
});

describe("startStoppedDaemon", () => {
  it("kickstarts the installed service and waits for the IPC socket", async () => {
    const calls: string[] = [];
    let up = false;
    const r = await startStoppedDaemon(
      daemon({
        pid: () => (up ? 42 : undefined),
        kickstart: () => (calls.push("kickstart"), true),
        socketUp: async () => up,
      }),
      { timeoutMs: 1000, pollMs: 100, sleep: async () => { up ||= true; } }
    );
    expect(r).toEqual({ ok: true, pid: 42 });
    expect(calls).toEqual(["kickstart"]);
  });

  it("returns the last error lines of the service log when it never comes up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-reload-test-"));
    const log = join(dir, "daemon.log");
    writeFileSync(log, "boot\nError: boom 1\nError: boom 2\n", "utf8");
    const r = await startStoppedDaemon(daemon({ socketUp: async () => false, logPath: () => log }), {
      timeoutMs: 200,
      pollMs: 100,
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(r.logTail).toEqual(["boot", "Error: boom 1", "Error: boom 2"]);
  });

  it("fails when kickstart itself fails, without probing the socket", async () => {
    const probes: string[] = [];
    const r = await startStoppedDaemon(
      daemon({ kickstart: () => false, socketUp: async () => (probes.push("probe"), true) }),
      { timeoutMs: 100, pollMs: 50, sleep: noSleep }
    );
    expect(r.ok).toBe(false);
    expect(r.logTail).toEqual(["kickstart failed"]);
    expect(probes).toEqual([]);
  });

  it("lastErrorLines reads the tail of the log and [] when there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-reload-test-"));
    const log = join(dir, "daemon.log");
    expect(lastErrorLines(log, 5)).toEqual([]);
    writeFileSync(log, "a\nb\nc\n", "utf8");
    expect(lastErrorLines(log, 2)).toEqual(["b", "c"]);
  });
});
