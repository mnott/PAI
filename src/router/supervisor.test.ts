import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:net";
import { probeRouter, runRouterTick } from "./supervisor.js";
import { DEFAULTS } from "../daemon/config.js";

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
});

describe("runRouterTick build change", () => {
  it("leaves a router of the current build alone", async () => {
    const start = vi.fn();
    const stop = vi.fn(async () => {});
    expect(await runRouterTick({ probe: async () => true, stale: () => false, stop, start })).toBe("up");
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("stops then starts a router of an older build", async () => {
    const calls: string[] = [];
    const r = await runRouterTick({
      probe: async () => true,
      stale: () => true,
      stop: async () => void calls.push("stop"),
      start: () => void calls.push("start"),
    });
    expect(r).toBe("restarted");
    expect(calls).toEqual(["stop", "start"]);
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
    expect(DEFAULTS.router.enabled).toBe(false);
  });
});
