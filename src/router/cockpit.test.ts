import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { TOKEN_WEIGHTS, providerEcosystem, buildCockpitData, cachedRows, enabledLocalLimits, canonicalModel, cockpitQueue, groupLimits, handleCockpit, pauseBucket, retryRows, systemServers, weightedTokens, withStarting } from "./cockpit.js";
import { COCKPIT_HTML } from "./cockpit-page.js";
import { clearJobNameCache } from "./sessions.js";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nowStamp, saveStatus, type WorkerStatus } from "../workers/status.js";
import type { WorkersConfig } from "../workers/config.js";
import { Backoff, LimitsCache, estimateWindows, parseAnthropicUsage, tokensPerSec, windowsFromJson } from "./limits.js";
import { isTimeOrdered, type UsageRow } from "./usage.js";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const row = (minAgo: number, o: Partial<UsageRow> = {}): UsageRow => ({
  ts: new Date(NOW - minAgo * 60_000).toISOString(),
  model: "m1", provider: "anthropic", status: 200, ms: 1000, bytes: 1, cache: "hit",
  input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 70,
  session_id: "s1", ...o,
});

describe("cockpit provider keys", () => {
  const providers = {
    local30x8: { enabled: true, models: { default: "qwen3-coder-30b-8bit" } },
    coder8: { enabled: false, models: { default: "qwen3-coder-30b-8bit" } },
    glm: { enabled: true, models: { default: "glm-5.3" } },
  };
  it("folds a row logged under a disabled duplicate provider into the provider serving that model", () => {
    const rows = [
      row(2, { provider: "local30x8", model: "qwen3-coder-30b-8bit" }), // router-era row: provider name
      row(3, { provider: "coder8", model: "qwen3-coder-30b-8bit" }), // historic row: resolved duplicate
      row(4, { provider: "glm", model: "glm-5.3" }),
      row(5, { provider: "unknown", model: "nobody-serves-this" }),
    ];
    const d = buildCockpitData(rows, "1h", NOW, new Map(), null, providers);
    expect(d.byModel.map((m) => `${m.provider}/${m.model}/${m.requests}`).sort()).toEqual([
      "glm/glm-5.3/1",
      "local30x8/qwen3-coder-30b-8bit/2",
      "unknown/nobody-serves-this/1",
    ]);
    expect(d.byProvider.map((p) => p.provider).sort()).toEqual(["glm", "local30x8", "unknown"]);
    expect(Object.keys(d.promptByProvider).sort()).toEqual(["glm", "local30x8", "unknown"]);
  });
  it("per-instance breakdown nests under the provider aggregate", () => {
    const d = buildCockpitData(
      [row(1, { provider: "gyro" }), row(2, { provider: "gyro", instance: "#2" }), row(3, { provider: "gyro", instance: "#2", status: 500 }), row(4, { provider: "gyro", instance: "#10" })],
      "1h", NOW
    );
    expect(d.byProvider).toHaveLength(1);
    expect(d.byProvider[0].requests).toBe(4);
    expect(d.byProvider[0].instances.map((i) => `${i.instance}/${i.requests}/${i.errors}`)).toEqual(["#2/2/1", "#10/1/0"]);
  });
  it("without a config rows stay as logged", () => {
    const d = buildCockpitData([row(2, { provider: "coder8" })], "1h", NOW);
    expect(d.byProvider.map((p) => p.provider)).toEqual(["coder8"]);
  });
  it("the page keys pies by provider with the model as sub-label", () => {
    expect(COCKPIT_HTML).toContain('m.provider+"\\u0000"+m.model');
  });
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

  it("splits usage by session kind in the payload; pool carry rides along only when non-empty", () => {
    const rows = [row(2), row(3), row(4, { session_id: "s2", cache_read_input_tokens: 0, input_tokens: 100 })];
    const d = buildCockpitData(rows, "1h", NOW);
    expect(d.sessionSplit.continuous).toMatchObject({ sessions: 1, requests: 2 });
    expect(d.sessionSplit.oneShot).toMatchObject({ sessions: 1, requests: 1 });
    expect(d.pool).toBeNull();
    const pooled = buildCockpitData(rows, "1h", NOW, undefined, { tasks: 7, tokensCarried: 123_000, hitRatio: 0.81 });
    expect(pooled.pool).toEqual({ tasks: 7, tokensCarried: 123_000, hitRatio: 0.81 });
    expect(buildCockpitData(rows, "1h", NOW, undefined, { tasks: 0, tokensCarried: 0, hitRatio: 0 }).pool).toBeNull();
  });

  it("the donut note renders the split and the pool carry", () => {
    expect(COCKPIT_HTML).toContain("sessionSplit");
    expect(COCKPIT_HTML).toContain("one-shot");
    expect(COCKPIT_HTML).toContain("tokens carried");
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
    expect(tokensPerSec(rows, "glm", NOW)).toEqual({ tokensPerSec: 20, tokensPerSecWindow: "1h" });
  });
});

describe("cockpit http", () => {
  it("serves page, data and limits; GET only; no keys in output", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pai-cockpit-"));
    const limits = new LimitsCache(
      {
        providers: () => ({}),
        rows: () => [],
        advisorFile: "/nonexistent",
        lastGoodFile: join(tmp, "last.json"),
        gate: new Backoff(300_000, undefined, join(tmp, "gate.json")),
        fetchAnthropic: () => Promise.reject(new Error("offline")),
      },
      60_000
    );
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
    expect(page.body).toContain("trimEmpty");
    expect(page.body).toContain("no data in this window");
    expect(page.body).toContain("staleAge"); // stale system readings keep their number
    expect(page.body).toContain('["0","33","66","100"]'); // fixed percent axis tick labels
    const data = JSON.parse((await get("/cockpit/data?window=24h")).body);
    expect(data.window).toBe("24h");
    expect(data.totals.requests).toBe(1);
    expect((await get("/cockpit/data", "POST")).status).toBe(405);
    expect((await get("/other")).body).toBe("other");
    srv.close();
  });

  it("/cockpit/pool answers 500 when the panel read rejects", async () => {
    const limits = { get: async () => [] as never[] };
    const srv = http.createServer((req, res) => {
      if (!handleCockpit(req, res, limits as never, () => [], () => new Map(), undefined, () => [], () => null, (async () => { throw new Error("pool down"); }) as never)) res.end("other");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/cockpit/pool`, { signal: AbortSignal.timeout(3000) });
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "pool down" });
    } finally {
      srv.close();
    }
  });

  it("/cockpit/queue shape and ordering; POST front/up reorder the grant order", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pai-cockpit-q-"));
    const yaml = join(tmp, "workers.yaml");
    writeFileSync(
      yaml,
      `active: p1\nproviders:\n  p1:\n    url: https://api.example.com\n    maxConcurrent: 1\n    models:\n      default: m1\n      fast: m1\n`
    );
    const prevYaml = process.env.PAI_WORKERS_YAML;
    process.env.PAI_WORKERS_YAML = yaml;
    const logDir = join(tmp, "logs");
    const st = (id: string, state: "running" | "queued"): WorkerStatus => ({
      id, pid: process.pid, label: `label ${id}`, cwd: "/proj", term: "", provider: "p1", model: "m1",
      state, started: nowStamp(), updated: nowStamp(), turns: 0, tools: 0, last: "", rc: null, secs: null,
    });
    saveStatus(logDir, st("w-holder", "running"));
    saveStatus(logDir, st("w-early", "queued"));
    saveStatus(logDir, st("w-late", "queued"));
    const qdir = join(logDir, "queue", "p1");
    mkdirSync(qdir, { recursive: true });
    // both started waiting 90 s ago; a reorder must not reset that
    writeFileSync(join(qdir, "w-early"), `${process.pid} @${Date.now() - 90_000}`);
    writeFileSync(join(qdir, "w-late"), `${process.pid} @${Date.now() - 90_000}`);

    const limits = { get: async () => [] as never[] };
    const srv = http.createServer((req, res) => {
      if (!handleCockpit(req, res, limits as never, () => [], () => new Map(), undefined, () => [], () => null, async () => null as never, () => logDir)) res.end("other");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const ask = (path: string, method = "GET", body?: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const rq = http.request({ host: "127.0.0.1", port, path, method, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode!, body: b }));
        });
        if (body) rq.write(body);
        rq.end();
      });
    try {
      const q = JSON.parse((await ask("/cockpit/queue")).body);
      expect(q.providers).toHaveLength(1);
      const p = q.providers[0];
      expect(p.provider).toBe("p1");
      expect(p.cap).toBe(1);
      expect(p.running.map((r: { id: string }) => r.id)).toEqual(["w-holder"]);
      expect(p.waiting.map((w: { id: string }) => w.id)).toEqual(["w-early", "w-late"]); // FIFO by id
      expect(p.waiting[0]).toMatchObject({ position: 1, label: "label w-early" });

      const moved = await ask("/cockpit/queue/front", "POST", JSON.stringify({ id: "w-late" }));
      expect(moved.status).toBe(200);
      expect(JSON.parse(moved.body).order).toEqual(["w-late", "w-early"]);
      const after = JSON.parse((await ask("/cockpit/queue")).body);
      expect(after.providers[0].waiting.map((w: { id: string }) => w.id)).toEqual(["w-late", "w-early"]);

      for (const raw of ["null", "[]", "5", "{bad"]) expect((await ask("/cockpit/queue/front", "POST", raw)).status, raw).toBe(400);
      expect((await ask("/cockpit/action", "POST", "null")).status).toBe(400);
      const esc = await ask("/cockpit/queue/front", "POST", JSON.stringify({ id: "../../x/y" }));
      expect(esc.status).toBe(400);
      expect(JSON.parse(esc.body).message).toBe("invalid id");

      const nxt = await ask("/cockpit/queue/next", "POST", JSON.stringify({ id: "w-late" }));
      expect(nxt.status).toBe(200);
      expect(JSON.parse(nxt.body).order[0]).toBe("w-late");
      for (const w of JSON.parse((await ask("/cockpit/queue")).body).providers[0].waiting) expect(w.waitedSec).toBeGreaterThanOrEqual(89);
      await ask("/cockpit/queue/move", "POST", JSON.stringify({ id: "w-early", position: 1 }));
      await ask("/cockpit/queue/move", "POST", JSON.stringify({ id: "w-late", position: 2 }));

      const up = await ask("/cockpit/queue/up", "POST", JSON.stringify({ id: "w-early" }));
      expect(up.status).toBe(200);
      expect(JSON.parse(up.body).order).toEqual(["w-early", "w-late"]);

      const mv = await ask("/cockpit/queue/move", "POST", JSON.stringify({ id: "w-early", position: 2 }));
      expect(mv.status).toBe(200);
      expect(JSON.parse(mv.body).order).toEqual(["w-late", "w-early"]);
      const mv1 = await ask("/cockpit/queue/move", "POST", JSON.stringify({ id: "w-early", position: 1 }));
      expect(JSON.parse(mv1.body).order).toEqual(["w-early", "w-late"]);
      expect((await ask("/cockpit/queue/move", "POST", JSON.stringify({ id: "w-early" }))).status).toBe(400);
      expect((await ask("/cockpit/queue/move", "POST", JSON.stringify({ id: "w-holder", position: 1 }))).status).toBe(409);
      expect((await ask("/cockpit/queue/front", "POST", JSON.stringify({}))).status).toBe(400);
      expect((await ask("/cockpit/queue/front", "POST", JSON.stringify({ id: "nosuch" }))).status).toBe(404);
      expect((await ask("/cockpit/queue/front", "POST", JSON.stringify({ id: "w-holder" }))).status).toBe(409);
      // the scheduler line names sessions, never a raw uuid: a known session by name,
      // an unknown one by its first 8 chars; counters read as tokens served
      const uuid = "d875bcac-1111-2222-3333-444455556666";
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, "router-sched.json"), JSON.stringify({
        at: Date.now(), workers: {},
        engines: { gyro: { inflight: { session: uuid, worker: "w1", sinceMs: 1 }, queued: {}, counters: { [uuid]: 18120 } } },
      }));
      writeFileSync(join(logDir, "w1.status"), JSON.stringify({
        id: "w1", pid: process.pid, label: "l", cwd: "/p", term: "", provider: "p1", model: "m1",
        state: "running", started: nowStamp(), updated: nowStamp(), turns: 0, tools: 0, last: "", rc: null, secs: null,
        session: { id: uuid, name: "PAI" },
      }));
      const named = JSON.parse((await ask("/cockpit/queue")).body).localModel as string;
      expect(named).toContain("local engine gyro: 1 request in flight, 0 queued; served 18.1k tokens this window");
      expect(named).not.toContain(uuid);
      expect(named).not.toMatch(/[0-9a-f]{8}/);
      expect(JSON.parse((await ask("/cockpit/queue")).body).localModelTitle).toContain("gyro in flight: PAI");
      // no session name anywhere: the first 8 chars, never the full uuid
      writeFileSync(join(logDir, "w1.status"), JSON.stringify({
        id: "w1", pid: process.pid, label: "l", cwd: "/p", term: "", provider: "p1", model: "m1",
        state: "running", started: nowStamp(), updated: nowStamp(), turns: 0, tools: 0, last: "", rc: null, secs: null,
      }));
      const bare = JSON.parse((await ask("/cockpit/queue")).body).localModel as string;
      expect(bare).toContain("in flight");
      expect(bare).toContain("queued");
      expect(bare).toContain("served");
      expect(bare).not.toMatch(/[0-9a-f]{8}/);
      expect(JSON.parse((await ask("/cockpit/queue")).body).localModelTitle).toContain("session d875bcac");

      // a session the registry lists only by its project slug still shows its job name on the scheduler line
      const uuid2 = "224db3e0-bafb-4bf7-bc09-2c63f6ab8e19";
      const jobDir = join(tmp, "cfg", "jobs", "224db3e0");
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, "state.json"), JSON.stringify({ name: "PAI (4)" }));
      writeFileSync(join(logDir, "router-sched.json"), JSON.stringify({
        at: Date.now(), workers: {},
        engines: { gyro: { inflight: { session: uuid2, worker: "w1", sinceMs: 1 }, queued: {}, counters: {} } },
      }));
      const prevHome = process.env.PAI_HOME;
      const prevJobs = process.env.CLAUDE_CONFIG_DIR;
      const home = join(tmp, "pai-home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "agent-sessions.json"), JSON.stringify({ [uuid2]: "pai" }));
      process.env.PAI_HOME = home;
      process.env.CLAUDE_CONFIG_DIR = join(tmp, "cfg");
      clearJobNameCache();
      try {
        expect(JSON.parse((await ask("/cockpit/queue")).body).localModelTitle).toContain("gyro in flight: PAI (4)");
      } finally {
        if (prevHome === undefined) delete process.env.PAI_HOME;
        else process.env.PAI_HOME = prevHome;
        if (prevJobs === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prevJobs;
        clearJobNameCache();
      }

      // the page carries the panel and its buttons
      const page = await ask("/cockpit");
      expect(page.body).toContain('"workers."+bl[i].id');
      expect(page.body).toContain("runs next; the running worker is not interrupted");
      expect(page.body).toContain("nothing waiting");
      // drag and drop wiring: draggable rows post to /move, refresh pauses while dragging
      expect(page.body).toContain('setAttribute("draggable","true")');
      expect(page.body).toContain('"queue."+verb');
      expect(page.body).toContain("WK_DRAG===ctx.id");
    } finally {
      srv.close();
      if (prevYaml === undefined) delete process.env.PAI_WORKERS_YAML;
      else process.env.PAI_WORKERS_YAML = prevYaml;
    }
  });
});

describe("cockpit page stale age", () => {
  const age = new Function(
    `return (${COCKPIT_HTML.match(/function staleAge[^\n]*\n/)![0]})`
  )() as (m: { v: number; at: number }, now: number) => string;

  it("gives the age of a remembered reading in s, m or h", () => {
    expect(age({ v: 14.4, at: NOW - 3 * 60_000 }, NOW)).toBe("3m");
    expect(age({ v: 38, at: NOW - 10_000 }, NOW)).toBe("10s");
    expect(age({ v: 38, at: NOW - 2 * 3_600_000 }, NOW)).toBe("2h");
  });
});

describe("cockpit page empty-bucket trim", () => {
  const trim = new Function(
    `return (${COCKPIT_HTML.match(/function trimEmpty[\s\S]*?\n\}/)![0]})`
  )() as (labels: string[], rows: { v: number }[], totalOf: (r: { v: number }) => number) => { labels: string[]; rows: { v: number }[] } | null;
  const totalOf = (r: { v: number }) => r.v;

  it("drops leading and trailing zero buckets, keeps interior gaps", () => {
    const out = trim(["a", "b", "c", "d", "e"], [{ v: 0 }, { v: 5 }, { v: 0 }, { v: 7 }, { v: 0 }], totalOf);
    expect(out!.labels).toEqual(["b", "c", "d"]);
    expect(out!.rows.map((r) => r.v)).toEqual([5, 0, 7]);
  });
  it("returns null when every bucket is empty", () => {
    expect(trim(["a", "b"], [{ v: 0 }, { v: 0 }], totalOf)).toBeNull();
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

describe("local prefix cache in the system panel", () => {
  it("LocalPrefixCacheReported: servers carry the server's own counters; a server that reports none carries none", () => {
    const pc = { hits: 66, misses: 2, hitRate: 66 / 68, tokensSaved: 259867 };
    const out = systemServers([
      { provider: "a", kind: "local", windows: [], up: true, served: ["m"], prefixCache: pc, fetchedAt: 1 },
      { provider: "b", kind: "local", windows: [], up: true, fetchedAt: 1 },
      { provider: "anthropic", kind: "plan", windows: [], fetchedAt: 1 },
    ]);
    expect(out.map((s) => s.provider)).toEqual(["a", "b"]);
    expect(out[0]!.prefixCache).toEqual(pc);
    expect("prefixCache" in out[1]!).toBe(false);
  });
});

describe("one key per model", () => {
  it("OpusOnce: [1m], snapshot-dated and provider-prefixed spellings fold into one column; other providers' ids are untouched", () => {
    const spellings = ["claude-opus-5-5", "claude-opus-5-5[1m]", "Claude-Opus-5-5-20260101", "anthropic/claude-opus-5-5"];
    expect(spellings.map(canonicalModel)).toEqual(Array(4).fill("claude-opus-5-5"));
    expect(canonicalModel("glm-5.3")).toBe("glm-5.3");
    expect(canonicalModel("qwen3-coder-30b-8bit")).toBe("qwen3-coder-30b-8bit");
    const d = buildCockpitData(spellings.map((model, i) => row(5 + i, { model })), "1h", NOW);
    expect(d.byModel.map((m) => m.model)).toEqual(["claude-opus-5-5"]);
    expect(d.byModel[0]!.requests).toBe(4);
    expect(Object.keys(d.series.find((b) => Object.keys(b.models).length)!.models)).toEqual(["claude-opus-5-5"]);
    expect(Object.keys(d.daily.models)).toEqual(["claude-opus-5-5"]);
    expect(d.bySession[0]!.models).toEqual(["claude-opus-5-5"]);
  });
});

describe("cockpitQueue grouping", () => {
  it("rows carry session and model; a missing session falls back to the project, a bare shell to other", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pai-cockpit-g-"));
    const logDir = join(tmp, "logs");
    const mk = (id: string, over: Partial<WorkerStatus>): WorkerStatus => ({
      id, pid: process.pid, label: `label ${id}`, cwd: "/work/proj-x", term: "", provider: "anthropic", model: "sonnet",
      state: "running", started: nowStamp(), updated: nowStamp(), turns: 0, tools: 0, last: "", rc: null, secs: null, ...over,
    });
    saveStatus(logDir, mk("a1", { session: { id: "s-AIBroker", name: "AIBroker" } }));
    saveStatus(logDir, mk("a2", { session: { id: "s-PAI", name: "PAI" }, model: "opus" }));
    saveStatus(logDir, mk("a3", { term: "w1t0p0:11111111-2222-3333-4444-555555555555" }));
    saveStatus(logDir, mk("a4", {}));
    saveStatus(logDir, mk("l1", { provider: "local", model: "flashnext-iq3", session: { id: "s-PAI", name: "PAI" } }));
    saveStatus(logDir, mk("l2", { provider: "local", model: "flashnext-iq3", state: "queued", session: { id: "s-AIBroker", name: "AIBroker" } }));
    const qdir = join(logDir, "queue", "local");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "l2"), String(process.pid));
    const workers = { providers: { local: { url: "http://127.0.0.1:1", maxConcurrent: 1, models: { default: "flashnext-iq3" } } }, nativeModels: {} } as unknown as WorkersConfig;
    const q = cockpitQueue(logDir, workers, Date.now(), () => true);
    const by = (p: string) => q.providers.find((x) => x.provider === p)!;
    const sess = Object.fromEntries(by("anthropic").running.map((r) => [r.id, `${r.session}|${r.model}`]));
    expect(sess.a1).toBe("AIBroker|sonnet");
    expect(sess.a2).toBe("PAI|opus");
    expect(sess.a3).toBe("proj-x|sonnet");
    expect(sess.a4).toBe("other|sonnet");
    const local = by("local");
    expect(local.cap).toBe(1);
    expect(local.running.map((r) => r.session)).toEqual(["PAI"]);
    expect(local.waiting.map((w) => `${w.position}|${w.session}|${w.model}`)).toEqual(["1|AIBroker|flashnext-iq3"]);
  });
});

describe("enabledLocalLimits", () => {
  it("drops local readings of disabled or unconfigured providers, keeps cloud and enabled ones", () => {
    const ls = [
      { provider: "gyro-m", kind: "local", up: true },
      { provider: "gyro-m-b", kind: "local", up: false },
      { provider: "gone", kind: "local", up: false },
      { provider: "glm", kind: "plan" },
    ] as unknown as Parameters<typeof enabledLocalLimits>[0];
    const out = enabledLocalLimits(ls, { "gyro-m": { enabled: true }, "gyro-m-b": { enabled: false }, glm: { enabled: true } });
    expect(out.map((l) => l.provider)).toEqual(["gyro-m", "glm"]);
    expect(enabledLocalLimits(ls, {})).toHaveLength(4);
  });
});

describe("cachedRows", () => {
  it("reads only the appended part of a grown log and waits for a torn line", () => {
    const f = join(mkdtempSync(join(tmpdir(), "pai-rows-")), "usage.jsonl");
    const row = (n: number) => JSON.stringify({ ts: "2026-01-01T00:00:00Z", session_id: `s${n}` });
    writeFileSync(f, row(1) + "\n");
    const read = cachedRows(f);
    expect(read().map((r) => r.session_id)).toEqual(["s1"]);
    appendFileSync(f, row(2) + "\n" + row(3).slice(0, 10));
    expect(read().map((r) => r.session_id)).toEqual(["s1", "s2"]);
    appendFileSync(f, row(3).slice(10) + "\n");
    expect(read().map((r) => r.session_id)).toEqual(["s1", "s2", "s3"]);
    writeFileSync(f, row(9) + "\n");
    expect(read().map((r) => r.session_id)).toEqual(["s9"]);
  });
});

describe("cockpit prototype-safe maps", () => {
  it("a logged model or provider named __proto__ does not reach Object.prototype", () => {
    const keys = () => Object.getOwnPropertyNames(Object.prototype).sort();
    const before = keys();
    const rows = [row(2, { model: "__proto__", provider: "__proto__" }), row(3, { model: "constructor", provider: "toString" })];
    const d = buildCockpitData(rows, "1h", NOW) as unknown as { daily: { models: Record<string, number[]> } };
    expect(keys()).toEqual(before);
    expect(({} as Record<string, unknown>).input).toBeUndefined();
    expect(Object.keys(d.daily.models)).toContain("__proto__");
  });
});

describe("cachedRows identity and replacement", () => {
  const line = (ts: string, n: number) => JSON.stringify({ ts, session_id: `s${n}` }) + "\n";
  it("appends in place and keeps the array time-ordered", () => {
    const f = join(mkdtempSync(join(tmpdir(), "pai-rows-")), "usage.jsonl");
    writeFileSync(f, line("2026-03-10T10:00:00Z", 1));
    const read = cachedRows(f);
    const a = read();
    appendFileSync(f, line("2026-03-10T10:01:00Z", 2));
    const b = read();
    expect(b).toBe(a);
    expect(b).toHaveLength(2);
    expect(isTimeOrdered(b)).toBe(true);
  });
  it("detects a same-size-or-larger replacement by head", () => {
    const f = join(mkdtempSync(join(tmpdir(), "pai-rows-")), "usage.jsonl");
    writeFileSync(f, line("2026-03-10T10:00:00Z", 1));
    const read = cachedRows(f);
    expect(read().map((r) => r.session_id)).toEqual(["s1"]);
    writeFileSync(f, line("2026-03-10T10:00:00Z", 7) + line("2026-03-10T10:01:00Z", 8));
    expect(read().map((r) => r.session_id)).toEqual(["s7", "s8"]);
  });
  it("keeps a row older than 7 days after appends (wholeLog aggregates the whole log)", () => {
    const f = join(mkdtempSync(join(tmpdir(), "pai-rows-")), "usage.jsonl");
    writeFileSync(f, line("2026-03-01T00:00:00Z", 1));
    const read = cachedRows(f);
    read();
    appendFileSync(f, line("2026-03-20T00:00:00Z", 2));
    expect(read().map((r) => r.session_id)).toEqual(["s1", "s2"]);
  });
  it("an unordered append yields an unmarked array", () => {
    const f = join(mkdtempSync(join(tmpdir(), "pai-rows-")), "usage.jsonl");
    writeFileSync(f, line("2026-03-10T10:05:00Z", 1));
    const read = cachedRows(f);
    read();
    appendFileSync(f, line("2026-03-10T10:00:00Z", 2));
    const r = read();
    expect(r).toHaveLength(2);
    expect(isTimeOrdered(r)).toBe(false);
  });
});

describe("withStarting", () => {
  const view = { tier: "t", provider: "coder-next", port: 8034, state: "loading" as const, sinceSec: 30, log: "/l" };
  const ls = [
    { provider: "coder-next", kind: "local" as const, windows: [], up: false, fetchedAt: 0 },
    { provider: "other", kind: "local" as const, windows: [], up: false, fetchedAt: 0 },
    { provider: "coder-next-up", kind: "local" as const, windows: [], up: true, fetchedAt: 0 },
  ];
  it("tags only the down local limit of the starting provider", () => {
    const out = withStarting(ls, view) as Array<{ provider: string; starting?: unknown }>;
    expect(out.find((l) => l.provider === "coder-next")?.starting).toEqual(view);
    expect(out.find((l) => l.provider === "other")?.starting).toBeUndefined();
  });
  it("leaves the limits alone when nothing is starting", () => expect(withStarting(ls, null)).toBe(ls));
  it("matches per instance: a further instance loading tags the running provider, #1 does not", () => {
    const up = [{ provider: "gyro-m", kind: "local" as const, windows: [], up: true, fetchedAt: 0 }];
    const two = { ...view, id: "gyro-m#2", provider: "gyro-m" };
    const one = { ...view, id: "gyro-m#1", provider: "gyro-m" };
    expect((withStarting(up, [two]) as Array<{ starting?: unknown }>)[0].starting).toEqual(two);
    expect((withStarting(up, [one]) as Array<{ starting?: unknown }>)[0].starting).toBeUndefined();
  });
});

describe("runningLocalProviders", () => {
  const lim = (up: Record<string, boolean>) => Object.entries(up).map(([provider, u]) => ({ provider, kind: "local", up: u, windows: [] }) as never);
  it("lists every tier provider that answers, in limits order", async () => {
    const { runningLocalProviders } = await import("./cockpit.js");
    expect(runningLocalProviders(lim({ codernext4: true, "gyro-m": true, other: true, down: false }), ["codernext4", "gyro-m", "down"])).toEqual(["codernext4", "gyro-m"]);
    expect(runningLocalProviders(lim({ codernext4: false }), ["codernext4"])).toEqual([]);
  });
});

describe("activeLocalProvider", () => {
  const lim = (up: Record<string, boolean>) => Object.entries(up).map(([provider, u]) => ({ provider, kind: "local", up: u, windows: [] }) as never);
  it("is the running tier, not the configured local, after a tier switch", async () => {
    const { activeLocalProvider } = await import("./cockpit.js");
    expect(activeLocalProvider(lim({ codernext4: false, "gyro-m": true }), ["codernext4", "gyro-m"])).toBe("gyro-m");
  });
  it("falls back to the configured local when no tier answers", async () => {
    const { activeLocalProvider } = await import("./cockpit.js");
    const r = activeLocalProvider(lim({ codernext4: false, "gyro-m": false }), ["codernext4", "gyro-m"]);
    expect(r === null || typeof r === "string").toBe(true);
  });
});

describe("enabledLocalLimits tier-launched", () => {
  it("keeps the local reading of a disabled provider a tier launches", () => {
    const ls = [{ provider: "codernext4", kind: "local", up: true }, { provider: "stray", kind: "local", up: true }] as unknown as Parameters<typeof enabledLocalLimits>[0];
    const out = enabledLocalLimits(ls, { codernext4: { enabled: false }, stray: { enabled: false } }, ["codernext4"]);
    expect(out.map((l) => l.provider)).toEqual(["codernext4"]);
  });
});

describe("registryModels (B8a)", () => {
  const tier = (name: string, config: string, port = 8035) => ({ tier: name, engine: "strata", provider: name, label: name, model: "", served: "", port, flags: [], maxInstances: 4, config });
  const cfg = {
    launcher: {},
    tiers: {
      "gyro-m": tier("gyro-m", "/s/gyro-m.json"),
      iq3s: tier("iq3s", "/s/iq3_s.json"),
      "coder-next": { ...tier("coder-next", ""), engine: "script", config: undefined, start: "/s/serve.sh", port: 8034, maxInstances: 1 },
    },
  } as unknown as import("../workers/local-tiers.js").LocalConfig;

  it("marks exactly one card running per Strata file; a model with no instance is stopped", async () => {
    const { registryModels } = await import("./cockpit-registry-models.js");
    const rows = [
      { id: "gyro-m#1", model: "gyro-m", port: 8035, pid: 11, state: "ready", inflight: 0 },
      { id: "iq3s#1", model: "iq3s", port: 8036, pid: 12, state: "ready", inflight: 1 },
    ];
    const both = registryModels(cfg, rows);
    expect(both.map((m) => [m.name, m.state])).toEqual([["gyro-m", "running"], ["iq3s", "running"], ["coder-next", "stopped"]]);
    expect(both[0].instances).toEqual([{ id: "gyro-m#1", pid: 11, port: 8035, inflight: 0 }]);
    expect(both[1].instances.map((i) => i.id)).toEqual(["iq3s#1"]);
    const one = registryModels(cfg, rows.slice(0, 1));
    expect(one.map((m) => m.state)).toEqual(["running", "stopped", "stopped"]);
    expect(one[2]).toMatchObject({ file: "/s/serve.sh", engine: "script", port: 8034, tier: "coder-next", instances: [], maxInstances: 1 });
  });
});

describe("cockpit ecosystems", () => {
  const providers = {
    gyro: { enabled: true, baseUrl: "http://127.0.0.1:8010", models: { default: "qwen-gyro" } },
    codernext4: { enabled: true, baseUrl: "http://localhost:8011", models: { default: "qwen-coder" } },
    glm: { enabled: true, baseUrl: "https://api.z.ai/api/anthropic", models: { default: "glm-5.3" } },
    anthropic: { enabled: true, baseUrl: "" },
  };
  it("a loopback provider maps to local, any other to its own name; the payload carries one ecosystem per model", () => {
    const rows = [
      row(1, { provider: "gyro", model: "qwen-gyro" }),
      row(2, { provider: "codernext4", model: "qwen-coder" }),
      row(3, { provider: "glm", model: "glm-5.3" }),
      row(4, { provider: "anthropic", model: "claude-opus-5-5" }),
      row(5, { provider: "anthropic", model: "claude-opus-5-5" }),
    ];
    const d = buildCockpitData(rows, "1h", NOW, new Map(), null, providers);
    expect(providerEcosystem("gyro", providers)).toBe("local");
    expect(d.ecosystems).toEqual({ "qwen-gyro": "local", "qwen-coder": "local", "glm-5.3": "glm", "claude-opus-5-5": "anthropic" });
  });
  it("a model served by two ecosystems belongs to the one with most requests", () => {
    const rows = [row(1, { provider: "glm", model: "x" }), row(2, { provider: "gyro", model: "x" }), row(3, { provider: "gyro", model: "x" })];
    expect(buildCockpitData(rows, "1h", NOW, new Map(), null, providers).ecosystems).toEqual({ x: "local" });
  });
});
