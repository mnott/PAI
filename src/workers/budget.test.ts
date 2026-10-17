/**
 * Tests for the live budget probes behind policy "budget": window picking,
 * wall lookup, the reading cache (one poll per TTL, shared inflight), and the
 * workers.yaml `usage`-endpoint fetch (percent + reset, failures unknown).
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  BudgetCache,
  budgetCache,
  budgetExceeded,
  budgetSkipReason,
  budgetUntilLabel,
  budgetWall,
  fetchBudgetReading,
  pickBudgetWindow,
  type BudgetReading,
} from "./budget.js";
import { parseWorkersConfig, type WorkersConfig } from "./config.js";

const reading = (percent: number | null, resetAt: number | null = null, fetchedAt = Date.now()): BudgetReading => ({
  percent,
  resetAt,
  fetchedAt,
});

const oneProviderConfig = (usageUrl?: string): WorkersConfig =>
  parseWorkersConfig({
    enabled: true,
    active: "auto",
    providers: {
      glm: {
        enabled: true,
        protocol: "anthropic",
        baseUrl: "https://api.example.com/api/anthropic",
        key: "k",
        keyFile: null,
        models: { default: "example-4.7" },
        env: {},
        ...(usageUrl
          ? { usage: { url: usageUrl, windows: [{ name: "5h", percent: ".pct", resetAt: ".reset", resetUnit: "ms" }] } }
          : {}),
      },
    },
  });

afterEach(() => budgetCache.clear());

describe("pickBudgetWindow", () => {
  it("takes the fullest window with its reset (a full 5h window is the wall)", () => {
    const reset = Date.now() + 1_800_000;
    const r = pickBudgetWindow(
      [
        { name: "5h", percent: 76, resetAt: reset },
        { name: "7d", percent: 20, resetAt: reset + 5 * 86_400_000 },
      ],
      1_000
    );
    expect(r).toEqual({ percent: 76, resetAt: reset, fetchedAt: 1_000 });
  });

  it("no windows reads as unknown, never as full", () => {
    expect(pickBudgetWindow([], 1_000)).toEqual({ percent: null, resetAt: null, fetchedAt: 1_000 });
  });
});

describe("budgetWall and budgetExceeded", () => {
  const routing = parseWorkersConfig({ enabled: true }).routing;

  it("walls come per provider from routing.budgetWalls, else the built-in defaults", () => {
    // the built-in defaults: anthropic 95, glm 90, kimi 85
    expect(budgetWall(routing, "anthropic")).toBe(95);
    expect(budgetWall(routing, "glm")).toBe(90);
    expect(budgetWall(routing, "kimi")).toBe(85);
    expect(budgetWall(routing, "other")).toBe(95);
    const custom = parseWorkersConfig({
      enabled: true,
      routing: { budgetWalls: { anthropic: 95, glm: 90, kimi: 85 } },
    }).routing;
    expect(budgetWall(custom, "glm")).toBe(90);
    expect(budgetWall(custom, "kimi")).toBe(85);
  });

  it("unknown readings never exceed their wall", () => {
    expect(budgetExceeded(undefined, 90)).toBe(false);
    expect(budgetExceeded(reading(null), 90)).toBe(false);
    expect(budgetExceeded(reading(90), 90)).toBe(true);
    expect(budgetExceeded(reading(89.9), 90)).toBe(false);
  });
});

describe("budgetUntilLabel / budgetSkipReason", () => {
  it("labels the reset time, or now + 10 min when the endpoint did not say", () => {
    const now = new Date(2026, 9, 17, 7, 32, 0);
    expect(budgetUntilLabel(reading(96, now.getTime() + 30 * 60_000), now)).toBe("08:02");
    expect(budgetUntilLabel(reading(96, now.getTime() - 1), now)).toBe("07:42");
  });

  it("the switch reason names the skipped provider, its percent and its reset", () => {
    const now = new Date(2026, 9, 17, 7, 32, 0);
    expect(budgetSkipReason("anthropic", reading(96, now.getTime() + 30 * 60_000), now)).toBe(
      "anthropic 96% until 08:02"
    );
  });
});

describe("BudgetCache", () => {
  it("ProbeCache: one poll per provider per TTL, inflight shared, stale map re-probed after the TTL", async () => {
    const calls: string[] = [];
    const cache = new BudgetCache(60_000, async (name) => {
      calls.push(name);
      return reading(10);
    });
    const cfg = oneProviderConfig();
    const first = await cache.warm(cfg, 1_000);
    expect(Object.keys(first).sort()).toEqual(["anthropic", "glm"]);
    expect(calls.sort()).toEqual(["anthropic", "glm"]);

    await cache.warm(cfg, 2_000);
    expect(calls.length).toBe(2);

    const [a, b] = [cache.warm(cfg, 3_000), cache.warm(cfg, 3_000)];
    expect((await a) === (await b)).toBe(true);
    expect(calls.length).toBe(2);

    await cache.warm(cfg, 61_000 + 1_000);
    expect(calls.length).toBe(4);
  });

  it("a seeded cache serves readings without polling until the TTL runs out", async () => {
    let polled = 0;
    const cache = new BudgetCache(60_000, async (name) => {
      polled++;
      return reading(50, null);
    });
    cache.seed({ glm: reading(96, 123) }, 5_000);
    const cfg = oneProviderConfig();
    await cache.warm(cfg, 6_000);
    expect(cache.get("glm")).toEqual(reading(96, 123));
    expect(polled).toBe(0);
    await cache.warm(cfg, 66_000);
    expect(polled).toBe(2);
    expect(cache.get("glm")!.percent).toBe(50);
  });
});

describe("fetchBudgetReading — the workers.yaml usage endpoint", () => {
  let srv: http.Server;
  let port = 0;
  let status = 200;
  let body = "{}";

  beforeAll(async () => {
    srv = http.createServer((_q, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  it("reads percent and resetAt from the configured jq windows", async () => {
    status = 200;
    body = JSON.stringify({ pct: 76.4, reset: 1_700_000_000_000 });
    const r = await fetchBudgetReading("glm", oneProviderConfig(`http://127.0.0.1:${port}/u`).providers.glm!);
    expect(r.percent).toBe(76.4);
    expect(r.resetAt).toBe(1_700_000_000_000);
  });

  it("a failing endpoint reads as unknown, never as full", async () => {
    status = 500;
    const r = await fetchBudgetReading("glm", oneProviderConfig(`http://127.0.0.1:${port}/u`).providers.glm!);
    expect(r.percent).toBeNull();
    expect(r.resetAt).toBeNull();
  });

  it("a provider without a usage block reads as unknown without a poll", async () => {
    const r = await fetchBudgetReading("glm", oneProviderConfig().providers.glm!);
    expect(r.percent).toBeNull();
  });
});

describe("routing config: policy / priority / budgetWalls parsing", () => {
  it("parses the budget routing block", () => {
    const c = parseWorkersConfig({
      enabled: true,
      routing: { policy: "budget", priority: ["anthropic", "glm", "kimi"], budgetWalls: { glm: 90, kimi: 85 } },
    });
    expect(c.routing.policy).toBe("budget");
    expect(c.routing.priority).toEqual(["anthropic", "glm", "kimi"]);
    expect(c.routing.budgetWalls).toEqual({ glm: 90, kimi: 85 });
  });

  it("defaults to budget policy with an empty priority list", () => {
    const c = parseWorkersConfig({ enabled: true });
    expect(c.routing.policy).toBe("budget");
    expect(c.routing.priority).toEqual([]);
    expect(c.routing.budgetWalls).toEqual({});
  });

  it("rejects an unknown policy and a non-numeric wall", () => {
    expect(() => parseWorkersConfig({ enabled: true, routing: { policy: "cheapest" } })).toThrow(/routing.policy/);
    expect(() => parseWorkersConfig({ enabled: true, routing: { budgetWalls: { glm: "high" } } })).toThrow(
      /budgetWalls.glm/
    );
    expect(() => parseWorkersConfig({ enabled: true, routing: { priority: [7] } })).toThrow(/routing.priority/);
  });
});
