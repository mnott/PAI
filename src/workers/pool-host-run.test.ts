/**
 * pool-host-run.test.ts — a host death leaves a trace, and a rebuild can not leave a stale state file:
 * the bind policy that raced `pai reload` against the host's own reload (EADDRINUSE -> silent exit 1).
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBindHandler, installExitLogging, openHostLog, poolHostLogPath } from "./pool-host-run.js";
import { ledgerPath } from "./paths.js";

const addrInUse = Object.assign(new Error("in use"), { code: "EADDRINUSE" }) as NodeJS.ErrnoException;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("bind policy", () => {
  it("retries while the predecessor holds the port, then listens", async () => {
    const listen = vi.fn(), fail = vi.fn();
    const h = createBindHandler({ listen, alive: async () => false, retry: (fn) => fn(), fail });
    h(addrInUse);
    await flush();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
  });
  it("steps aside (exit 0) when a healthy host already owns the port", async () => {
    const fail = vi.fn();
    createBindHandler({ listen: vi.fn(), alive: async () => true, retry: vi.fn(), fail })(addrInUse);
    await flush();
    expect(fail).toHaveBeenCalledWith(0, expect.stringContaining("superseded"));
  });
  it("gives up with exit 1 when the port never frees", async () => {
    const fail = vi.fn();
    const h = createBindHandler({ listen: vi.fn(), alive: async () => false, retry: vi.fn(), fail, maxTries: 1 });
    h(addrInUse);
    await flush();
    expect(fail).toHaveBeenCalledWith(1, expect.stringContaining("still held"));
  });
  it("other listen errors fail at once", () => {
    const fail = vi.fn();
    createBindHandler({ listen: vi.fn(), alive: async () => false, retry: vi.fn(), fail })(Object.assign(new Error("x"), { code: "EACCES" }));
    expect(fail).toHaveBeenCalledWith(1, expect.any(String));
  });
});

describe("exit logging", () => {
  it("an uncaught exception and an unhandled rejection write POOL-HOST-EXIT and exit 1", () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-hostrun-"));
    const handlers: Record<string, (e: unknown) => void> = {};
    const exit = vi.fn();
    installExitLogging({ logDir, pid: 4242, on: (ev, cb) => (handlers[ev] = cb), exit });
    handlers.uncaughtException(new Error("boom"));
    handlers.unhandledRejection("nope");
    const ledger = readFileSync(ledgerPath(logDir), "utf8");
    expect(ledger).toMatch(/POOL-HOST-EXIT.*pid=4242.*uncaughtException: Error: boom/);
    expect(ledger).toMatch(/POOL-HOST-EXIT.*unhandledRejection: nope/);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("host.log", () => {
  it("is created and rotated past the cap", () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-hostrun-"));
    openHostLog(logDir);
    expect(existsSync(poolHostLogPath(logDir))).toBe(true);
    writeFileSync(poolHostLogPath(logDir), "x".repeat(50));
    openHostLog(logDir, 10);
    expect(readFileSync(`${poolHostLogPath(logDir)}.1`, "utf8")).toHaveLength(50);
    expect(readFileSync(poolHostLogPath(logDir), "utf8")).toBe("");
  });
});
