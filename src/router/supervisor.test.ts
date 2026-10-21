import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRouter, routerIsStale, routerPidFile, runRouterTick } from "./supervisor.js";
import { defaults } from "../daemon/config.js";

describe("runRouterTick", () => {
  it("starts the router when the probe fails", async () => {
    const start = vi.fn();
    expect(await runRouterTick({ probe: async () => false, start })).toBe("started");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the router is up", async () => {
    const start = vi.fn();
    expect(await runRouterTick({ probe: async () => true, start })).toBe("up");
    expect(start).not.toHaveBeenCalled();
  });

  it("swaps an answering router gaplessly when its build is older", async () => {
    const start = vi.fn();
    const restart = vi.fn(async () => {});
    expect(await runRouterTick({ probe: async () => true, stale: () => true, restart, start })).toBe("restarted");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("leaves a router of the current build alone", async () => {
    const restart = vi.fn(async () => {});
    expect(await runRouterTick({ probe: async () => true, stale: () => false, restart, start: vi.fn() })).toBe("up");
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("probeRouter", () => {
  it("reflects whether the port accepts connections", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    expect(await probeRouter(port)).toBe(true);
    await new Promise((r) => srv.close(r));
    expect(await probeRouter(port)).toBe(false);
  });
});

describe("router config", () => {
  it("is off by default", () => {
    expect(defaults().router.enabled).toBe(false);
  });
});

describe("routerIsStale", () => {
  it("is true when the cli entry is newer than the router pid record", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-stale-"));
    const prev = process.env.PAI_HOME;
    process.env.PAI_HOME = dir;
    try {
      writeFileSync(routerPidFile(), "1");
      const entry = join(dir, "index.mjs");
      writeFileSync(entry, "");
      utimesSync(routerPidFile(), 1000, 1000);
      utimesSync(entry, 2000, 2000);
      expect(routerIsStale(entry)).toBe(true);
      utimesSync(entry, 500, 500);
      expect(routerIsStale(entry)).toBe(false);
      expect(routerIsStale(join(dir, "missing.mjs"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PAI_HOME;
      else process.env.PAI_HOME = prev;
    }
  });
});
