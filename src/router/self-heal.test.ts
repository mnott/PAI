import http from "node:http";
import { describe, expect, it } from "vitest";
import { drainServers } from "./drain.js";
import { trackInflight } from "./inflight.js";
import { duplicatesToStop, parseRouterProcs, stopDuplicateRouters } from "./duplicates.js";
import { engineIdleFrom } from "./engine-idle.js";
import { RequestScheduler, DEFAULT_SCHED } from "./scheduler.js";

describe("bounded drain", () => {
  it("a stuck in-flight request is ended at the limit and the drain finishes", async () => {
    const inflight = trackInflight();
    const server = http.createServer(inflight.wrap(() => undefined)); // never answers
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const got = new Promise<number>((resolve) => http.get({ port, host: "127.0.0.1" }, (res) => resolve(res.statusCode ?? 0)).on("error", () => resolve(-1)));
    await new Promise((r) => setTimeout(r, 50));
    expect(inflight.count()).toBe(1);
    const t0 = Date.now();
    await drainServers([server], { timeoutMs: 200, onTimeout: () => void inflight.endAll("retry") });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await got).toBe(503);
    expect(server.listening).toBe(false);
  });
});

const PS = [
  "32611  1-02:10:00 /usr/bin/node /x/pai.js router run --port 8787",
  "39217     45:00 /usr/bin/node /x/pai.js router run --port 8787",
  "60145     00:30 /usr/bin/node /x/pai.js router run --port 8787",
  "70001  05:00:00 /usr/bin/node /x/pai.js router run --port 9999",
  "70002  05:00:00 vim router run --port 8787.md",
  "70003  05:00:00 /usr/bin/node /x/pai.js router restart",
].join("\n");

describe("duplicate routers", () => {
  it("parses only router run for the port", () => {
    expect(parseRouterProcs(PS, 8787).map((p) => p.pid)).toEqual([32611, 39217, 60145]);
  });
  it("keeps the serving pid and stops older ones past the drain window", () => {
    const procs = parseRouterProcs(PS, 8787);
    expect(duplicatesToStop(procs, 60145, 130)).toEqual({ keep: 60145, stop: [32611, 39217] });
  });
  it("leaves an old router still inside the drain window", () => {
    const procs = parseRouterProcs(PS, 8787);
    expect(duplicatesToStop(procs, 60145, 3000).stop).toEqual([32611]);
    expect(duplicatesToStop(procs, 60145, 99999).stop).toEqual([]);
  });
  it("never stops a newer router than the serving one", () => {
    const procs = parseRouterProcs(PS, 8787);
    expect(duplicatesToStop(procs, 32611, 130).stop).toEqual([]);
  });
  it("falls back to the newest when the pid file names none, and kills + ledgers exact pids", () => {
    const killed: number[] = [];
    const led: number[] = [];
    const r = stopDuplicateRouters(8787, 1, 130, { ps: () => PS, kill: (p) => void killed.push(p), ledger: (p) => void led.push(p) });
    expect(r).toEqual([32611, 39217]);
    expect(killed).toEqual(led);
  });
});

describe("engine-idle watchdog", () => {
  const f = (peak: number | null, at = new Date(1_000_000).toISOString()) => ({ at, gpuPct: peak, gpuAvgPct: peak, gpuPeakPct: peak }) as never;
  it("signal: idle only on a fresh 0 % reading", () => {
    expect(engineIdleFrom(f(0), 1_000_000)).toBe(true);
    expect(engineIdleFrom(f(40), 1_000_000)).toBe(false);
    expect(engineIdleFrom(f(null), 1_000_000)).toBe(false);
    expect(engineIdleFrom(f(0), 1_000_000 + 300_000)).toBe(false);
    expect(engineIdleFrom(null, 0)).toBe(false);
  });
  async function setup(idle: { v: boolean }) {
    let t = 0;
    const s = new RequestScheduler(() => ({ ...DEFAULT_SCHED, staleMin: 0 }), () => t);
    s.engineIdle = () => idle.v;
    s.engineIdleSecs = () => 90;
    const released: string[] = [];
    s.onEngineIdle = (_e, w) => void released.push(w);
    const ticket = await s.acquire("e", "s", "w1");
    let reaped = 0;
    ticket.onReap = () => void reaped++;
    return { s, advance: (ms: number) => void (t += ms), released, reaped: () => reaped };
  }
  it("releases after M seconds of in-flight with an idle engine", async () => {
    const x = await setup({ v: true });
    x.s.reapEngineIdle();
    x.advance(60_000);
    expect(x.s.reapEngineIdle()).toBe(0);
    x.advance(40_000);
    expect(x.s.reapEngineIdle()).toBe(1);
    expect(x.released).toEqual(["w1"]);
    expect(x.reaped()).toBe(1);
  });
  it("never releases while the engine shows activity", async () => {
    const idle = { v: false };
    const x = await setup(idle);
    x.advance(500_000);
    expect(x.s.reapEngineIdle()).toBe(0);
    idle.v = true; // the idle clock starts only now
    expect(x.s.reapEngineIdle()).toBe(0);
    x.advance(50_000);
    idle.v = false;
    x.s.reapEngineIdle();
    idle.v = true;
    x.advance(50_000);
    expect(x.s.reapEngineIdle()).toBe(0);
  });
});
