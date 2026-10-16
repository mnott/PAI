import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Backoff, LimitsCache, modelServed, readLastGood, staleReading, type LastGoodEntry, type LimitWindow } from "./limits.js";
import type { WorkerProvider } from "../workers/config.js";

describe("modelServed", () => {
  it("decides by served model id, not by the shared port", () => {
    const served = ["qwen36-35b"];
    expect(modelServed(served, ["qwen36-35b"])).toBe(true);
    expect(modelServed(served, ["glm47-flash", "glm47"])).toBe(false);
  });
  it("falls back to the port when the server lists nothing", () => {
    expect(modelServed(undefined, ["glm47"])).toBe(true);
  });
});

describe("last good readings and 429 backoff", () => {
  const NOW = 1_700_000_000_000;
  const WINDOWS: LimitWindow[] = [{ name: "5h", percent: 41, resetAt: NOW + 3_600_000 }];
  const dir = mkdtempSync(join(tmpdir(), "pai-limits-"));
  const lastGoodFile = (n: number) => join(dir, `last-${n}.json`);

  let srv: http.Server;
  let port = 0;
  let hits = 0;
  let status = 200;

  beforeAll(async () => {
    srv = http.createServer((_q, res) => {
      hits++;
      if (status !== 200) {
        res.writeHead(status);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pct: 41, reset: NOW + 3_600_000 }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  const provider = (): WorkerProvider => ({
    enabled: true,
    protocol: "openai",
    baseUrl: "https://relay.example.invalid",
    keyFile: null,
    key: "k",
    models: { default: "m" },
    env: {},
    usage: { url: `http://127.0.0.1:${port}/usage`, windows: [{ name: "5h", percent: ".pct", resetAt: ".reset", resetUnit: "ms" }] },
  });

  it("LastGoodServedOn429: a rate-limited poll serves the last good reading with its age", async () => {
    status = 200;
    const file = lastGoodFile(1);
    const cache = new LimitsCache({ providers: () => ({ p: provider() }), rows: () => [], lastGoodFile: file }, 60_000);
    const good = await cache.get(NOW);
    expect(good.find((l) => l.provider === "p")!.windows).toEqual(WINDOWS);
    expect(readLastGood(file)["p"]).toEqual({ windows: WINDOWS, fetchedAt: NOW } satisfies LastGoodEntry);

    status = 429;
    const stale = await cache.get(NOW + 61_000);
    const p = stale.find((l) => l.provider === "p")!;
    expect(p.windows).toEqual(WINDOWS);
    expect(p.fetchedAt).toBe(NOW);
    expect(p.error).toBe("stale 1min (http 429)");
  });

  it("BackoffDoublesAndResets: skipped while backing off, back to the base interval after a success", async () => {
    status = 200;
    const file = lastGoodFile(2);
    const cache = new LimitsCache({ providers: () => ({ p: provider() }), rows: () => [], lastGoodFile: file }, 60_000);
    await cache.get(NOW); // good
    status = 429;
    await cache.get(NOW + 61_000); // 429: the next poll of p is held back for 2 * ttl
    const n0 = hits;
    const skipped = await cache.get(NOW + 62_000);
    expect(hits).toBe(n0);
    expect(skipped.find((l) => l.provider === "p")!.windows).toEqual(WINDOWS);

    status = 200;
    const recovered = await cache.get(NOW + 182_000); // backoff (until NOW+181s) has run out
    expect(hits).toBe(n0 + 1);
    expect(recovered.find((l) => l.provider === "p")!.error).toBeUndefined();

    status = 429;
    await cache.get(NOW + 243_000); // strikes were reset: held back again by only 2 * ttl, not 4 *
    const n1 = hits;
    expect(await cache.get(NOW + 320_000).then((r) => r.find((l) => l.provider === "p")!.error)).toMatch(/stale /);
    expect(hits).toBe(n1);
    const again = await cache.get(NOW + 380_000); // due again: backoff expired at 243+120s (a reset-less strike would hold out until 483s)
    expect(hits).toBe(n1 + 1);
    expect(again.find((l) => l.provider === "p")!.error).toBe("stale 3min (http 429)");
  });

  it("BackoffDoublesAndResets: doubles per strike, caps at 30 min, resets on success", () => {
    const b = new Backoff(60_000);
    expect(b.penalize("p", 0)).toBe(120_000);
    expect(b.remaining("p", 1)).toBe(119_999);
    expect(b.remaining("p", 120_000)).toBe(0);
    expect(b.penalize("p", 120_000)).toBe(240_000);
    expect(b.penalize("p", 120_000)).toBe(480_000);
    let d = 0;
    for (let i = 0; i < 5; i++) d = b.penalize("p", 0);
    expect(d).toBe(30 * 60_000);
    b.reset("p");
    expect(b.remaining("p", 0)).toBe(0);
    expect(b.penalize("p", 0)).toBe(120_000);
  });

  it("StaleMaxAgeExpires: a last good reading older than 2h is not served", async () => {
    const file = lastGoodFile(3);
    writeFileSync(file, JSON.stringify({ p: { windows: [{ name: "5h", percent: 41 }], fetchedAt: NOW - 3 * 3_600_000 } }));
    status = 429;
    const cache = new LimitsCache({ providers: () => ({ p: provider() }), rows: () => [], lastGoodFile: file }, 60_000);
    const res = await cache.get(NOW);
    const p = res.find((l) => l.provider === "p")!;
    expect(p.windows).toEqual([]);
    expect(p.error).toBe("http 429");
  });

  it("ResetAtKeptFromLastGood: the stale reading keeps the old resetAt, so the gauge never says reset unknown", () => {
    const r = staleReading("anthropic", { windows: WINDOWS, fetchedAt: NOW - 600_000 }, "http 429", NOW);
    expect(r!.windows).toEqual(WINDOWS);
    expect(r!.error).toBe("stale 10min (http 429)");
  });

  it("NoLastGoodFallsBack: without a fresh last good reading the old fallbacks apply", () => {
    expect(staleReading("anthropic", undefined, "http 429", NOW)).toBeUndefined();
    expect(staleReading("p", { windows: [], fetchedAt: NOW - 1000 }, "http 429", NOW)).toBeUndefined();
    expect(staleReading("p", { windows: [{ name: "5h", percent: 9 }], fetchedAt: NOW - 2 * 3_600_000 }, "http 429", NOW)).toBeUndefined();
    expect(staleReading("p", { windows: [{ name: "5h", percent: 9 }], fetchedAt: NOW - 2 * 3_600_000 + 60_000 }, "http 429", NOW)).toBeDefined();
  });

  it("readLastGood ignores a corrupt or missing store", () => {
    const file = lastGoodFile(4);
    writeFileSync(file, "{oops");
    expect(readLastGood(file)).toEqual({});
    expect(readLastGood(join(dir, "missing.json"))).toEqual({});
  });
});
