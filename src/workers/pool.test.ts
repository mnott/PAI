/**
 * pool.test.ts — the worker session pool core: eligibility gate, boundary
 * marker, slot picking/reaping, state + metrics round-trips, and the client
 * transport against a loopback stub of the host.
 */

import { describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import {
  DEFAULT_POOL_SETTINGS,
  appendPoolMetric,
  carriedShare,
  poolCarry,
  poolDir,
  poolHostAlive,
  poolIneligibleReason,
  poolMetricsPath,
  poolSettings,
  poolStatePath,
  poolTaskBoundary,
  pooledTaskText,
  postTaskToPool,
  pickSlot,
  readPoolMetrics,
  readPoolState,
  slotIdleFor,
  slotKey,
  slotShouldReap,
  writePoolState,
  type PoolMetricRow,
  type PoolSlotRecord,
} from "./pool.js";
import { defaultWorkersConfig, type WorkerProvider } from "./config.js";

const newLogDir = (): string => mkdtempSync(join(tmpdir(), "pai-pool-"));

const provider = (over: Partial<WorkerProvider> = {}): WorkerProvider => ({
  enabled: true,
  protocol: "anthropic",
  baseUrl: "https://example.invalid",
  keyFile: null,
  models: { default: "m1" },
  env: {},
  ...over,
});

describe("pool settings", () => {
  it("default OFF; poolSettings applies defaults per field", () => {
    const cfg = defaultWorkersConfig();
    expect(cfg.pool.enabled).toBe(false);
    expect(poolSettings(cfg)).toEqual(DEFAULT_POOL_SETTINGS);
    expect(
      poolSettings({ ...cfg, pool: { enabled: true, maxSlots: 2, idleSecs: 60, port: 9000 } })
    ).toEqual({ enabled: true, maxSlots: 2, idleSecs: 60, port: 9000 });
    expect(poolSettings({ ...cfg, pool: { enabled: true, maxSlots: 5, idleSecs: 0, port: 8798 } }).idleSecs).toBe(0);
  });
});

describe("eligibility gate", () => {
  const base = () => ({
    headless: true,
    prompt: "do a thing",
    providerName: "glm",
    provider: provider(),
    worktreeFlag: false as const,
    resumeOf: undefined,
    printCmd: false,
    parsed: { callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: [] },
    mcpFlag: undefined,
    noBrowser: true,
    outputFormat: "text" as const,
    cwd: undefined,
    slotCwd: "/neutral/dir",
  });

  it("eligible: headless, no worktree, plain spec, matching cwd", () => {
    expect(poolIneligibleReason(base())).toBeNull();
    expect(poolIneligibleReason({ ...base(), cwd: "/neutral/dir" })).toBeNull();
  });

  it("interactive runs are never pooled", () => {
    expect(poolIneligibleReason({ ...base(), headless: false })).toBe("interactive");
    expect(poolIneligibleReason({ ...base(), prompt: null })).toBe("interactive");
  });

  it("native anthropic keeps fresh spawns — by name and by flag", () => {
    expect(poolIneligibleReason({ ...base(), providerName: "anthropic" })).toBe("native-provider");
    expect(poolIneligibleReason({ ...base(), provider: provider({ native: true }) })).toBe("native-provider");
  });

  it("non-claude engines are refused", () => {
    expect(poolIneligibleReason({ ...base(), provider: provider({ engine: "codex" }) })).toBe("engine");
  });

  it("worktree, resume and print-cmd runs get their own process", () => {
    expect(poolIneligibleReason({ ...base(), worktreeFlag: undefined })).toBe("worktree");
    expect(poolIneligibleReason({ ...base(), worktreeFlag: true })).toBe("worktree");
    expect(poolIneligibleReason({ ...base(), resumeOf: "w1" })).toBe("resume");
    expect(poolIneligibleReason({ ...base(), printCmd: true })).toBe("print-cmd");
  });

  it("a caller-owned system prompt, MCP config or browser grant would not match a slot", () => {
    expect(
      poolIneligibleReason({ ...base(), parsed: { callerSystemPrompt: true, callerMcpConfig: false, mcp: [], allowedTools: [] } })
    ).toBe("system-prompt");
    expect(poolIneligibleReason({ ...base(), mcpFlag: "desktop" })).toBe("mcp");
    expect(
      poolIneligibleReason({ ...base(), parsed: { callerSystemPrompt: false, callerMcpConfig: true, mcp: [], allowedTools: [] } })
    ).toBe("mcp");
    expect(
      poolIneligibleReason({ ...base(), parsed: { callerSystemPrompt: false, callerMcpConfig: false, mcp: ["pai"], allowedTools: [] } })
    ).toBe("mcp");
    expect(
      poolIneligibleReason({
        ...base(),
        parsed: { callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: ["mcp__pai__memory_search"] },
      })
    ).toBe("mcp");
    expect(
      poolIneligibleReason({
        ...base(),
        noBrowser: false,
        parsed: { callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: ["mcp__claude-in-chrome__tabs"] },
      })
    ).toBe("browser");
    // with the browser grant off limits, chrome tools never reach the pool
    expect(
      poolIneligibleReason({
        ...base(),
        noBrowser: true,
        parsed: { callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: ["mcp__claude-in-chrome__tabs"] },
      })
    ).toBeNull();
  });

  it("stream-json consumers and foreign cwds fall back", () => {
    expect(poolIneligibleReason({ ...base(), outputFormat: "stream-json" })).toBe("stream-json");
    expect(poolIneligibleReason({ ...base(), cwd: "/some/repo" })).toBe("cwd");
  });
});

describe("task boundary", () => {
  it("every pooled turn opens with the NEW TASK delimiter naming the cwd", () => {
    const b = poolTaskBoundary(3, "/neutral/dir");
    expect(b).toContain("NEW TASK 3");
    expect(b.startsWith("<system-reminder>")).toBe(true);
    expect(b).toContain("/neutral/dir");
    expect(b).toContain("unrelated");
  });
  it("the fed text is boundary + spec + trailer, trailer last", () => {
    const t = pooledTaskText(2, "/neutral/dir", "count the files", "TRAILER-TEXT");
    expect(t.startsWith(poolTaskBoundary(2, "/neutral/dir"))).toBe(true);
    expect(t).toContain("count the files");
    expect(t.trimEnd().endsWith("TRAILER-TEXT")).toBe(true);
  });
});

describe("slot picking + reaping", () => {
  // pickSlot probes liveness with kill(pid, 0): our own pid is alive, an
  // impossible pid is not
  const ALIVE = process.pid;
  const DEAD = 999_999_999;
  const rec = (over: Partial<PoolSlotRecord> = {}): PoolSlotRecord => ({
    provider: "glm",
    model: "m1",
    cwd: "/neutral",
    pid: ALIVE,
    claudeSession: "s",
    spawnedAt: "2026-10-16 22:00:00",
    lastUsedAt: "2026-10-16 22:00:00",
    tasks: 0,
    busyWith: null,
    ...over,
  });
  const NOW = Date.parse("2026-10-16T22:30:00Z");
  const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString();
  const KEY = slotKey("glm", "m1", "/neutral");

  it("reuses the idle slot matching provider+model+cwd", () => {
    const slots = [rec({ lastUsedAt: iso(1) })];
    const { slot, canSpawn } = pickSlot(slots, KEY, 3, NOW, 900);
    expect(slot?.pid).toBe(ALIVE);
    expect(canSpawn).toBe(false);
  });

  it("a busy slot is not handed out, but the pool may still grow under the cap", () => {
    const { slot, canSpawn } = pickSlot([rec({ busyWith: "w1" })], KEY, 3, NOW, 900);
    expect(slot).toBeNull();
    expect(canSpawn).toBe(true);
  });

  it("a fully busy pool at capacity refuses (client falls back to a fresh spawn)", () => {
    const { evict, canSpawn } = pickSlot([rec({ busyWith: "w1" })], KEY, 1, NOW, 900);
    expect(evict).toBeNull();
    expect(canSpawn).toBe(false);
  });

  it("at capacity the longest-idle idle slot is evicted to make room", () => {
    const busy = rec({ provider: "kimi", busyWith: "w2" });
    const old = rec({ provider: "kimi", lastUsedAt: iso(10) });
    const recent = rec({ provider: "kimi", lastUsedAt: iso(1), pid: ALIVE });
    const { evict, canSpawn } = pickSlot([busy, old, recent], KEY, 2, NOW, 900);
    expect(evict?.lastUsedAt).toBe(iso(10));
    expect(canSpawn).toBe(true);
  });

  it("slots whose process is gone do not count", () => {
    const { canSpawn } = pickSlot([rec({ pid: DEAD, busyWith: "w1" })], KEY, 1, NOW, 900);
    expect(canSpawn).toBe(true);
    expect(pickSlot([rec({ pid: DEAD })], KEY, 3, NOW, 900).slot).toBeNull();
  });

  it("idle kill after idleSecs; busy slots are never reaped; 0 = never", () => {
    expect(slotShouldReap(rec({ lastUsedAt: iso(16) }), NOW, 900)).toBe(true);
    expect(slotShouldReap(rec({ lastUsedAt: iso(5) }), NOW, 900)).toBe(false);
    expect(slotShouldReap(rec({ lastUsedAt: iso(16), busyWith: "w9" }), NOW, 900)).toBe(false);
    expect(slotShouldReap(rec({ lastUsedAt: iso(16) }), NOW, 0)).toBe(false);
    expect(slotIdleFor(rec({ lastUsedAt: iso(2) }), NOW)).toBe(120);
  });
});

describe("state + metrics on disk", () => {
  it("state write/read round-trip", () => {
    const dir = newLogDir();
    writePoolState(
      {
        hostPid: 123,
        port: 8798,
        startedAt: "2026-10-16 22:00:00",
        updatedAt: "2026-10-16 22:00:00",
        slots: [],
        tasksServed: 0,
        tokensCarried: 0,
      },
      poolStatePath(dir)
    );
    expect(readPoolState(dir)?.hostPid).toBe(123);
    expect(existsSync(poolDir(dir))).toBe(true);
    expect(readPoolState(newLogDir())).toBeNull();
  });

  it("metrics append/read skips torn lines; carry math counts first requests", () => {
    const dir = newLogDir();
    const file = poolMetricsPath(dir);
    const row: PoolMetricRow = {
      ts: "2026-10-16T22:00:00Z",
      id: "w1",
      provider: "glm",
      model: "m1",
      task: 1,
      slotSession: "s",
      input_tokens: 1000,
      output_tokens: 10,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 8000,
    };
    appendPoolMetric(row, file);
    appendPoolMetric({ ...row, id: "w2", cache_read_input_tokens: 0 }, file);
    appendFileSync(file, "{torn json\n", "utf8");
    const rows = readPoolMetrics(file);
    expect(rows.map((r) => r.id)).toEqual(["w1", "w2"]);
    const carry = poolCarry(rows);
    expect(carry.tasks).toBe(2);
    expect(carry.tokensCarried).toBe(8000);
    expect(carry.hitRatio).toBeCloseTo(8000 / 10_400, 5); // w2 read nothing but still counts in the denominator
    expect(poolCarry([])).toEqual({ tasks: 0, tokensCarried: 0, hitRatio: 0 });
  });

  it("carriedShare: first-request read share, null without usage", () => {
    expect(carriedShare(undefined)).toBeNull();
    expect(carriedShare({})).toBeNull();
    expect(carriedShare({ input_tokens: 1000, cache_read_input_tokens: 4000 })).toBeCloseTo(0.8, 5);
  });
});

describe("client transport", () => {
  it("health probe and task post against a loopback stub", async () => {
    let body = "";
    const server: Server = createServer((req, res) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c));
      req.on("end", () => {
        if (req.url === "/healthz") {
          res.writeHead(200);
          res.end("ok");
          return;
        }
        body = data;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ pooled: true, rc: 0, resultEvent: { type: "result", result: "ok" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await poolHostAlive(port)).toBe(true);
      const resp = await postTaskToPool(port, task(), 5000);
      expect(resp?.pooled).toBe(true);
      expect(resp?.rc).toBe(0);
      expect(JSON.parse(body).id).toBe("w-pool-1");
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a malformed reply resolves null, not a throw", async () => {
    const server: Server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json at all");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await postTaskToPool(port, task(), 5000)).toBeNull();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("an unreachable host resolves null so the caller spawns fresh", async () => {
    expect(await postTaskToPool(1, task(), 400)).toBeNull();
    expect(await poolHostAlive(1, 200)).toBe(false);
  });

  function task(): import("./pool.js").PoolTaskRequest {
    return {
      id: "w-pool-1",
      label: "test task",
      prompt: "say hi",
      provider: "glm",
      model: "m1",
      reportFormat: "ag2",
      outputFormat: "text",
      maxMinutes: null,
      trailer: "",
    };
  }
});
