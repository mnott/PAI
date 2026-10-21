import { describe, expect, it } from "vitest";
import { createEndpointHealth } from "./endpoint-health.js";
import type { LocalInstance } from "./local-instances.js";

const reg = (id: string): LocalInstance => ({
  id, model: id, provider: id, url: `http://${id}.lan:8000`, origin: "registered", port: 8000, state: "ready", startedAt: 0, log: "",
});
const managed: LocalInstance = { ...reg("m#1"), origin: "managed", pid: 1 };

describe("endpoint health", () => {
  it("excludes a down endpoint and readmits it once it recovers", async () => {
    let up = false;
    let t = 0;
    const calls: string[] = [];
    const h = createEndpointHealth({ probe: async (u) => { calls.push(u); return up; }, intervalMs: 100, now: () => t });
    const box = reg("box");
    expect(h.isHealthy(box)).toBe(true); // unprobed: optimistic
    await h.refresh([box, managed]);
    expect(h.isHealthy(box)).toBe(false);
    expect(h.isHealthy(managed)).toBe(true);
    up = true;
    t = 50;
    await h.refresh([box]); // cached inside the interval: no new probe
    expect(h.isHealthy(box)).toBe(false);
    expect(calls).toHaveLength(1);
    t = 150;
    await h.refresh([box]);
    expect(h.isHealthy(box)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("probes an endpoint once for concurrent refreshes and treats a throwing probe as down", async () => {
    let n = 0;
    const h = createEndpointHealth({ probe: async () => { n++; throw new Error("x"); } });
    const box = reg("box");
    await Promise.all([h.refresh([box]), h.refresh([box])]);
    expect(n).toBe(1);
    expect(h.isHealthy(box)).toBe(false);
  });

  it("managed health follows state", () => {
    const h = createEndpointHealth();
    expect(h.isHealthy({ ...managed, state: "starting" })).toBe(false);
  });
});
