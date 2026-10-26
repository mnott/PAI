import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
// (afterAll imported above; used for the shared timeout sink below)
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loginUsername, resetLoginUsername } from "../utils/login-username.js";
import { dirname, join, resolve } from "node:path";
import net from "node:net";
import { vi } from "vitest";

const execMock = vi.hoisted(() => ({ impl: undefined as undefined | ((...a: unknown[]) => void) }));
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return { ...real, execFile: ((...a: unknown[]) => (execMock.impl ? execMock.impl(...a) : (real.execFile as (...x: unknown[]) => unknown)(...a))) as typeof real.execFile };
});
import {
  ANTHROPIC_POLL_MS,
  Backoff,
  HttpError,
  LimitsCache,
  anthropicShared,
  humanMinutes,
  localLimits,
  parseEngineVersion,
  modelServed,
  parsePrefixCacheStats,
  parseStrataCacheStats,
  parseRetryAfter,
  readLastGood,
  staleReading,
  type LastGoodEntry,
  type LimitWindow,
  staleText,
  type ProviderLimits,
  fetchAnthropicUsage,
  isAnthropicHost,
  keychainCredentialArgs,
  anthropicToken,
  tokenFailureCounts,
  resetTokenFailures,
} from "./limits.js";
import type { WorkerProvider } from "../workers/config.js";
import type { UsageRow } from "./usage.js";
import { parse } from "yaml";

describe("keychain credential lookup", () => {
  it("always selects the item by explicit account, from the passwd entry", () => {
    // USER unset: the account must still be the login user, not ""
    delete process.env.USER;
    delete process.env.LOGNAME;
    resetLoginUsername();
    const args = keychainCredentialArgs();
    expect(args).toEqual(["find-generic-password", "-s", "Claude Code-credentials", "-a", loginUsername(), "-w"]);
    expect(args[args.indexOf("-a") + 1]).toMatch(/\S/);
  });

  it("anthropicToken reads with -a <username> and works with USER unset", async () => {
    delete process.env.USER;
    delete process.env.LOGNAME;
    resetLoginUsername();
    const username = loginUsername();
    const seen: string[][] = [];
    execMock.impl = (...a: unknown[]) => {
      const [cmd, args, , cb] = a as [string, string[], unknown, (e: unknown, out: string, se: string) => void];
      seen.push([cmd, ...args]);
      cb(null, args[args.indexOf("-a") + 1] === username ? JSON.stringify({ claudeAiOauth: { accessToken: "tok-abc" } }) : "", "");
    };
    try {
      await expect(anthropicToken()).resolves.toBe("tok-abc");
    } finally {
      execMock.impl = undefined;
    }
    expect(seen).toEqual([["security", "find-generic-password", "-s", "Claude Code-credentials", "-a", username, "-w"]]);
  });

  it("anthropicToken failure: counts the reason by exit code and logs stderr", async () => {
    resetTokenFailures();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    execMock.impl = (...a: unknown[]) => (a[3] as (e: unknown, out: string, se: string) => void)(Object.assign(new Error("x"), { code: 44 }), "", "security: item could not be found");
    try {
      await expect(anthropicToken()).resolves.toBeUndefined();
    } finally {
      execMock.impl = undefined;
    }
    expect(tokenFailureCounts()).toEqual({ "exit 44": 1 });
    expect(String(err.mock.calls[0]![0])).toContain("exit 44");
    expect(String(err.mock.calls[0]![0])).toContain("could not be found");
    err.mockRestore();
  });
});

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
    expect(p.error).toBe("usage reading 1 min old, provider asked us to slow down");
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
    expect(await cache.get(NOW + 320_000).then((r) => r.find((l) => l.provider === "p")!.error)).toMatch(/^usage reading /);
    expect(hits).toBe(n1);
    const again = await cache.get(NOW + 380_000); // due again: backoff expired at 243+120s (a reset-less strike would hold out until 483s)
    expect(hits).toBe(n1 + 1);
    expect(again.find((l) => l.provider === "p")!.error).toMatch(/^usage reading 3 min old, provider asked us to slow down/);
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
    expect(p.error).toBe("provider asked us to slow down");
  });

  it("StaleTextNoEmptyParens: an empty or whitespace cause renders no parentheses", () => {
    expect(staleText(180_000, "")).toBe("usage reading 3 min old");
    expect(staleText(180_000, "   ")).toBe("usage reading 3 min old");
    expect(staleText(180_000, "", 120_000)).toBe("usage reading 3 min old, next try in 2 min");
    expect(staleText(180_000, "last fetch failed: timeout")).toBe("usage reading 3 min old (last fetch failed: timeout)");
  });

  it("ResetAtKeptFromLastGood: the stale reading keeps the old resetAt, so the gauge never says reset unknown", () => {
    const r = staleReading("anthropic", { windows: WINDOWS, fetchedAt: NOW - 600_000 }, "http 429", NOW);
    expect(r!.windows).toEqual(WINDOWS);
    expect(r!.error).toBe("usage reading 10 min old, provider asked us to slow down");
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

describe("anthropic usage poll: one door, 429 backoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-anthropic-poll-"));
  const BODY = JSON.stringify({ five_hour: { utilization: 42, resets_at: "2030-01-01T00:00:00Z" } });
  const files = (n: string) => ({ lastGoodFile: join(dir, `${n}-last.json`), gateFile: join(dir, `${n}-gate.json`) });

  const setup = (n: string) => {
    const f = files(n);
    const fetchUsage = vi.fn<() => Promise<string>>();
    const poll = () => anthropicShared(Date.now(), { gate: new Backoff(ANTHROPIC_POLL_MS, undefined, f.gateFile), lastGoodFile: f.lastGoodFile, fetchUsage });
    return { f, fetchUsage, poll };
  };

  afterEach(() => vi.useRealTimers());

  it("TokenReadFailureHoldsLastGood: a failed token read keeps the last reading with a transient cause", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { fetchUsage, poll } = setup("hold");
    fetchUsage.mockResolvedValueOnce(BODY);
    expect((await poll()).windows[0]!.percent).toBe(42);
    vi.advanceTimersByTime(ANTHROPIC_POLL_MS + 1000);
    fetchUsage.mockRejectedValueOnce(new Error("no OAuth token in keychain"));
    const held = await poll();
    expect(held.windows[0]!.percent).toBe(42);
    expect(held.error).toContain("no OAuth token in keychain");
  });

  it("PollIntervalShared: a reading younger than the poll interval is read, not fetched", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { fetchUsage, poll } = setup("interval");
    fetchUsage.mockResolvedValue(BODY);
    expect((await poll()).windows[0]!.percent).toBe(42);
    vi.advanceTimersByTime(ANTHROPIC_POLL_MS - 1000);
    const again = await poll();
    expect(again.windows[0]!.percent).toBe(42);
    expect(again.error).toBeUndefined();
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    await poll();
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("RetryAfterHonoured: a 429 with Retry-After holds every reader off for that long and says so in plain words", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { fetchUsage, poll } = setup("retry-after");
    fetchUsage.mockResolvedValueOnce(BODY);
    await poll();
    vi.advanceTimersByTime(ANTHROPIC_POLL_MS + 1000);
    fetchUsage.mockRejectedValueOnce(new HttpError(429, 15 * 60_000));
    const limited = await poll();
    expect(limited.rateLimited).toBe(true);
    expect(limited.windows[0]!.percent).toBe(42);
    expect(limited.error).toBe("usage reading 5 min old, provider asked us to slow down, next try in 15 min");
    expect(fetchUsage).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(14 * 60_000); // still inside Retry-After: no request, age keeps counting
    const held = await poll();
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(held.error).toBe("usage reading 19 min old, provider asked us to slow down, next try in 1 min");

    vi.advanceTimersByTime(2 * 60_000);
    fetchUsage.mockResolvedValueOnce(BODY);
    const ok = await poll();
    expect(fetchUsage).toHaveBeenCalledTimes(3);
    expect(ok.error).toBeUndefined();
  });

  it("ExponentialWithoutRetryAfter: 10, 20, 30 min and no more, reset by a success", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { fetchUsage, poll } = setup("exp");
    fetchUsage.mockResolvedValueOnce(BODY);
    await poll();
    const delays: Array<number | undefined> = [];
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(31 * 60_000);
      fetchUsage.mockRejectedValueOnce(new HttpError(429));
      delays.push((await poll()).retryAfterMs);
    }
    expect(delays).toEqual([10 * 60_000, 20 * 60_000, 30 * 60_000, 30 * 60_000]);
    vi.advanceTimersByTime(31 * 60_000);
    fetchUsage.mockResolvedValueOnce(BODY);
    await poll();
    vi.advanceTimersByTime(ANTHROPIC_POLL_MS + 1000);
    fetchUsage.mockRejectedValueOnce(new HttpError(429));
    expect((await poll()).retryAfterMs).toBe(10 * 60_000);
  });

  it("BackoffSharedAcrossProcesses: a second reader (own gate object, same files) does not fetch during a backoff", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { f, fetchUsage, poll } = setup("shared");
    fetchUsage.mockResolvedValueOnce(BODY);
    await poll();
    vi.advanceTimersByTime(ANTHROPIC_POLL_MS + 1000);
    fetchUsage.mockRejectedValueOnce(new HttpError(429, 600_000));
    await poll();
    const other = vi.fn<() => Promise<string>>().mockResolvedValue(BODY);
    const r = await anthropicShared(Date.now(), { gate: new Backoff(ANTHROPIC_POLL_MS, undefined, f.gateFile), lastGoodFile: f.lastGoodFile, fetchUsage: other });
    expect(other).not.toHaveBeenCalled();
    expect(r.rateLimited).toBe(true);
  });

  it("NoReadingYet: a 429 before any good reading says what is happening, not 'http 429'", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { fetchUsage, poll } = setup("cold");
    fetchUsage.mockRejectedValueOnce(new HttpError(429, 120_000));
    const r = await poll();
    expect(r.windows).toEqual([]);
    expect(r.error).toBe("provider asked us to slow down, next try in 2 min");
  });

  it("parseRetryAfter reads seconds and HTTP dates; humanMinutes reads plainly", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:30:00 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(120_000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(humanMinutes(4 * 60_000)).toBe("4 min");
    expect(humanMinutes(65 * 60_000)).toBe("1 h 5 min");
  });

  it("RetryAfterOverHttp: the real getJson path carries Retry-After from a 429 into the backoff", async () => {
    const srv = http.createServer((_q, res) => {
      res.writeHead(429, { "retry-after": "90" });
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { getJson } = await import("./limits.js");
    const err = await getJson(new URL(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`), {}).catch((e: unknown) => e);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).retryAfterMs).toBe(90_000);
  });
});

describe("local server up/down and prefix cache", () => {
  const local = (port: number): WorkerProvider => ({
    enabled: true,
    protocol: "anthropic",
    baseUrl: `http://127.0.0.1:${port}`,
    keyFile: null,
    key: "local",
    models: { default: "m-served", fast: "m-served" },
    env: {},
  });
  const listen = async (srv: http.Server | net.Server): Promise<number> => {
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return (srv.address() as AddressInfo).port;
  };
  // no lsof/ps subprocesses: they cost seconds under full-suite load
  const noRss = async () => undefined;
  const close = (srv: http.Server | net.Server) =>
    new Promise<void>((r) => {
      srv.close(() => r());
      // a background stats request or idle keep-alive socket would hold close() for seconds
      if (srv instanceof http.Server) srv.closeAllConnections();
    });

  it("ClosedPortIsDown: nothing listening", async () => {
    const s = net.createServer();
    const port = await listen(s);
    await close(s);
    expect((await localLimits("gone", local(port), [], Date.now())).up).toBe(false);
  });

  describe("busy is not down; down says why", () => {
    const stub = (tcp: "open" | "refused" | "timeout", served: { alive: boolean; timeout?: boolean; ids?: string[] }) => ({ probes: { tcp: async () => tcp, served: async () => served }, timeoutStrikes: undefined as number | undefined });
    const run = (n: string, o: ReturnType<typeof stub>) => localLimits(n, local(9), [], Date.now(), undefined, { ...o, listenerRssMb: noRss });

    // a sink that accepts the connection but never answers the request (no response written, socket kept):
    // the timeout comes from the injected servedTimeoutMs, not from machine load racing the 5 s default
    const sinkTimeout = async (n: string, strikes?: number): Promise<ProviderLimits[]> => {
      // an up (unknown) result also asks the sink for engine info, speed and cache stats: stub those and run the stats in the background, or each waits out its own 5 s
      const sockets = new Set<net.Socket>();
      let closing = false;
      const sink = net.createServer((sock) => {
        // a connection accepted late (after the probe gave up) must not hold close() open
        if (closing) return void sock.destroy();
        sockets.add(sock);
        sock.on("close", () => sockets.delete(sock));
      });
      const port = await listen(sink);
      try {
        const runOnce = async () => {
          try {
            return await localLimits(n, local(port), [], Date.now(), () => {}, { listenerRssMb: noRss, engineInfo: async () => ({}), strataSpeed: async () => null, servedTimeoutMs: 150, timeoutStrikes: strikes });
          } finally {
            // drop the timed-out request socket so it cannot hold close() open
            for (const sock of sockets) sock.destroy();
          }
        };
        const out: ProviderLimits[] = [];
        for (let i = 0; i < (strikes === undefined ? 3 : 1); i++) out.push(await runOnce());
        return out;
      } finally {
        closing = true;
        for (const sock of sockets) sock.destroy();
        await close(sink);
      }
    };

    it("a slow answer after a known-up state stays up, no downReason", async () => {
      expect((await run("busy-a", stub("open", { alive: true, ids: ["m-served"] }))).up).toBe(true);
      const slow = await run("busy-a", stub("open", { alive: false, timeout: true }));
      expect(slow.up).toBe(true);
      expect(slow.downReason).toBeUndefined();
      expect(slow.served).toEqual(["m-served"]);
    });
    it("a TCP connect timeout under load after a known-up state stays up", async () => {
      await run("busy-b", stub("open", { alive: true, ids: ["m-served"] }));
      expect((await run("busy-b", stub("timeout", { alive: false }))).up).toBe(true);
    });
    it("refused is down: not listening", async () => {
      await run("busy-c", stub("open", { alive: true, ids: ["m-served"] }));
      const r = await run("busy-c", stub("refused", { alive: false }));
      expect([r.up, r.downReason]).toEqual([false, "not listening"]);
    });
    it("a list without the model is down: model not served", async () => {
      const r = await run("busy-d", stub("open", { alive: true, ids: ["other"] }));
      expect([r.up, r.downReason]).toEqual([false, "model not served"]);
    });
    it("no HTTP answer on an accepted connection is down: no HTTP answer", async () => {
      const r = await run("busy-e", stub("open", { alive: false }));
      expect([r.up, r.downReason]).toEqual([false, "no HTTP answer"]);
    });
    it("fresh state: a first timeout is unknown, not down; timeoutStrikes timeouts from start are down", async () => {
      const r = await sinkTimeout("busy-f");
      expect(r.map((x) => x.up)).toEqual([true, true, false]);
      expect(r[0]!.downReason).toBeUndefined();
      expect(r[2]!.downReason).toBe("probe timeout");
      await run("busy-g", stub("open", { alive: true, ids: ["m-served"] }));
      const g = await sinkTimeout("busy-g");
      expect(g.map((x) => x.up)).toEqual([true, true, false]);
      expect(g[2]!.downReason).toBe("probe timeout");
    });
    it("timeoutStrikes 1 via opts turns a known-up server down after one timeout", async () => {
      await run("busy-h", stub("open", { alive: true, ids: ["m-served"] }));
      const [r] = await sinkTimeout("busy-h", 1);
      expect([r!.up, r!.downReason]).toEqual([false, "probe timeout"]);
    });
  });

  it("defaults config carries router.cockpit.probe.timeoutStrikes = 3", () => {
    const cfg = parse(readFileSync(resolve(__dirname, "..", "config", "defaults", "config.yaml"), "utf8")) as {
      router: { cockpit: { probe: { timeoutStrikes: number } } };
    };
    expect(cfg.router.cockpit.probe.timeoutStrikes).toBe(3);
  });

  it("AcceptingButNotServingIsDown: a socket holder (launchd-style) that accepts and drops the connection is not a running server", async () => {
    const holder = net.createServer((sock) => sock.destroy());
    const port = await listen(holder);
    const r = await localLimits("gpt20b", local(port), [], Date.now(), undefined, { listenerRssMb: noRss });
    await close(holder);
    expect(r.up).toBe(false);
    expect(r.prefixCache).toBeUndefined();
  });

  it("ServingIsUp, and its prefix-cache counters are reported", async () => {
    const stats = { engine_cache: { hits: 66, misses: 2, hit_rate: 0.97, tokens_saved: 259867, entry_count: 2, current_memory_mb: 5273.06 } };
    const srv = http.createServer((q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(q.url === "/v1/models" ? { data: [{ id: "m-served" }] } : stats));
    });
    const port = await listen(srv);
    const r = await localLimits("l", local(port), [], Date.now(), undefined, { listenerRssMb: noRss });
    await close(srv);
    expect(r.up).toBe(true);
    expect(r.prefixCache).toEqual({ hits: 66, misses: 2, hitRate: 66 / 68, tokensSaved: 259867, entries: 2, memoryMb: 5273.06 });
  });

  it("ServerWithoutStatsEndpoint: up, prefixCache left undefined (cockpit says 'not reported')", async () => {
    const srv = http.createServer((q, res) => {
      res.writeHead(q.url === "/v1/models" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m-served" }] }));
    });
    const port = await listen(srv);
    const r = await localLimits("l", local(port), [], Date.now(), undefined, { listenerRssMb: noRss });
    await close(srv);
    expect(r.up).toBe(true);
    expect(r.prefixCache).toBeUndefined();
  });

  describe("engine version of the server's engine child", () => {
    it("parseEngineVersion: name + version, a bare version, first line only, empty is nothing", () => {
      expect(parseEngineVersion("strata 0.1.48-metal\n")).toBe("0.1.48-metal");
      expect(parseEngineVersion("0.1.48-metal")).toBe("0.1.48-metal");
      expect(parseEngineVersion("strata 0.1.48-metal\n(unknown build)")).toBe("0.1.48-metal");
      expect(parseEngineVersion("")).toBeUndefined();
    });

    it("up server with an engine child: version and build dir; the binary is run once per path+mtime", async () => {
      const srv = http.createServer((_q, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "m-served" }] }));
      });
      const port = await listen(srv);
      const dir = mkdtempSync(join(tmpdir(), "eng-"));
      const bin = join(dir, "strata-pr", "engine", "strata");
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, "#!/bin/sh\necho strata 0.1.48-metal\n", { mode: 0o755 });
      // fake exec: the binary is run once per path+mtime; a failed run caches "no version" too
      let runs = 0;
      const run = (cmd: string, args: string[]): Promise<string | null> =>
        new Promise((r) => execFile(cmd, args, { timeout: 3000 }, (e, o) => r(e ? null : String(o ?? ""))));
      const cache = new Map<string, { mtimeMs: number; version?: string }>();
      const info = async (p: number) => {
        if (p !== port) return {};
        const mtimeMs = statSync(bin).mtimeMs;
        const c = cache.get(bin);
        if (c && c.mtimeMs === mtimeMs) return c.version ? { engineVersion: c.version, engineDir: "strata-pr" } : {};
        runs++;
        const version = parseEngineVersion((await run(bin, ["--version"])) ?? "");
        cache.set(bin, { mtimeMs, version });
        return version ? { engineVersion: version, engineDir: "strata-pr" } : {};
      };
      const mk = () => localLimits("eng", local(port), [], Date.now(), undefined, { listenerRssMb: noRss, engineInfo: info });
      const r = await mk();
      expect(r.engineVersion).toBe("0.1.48-metal");
      expect(r.engineDir).toBe("strata-pr");
      const again = await mk();
      expect(again.engineVersion).toBe("0.1.48-metal");
      expect(runs).toBe(1); // the second poll took the cache, no second run
      // a rebuild (new mtime) re-runs the binary
      writeFileSync(bin, "#!/bin/sh\necho strata 0.1.49-metal\n", { mode: 0o755 });
      expect((await mk()).engineVersion).toBe("0.1.49-metal");
      expect(runs).toBe(2);
      await close(srv);
    });

    it("no engine child (vllm-mlx, ollama): no engine fields at all", async () => {
      const srv = http.createServer((_q, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "m-served" }] }));
      });
      const port = await listen(srv);
      const r = await localLimits("v", local(port), [], Date.now(), undefined, { listenerRssMb: noRss, engineInfo: async () => ({}) });
      await close(srv);
      expect(r.up).toBe(true);
      expect(r.engineVersion).toBeUndefined();
      expect(r.engineDir).toBeUndefined();
    });

    it("a version run that fails reads as no version, the dir still shows", async () => {
      const srv = http.createServer((_q, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "m-served" }] }));
      });
      const port = await listen(srv);
      const r = await localLimits("e", local(port), [], Date.now(), undefined, { listenerRssMb: noRss, engineInfo: async () => ({ engineDir: "build-gyro3" }) });
      await close(srv);
      expect(r.engineVersion).toBeUndefined();
      expect(r.engineDir).toBe("build-gyro3");
    });
  });

  it("failing stats poll after a good one keeps the reading with its age; older than 10 min it is unknown", async () => {
    const stats = { engine_cache: { hits: 5, misses: 5, tokens_saved: 100 } };
    let failStats = false;
    const srv = http.createServer((q, res) => {
      if (q.url === "/v1/cache/stats" && failStats) return void res.destroy();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(q.url === "/v1/models" ? { data: [{ id: "m-served" }] } : stats));
    });
    const port = await listen(srv);
    const dir = mkdtempSync(join(tmpdir(), "pc-"));
    const cache = new LimitsCache({ providers: () => ({ l: local(port) }), rows: () => [], lastGoodFile: join(dir, "lg.json"), gate: new Backoff(60_000), fetchAnthropic: async () => "{}", probe: { listenerRssMb: noRss } }, 1);
    const t0 = Date.now();
    const first = await cache.get(t0);
    await cache.prefixSettled();
    const good = first.find((x) => x.provider === "l")!;
    expect(good.prefixCache?.hits).toBe(5);
    expect(good.prefixCacheAgeSec).toBeUndefined();
    failStats = true;
    const kept = (await cache.get(t0 + 90_000)).find((x) => x.provider === "l")!;
    expect(kept.prefixCache?.hits).toBe(5);
    expect(kept.prefixCacheAgeSec).toBe(90);
    const stale = (await cache.get(t0 + 601_000)).find((x) => x.provider === "l")!;
    await close(srv);
    expect(stale.up).toBe(true);
    expect(stale.prefixCache).toBeUndefined();
  });

  it("a disabled provider launched by a tier is listed as a running local; one no tier launches is not", async () => {
    const srv = http.createServer((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m-served" }] }));
    });
    const port = await listen(srv);
    const dir = mkdtempSync(join(tmpdir(), "pc-"));
    const off = { ...local(port), enabled: false };
    const mk = (tiers: string[]) => new LimitsCache({ providers: () => ({ tiered: off, stray: off }), rows: () => [], lastGoodFile: join(dir, "lg.json"), gate: new Backoff(60_000), fetchAnthropic: async () => "{}", tierProviders: () => tiers, probe: { listenerRssMb: noRss } }, 1);
    const got = await mk(["tiered"]).get(Date.now());
    await close(srv);
    expect(got.filter((x) => x.kind === "local").map((x) => [x.provider, x.up])).toEqual([["tiered", true]]);
  });

  it("restart: a new LimitsCache serves the persisted reading with its age; older than 10 min it is dropped", async () => {
    const srv = http.createServer((q, res) => {
      if (q.url === "/v1/cache/stats") return void res.destroy();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m-served" }] }));
    });
    const port = await listen(srv);
    const file = join(mkdtempSync(join(tmpdir(), "pc-")), "lg.json");
    const pc = { hits: 7, misses: 1, hitRate: 7 / 8, tokensSaved: 9 };
    const t0 = Date.now() - 120_000;
    writeFileSync(file, JSON.stringify({ l: { windows: [], fetchedAt: t0, prefixCache: pc } }));
    const mk = () => new LimitsCache({ providers: () => ({ l: local(port) }), rows: () => [], lastGoodFile: file, gate: new Backoff(60_000), fetchAnthropic: async () => "{}", probe: { listenerRssMb: noRss } }, 1);
    const c1 = mk();
    const r = (await c1.get(t0 + 120_000)).find((x) => x.provider === "l")!;
    await c1.prefixSettled();
    const old = (await mk().get(t0 + 700_000)).find((x) => x.provider === "l")!;
    await close(srv);
    expect(r.prefixCache).toEqual(pc);
    expect(r.prefixCacheAgeSec).toBe(120);
    expect(old.prefixCache).toBeUndefined();
  });

  it("slow stats (held open until released) do not delay up/down, still land within the 15 s timeout, and are persisted", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const srv = http.createServer((q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (q.url === "/v1/cache/stats") return void released.then(() => res.end(JSON.stringify({ engine_cache: { hits: 3, misses: 1, tokens_saved: 5 } })));
      res.end(JSON.stringify({ data: [{ id: "m-served" }] }));
    });
    const port = await listen(srv);
    const file = join(mkdtempSync(join(tmpdir(), "pc-")), "lg.json");
    const cache = new LimitsCache({ providers: () => ({ l: local(port) }), rows: () => [], lastGoodFile: file, gate: new Backoff(60_000), fetchAnthropic: async () => "{}", probe: { listenerRssMb: noRss } }, 1);
    const t0 = Date.now();
    const got = (await cache.get(t0)).find((x) => x.provider === "l")!;
    expect(got.up).toBe(true);
    expect(got.prefixCache).toBeUndefined();
    release();
    await cache.prefixSettled();
    await close(srv);
    expect(got.prefixCache?.hits).toBe(3);
    expect(readLastGood(file).l?.prefixCache?.hits).toBe(3);
  });

  it("parseStrataCacheStats: conversation_cache request counters become hits/misses; none = undefined", () => {
    const body = '{"conversation_cache":{"parked":1,"bytes":478390820,"requests":4,"requests_reused":3,"reused_tokens":381,"prompt_tokens":750}}';
    expect(parseStrataCacheStats(body)).toEqual({ hits: 3, misses: 1, hitRate: 0.75, tokensSaved: 381, entries: 1, memoryMb: 456 });
    expect(parseStrataCacheStats('{"conversation_cache":{"requests":0,"requests_reused":0}}')?.hitRate).toBe(0);
    expect(parseStrataCacheStats('{"engine":{}}')).toBeUndefined();
    expect(parseStrataCacheStats("not json")).toBeUndefined();
  });

  it("parsePrefixCacheStats: counters in, nothing out when the server carries none", () => {
    expect(parsePrefixCacheStats('{"engine_cache":{"hits":0,"misses":0,"tokens_saved":0}}')).toEqual({ hits: 0, misses: 0, hitRate: 0, tokensSaved: 0 });
    expect(parsePrefixCacheStats('{"engine_cache":null,"error":"x"}')).toBeUndefined();
    expect(parsePrefixCacheStats("not json")).toBeUndefined();
  });
});

describe("fetchAnthropicUsage token scope", () => {
  it("never reads or sends the token for a custom upstream", async () => {
    const token = vi.fn(async () => "secret");
    await expect(fetchAnthropicUsage(new URL("http://127.0.0.1:1/api/oauth/usage"), token)).rejects.toThrow("usage unavailable for custom upstream");
    await expect(fetchAnthropicUsage(new URL("https://evilanthropic.com/api/oauth/usage"), token)).rejects.toThrow("custom upstream");
    expect(token).not.toHaveBeenCalled();
  });
  it("recognises anthropic hosts", () => {
    expect(isAnthropicHost(new URL("https://api.anthropic.com/x"))).toBe(true);
    expect(isAnthropicHost(new URL("https://anthropic.com/x"))).toBe(true);
    expect(isAnthropicHost(new URL("https://anthropic.com.evil.io/x"))).toBe(false);
  });
});
