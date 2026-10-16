import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { TOKEN_WEIGHTS, buildCockpitData, groupLimits, handleCockpit, pauseBucket, retryRows, weightedTokens } from "./cockpit.js";
import { LimitsCache, estimateWindows, parseAnthropicUsage, tokensPerSec, windowsFromJson } from "./limits.js";
import type { UsageRow } from "./usage.js";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const row = (minAgo: number, o: Partial<UsageRow> = {}): UsageRow => ({
  ts: new Date(NOW - minAgo * 60_000).toISOString(),
  model: "m1", provider: "anthropic", status: 200, ms: 1000, bytes: 1, cache: "hit",
  input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 70,
  session_id: "s1", ...o,
});

describe("cockpit aggregation", () => {
  it("buckets pauses", () => {
    expect([undefined, 5, 59.9, 60, 299, 300, 3599, 3600].map(pauseBucket)).toEqual(["first", "<1m", "<1m", "1-5m", "1-5m", "5-60m", "5-60m", ">60m"]);
  });

  it("series buckets: 5-minute buckets over 1h, tokens per model", () => {
    const d = buildCockpitData([row(2), row(3), row(40, { model: "m2" }), row(200)], "1h", NOW);
    expect(d.bucketMs).toBe(300_000);
    expect(d.totals.requests).toBe(3);
    const filled = d.series.filter((b) => Object.keys(b.models).length);
    expect(filled).toHaveLength(2);
    expect(filled[1]!.models.m1!.requests).toBe(2);
    expect(filled[0]!.models.m2!.cacheRead).toBe(70);
  });

  it("hourly buckets over 24h and daily over 7d", () => {
    expect(buildCockpitData([], "24h", NOW).bucketMs).toBe(3_600_000);
    const d = buildCockpitData([row(60 * 24 * 3), row(10)], "7d", NOW);
    expect(d.bucketMs).toBe(86_400_000);
    expect(d.totals.requests).toBe(2);
    expect(d.daily.days).toHaveLength(14);
    expect(d.daily.models.m1!.reduce((a, b) => a + b, 0)).toBe(200);
  });

  it("cache verdict per model by pause bucket", () => {
    const d = buildCockpitData(
      [row(1, { gap_s: 30 }), row(2, { gap_s: 400, cache: "write", cache_read_input_tokens: 0, cache_creation_input_tokens: 90 }), row(3)],
      "1h", NOW
    );
    const b = Object.fromEntries(d.cachePause[0]!.buckets.map((x) => [x.label, x]));
    expect(b["<1m"]).toMatchObject({ n: 1, hit: 1 });
    expect(b["5-60m"]).toMatchObject({ n: 1, write: 1, writeTok: 90 });
    expect(b.first!.n).toBe(1);
  });

  it("errors, retries per provider; busts per session; worker join", () => {
    const rows = [
      row(5, { provider: "glm", status: 429 }),
      row(4, { provider: "glm" }),
      row(3, { provider: "glm", session_id: "s2", bust: ["system", "tools"] }),
    ];
    const sessions = new Map([["s2", { name: "fix it", worker: "w9", verdict: "ok", provider: "glm" }]]);
    const d = buildCockpitData(rows, "1h", NOW, sessions);
    const p = d.byProvider[0]!;
    expect([p.requests, p.errors, p.retries]).toEqual([3, 1, 1]);
    expect(d.bustParts).toEqual({ system: 1, tools: 1 });
    expect(d.workers.map((w) => [w.worker, w.name, w.verdict, w.busts])).toEqual([["w9", "fix it", "ok", 1]]);
    expect(retryRows(rows).size).toBe(1);
  });
});

describe("limits parsing", () => {
  it("anthropic oauth usage", () => {
    const w = parseAnthropicUsage(JSON.stringify({ five_hour: { utilization: 12, resets_at: "2026-03-10T14:00:00+00:00" }, seven_day: { utilization: 88.5, resets_at: "2026-03-14T06:00:00+00:00" }, seven_day_opus: null }));
    expect(w).toEqual([
      { name: "5h", percent: 12, resetAt: Date.parse("2026-03-10T14:00:00Z") },
      { name: "7d", percent: 88.5, resetAt: Date.parse("2026-03-14T06:00:00Z") },
    ]);
    expect(parseAnthropicUsage("not json")).toEqual([]);
  });

  it("provider windows via configured jq (kimi iso, zai ms)", () => {
    const kimi = windowsFromJson(
      JSON.stringify({ usages: { limit_5h: { used_ratio: 0.25, reset_time: "2026-03-10T15:00:00Z" } } }),
      { url: "x", windows: [{ name: "5h", percent: ".usages.limit_5h.used_ratio * 100", resetAt: ".usages.limit_5h.reset_time", resetUnit: "iso" }] }
    );
    expect(kimi).toEqual([{ name: "5h", percent: 25, resetAt: Date.parse("2026-03-10T15:00:00Z") }]);
    const zai = windowsFromJson(
      JSON.stringify({ data: { limits: [{ number: 5, percentage: 40, nextResetTime: 1773151200000 }] } }),
      { url: "x", windows: [{ name: "5h", percent: ".data.limits[]? | select(.number == 5) | .percentage", resetAt: ".data.limits[]? | select(.number == 5) | .nextResetTime", resetUnit: "ms" }, { name: "7d", percent: ".data.limits[]? | select(.number == 7) | .percentage" }] }
    );
    expect(zai).toEqual([{ name: "5h", percent: 40, resetAt: 1773151200000 }]);
  });

  it("estimated windows count requests against a cap; tokens/s", () => {
    const rows = [row(10, { provider: "glm" }), row(20, { provider: "glm" }), row(60 * 30, { provider: "glm" }), row(5)];
    expect(estimateWindows(rows, "glm", { "5h": 10 }, NOW)).toEqual([
      { name: "5h", percent: 20, resetAt: NOW - 20 * 60_000 + 5 * 3_600_000, estimated: true },
    ]);
    expect(tokensPerSec(rows, "glm", NOW)).toEqual({ tokensPerSec: 20 });
  });
});

describe("cockpit http", () => {
  it("serves page, data and limits; GET only; no keys in output", async () => {
    const limits = new LimitsCache({ providers: () => ({}), rows: () => [], advisorFile: "/nonexistent" }, 60_000);
    const srv = http.createServer((req, res) => {
      if (!handleCockpit(req, res, limits, () => [{ ...row(1), ts: new Date().toISOString() }], () => new Map())) res.end("other");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const get = (path: string, method = "GET") =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const rq = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode!, body: b }));
        });
        rq.end();
      });
    const page = await get("/cockpit");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<svg");
    const data = JSON.parse((await get("/cockpit/data?window=24h")).body);
    expect(data.window).toBe("24h");
    expect(data.totals.requests).toBe(1);
    expect((await get("/cockpit/data", "POST")).status).toBe(405);
    expect((await get("/other")).body).toBe("other");
    srv.close();
  });
});

describe("cockpit weights and groups", () => {
  it("weights tokens by Anthropic price ratios", () => {
    expect(TOKEN_WEIGHTS).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
    expect(weightedTokens({ input: 100, cacheWrite: 100, cacheRead: 1000, output: 10 })).toBeCloseTo(100 + 125 + 100 + 50);
  });
  it("groups local providers apart from cloud", () => {
    const g = groupLimits([{ kind: "plan", p: "a" }, { kind: "estimated", p: "b" }, { kind: "local", p: "c" }]);
    expect(g.cloud.map((l) => l.p)).toEqual(["a", "b"]);
    expect(g.local.map((l) => l.p)).toEqual(["c"]);
  });
  it("exposes the weights in the data", () => {
    expect(buildCockpitData([], "1h").weights).toEqual(TOKEN_WEIGHTS);
  });
});
