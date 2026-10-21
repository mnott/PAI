import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { handleCockpit } from "./cockpit.js";
import { COCKPIT_HTML } from "./cockpit-page.js";
import { buildPoolPanel, type PoolPanelInput } from "./pool-panel.js";
import { parseLedger } from "../workers/ledger.js";

const NOW = new Date("2026-10-17T12:00:00").getTime();

const ledger = (lines: string[]) => parseLedger(lines.join("\n"));

const input = (over: Partial<PoolPanelInput> = {}): PoolPanelInput => ({
  enabled: true,
  hostUp: true,
  port: 8798,
  maxSlots: 3,
  idleSecs: 1800,
  state: {
    hostPid: 1,
    port: 8798,
    startedAt: "2026-10-17 07:35:52",
    updatedAt: "2026-10-17 11:59:00",
    tasksServed: 3,
    tokensCarried: 30000,
    slots: [
      {
        provider: "local30x8",
        model: "qwen3-coder-30b-8bit",
        cwd: "/repo/a",
        pid: 2,
        claudeSession: "s1",
        spawnedAt: "2026-10-17 11:00:00",
        lastUsedAt: "2026-10-17 11:58:00",
        tasks: 2,
        busyWith: null,
      },
      {
        provider: "glm",
        model: "glm-5.3",
        cwd: "/repo/b",
        pid: 3,
        claudeSession: "s2",
        spawnedAt: "2026-10-17 11:30:00",
        lastUsedAt: "2026-10-17 11:59:30",
        tasks: 1,
        busyWith: "w9",
      },
    ],
  },
  metrics: [
    { ts: "t", id: "a", provider: "local30x8", model: "m", task: 1, slotSession: "s1", input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 10000 },
    { ts: "t", id: "b", provider: "local30x8", model: "m", task: 2, slotSession: "s1", input_tokens: 5000, output_tokens: 1, cache_creation_input_tokens: 5000, cache_read_input_tokens: 10000 },
    { ts: "t", id: "c", provider: "glm", model: "m", task: 1, slotSession: "s2", input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 10000 },
  ],
  ledger: ledger([
    "2026-10-17 10:00:00 WORKER-START id=a provider=glm mode=pooled",
    "2026-10-17 10:05:00 WORKER-START id=b provider=glm mode=headless",
    "2026-10-17 10:06:00 WORKER-POOL-SKIP id=b provider=glm reason=worktree",
    "2026-10-17 10:07:00 WORKER-START id=c provider=glm mode=headless",
    "2026-10-17 10:08:00 WORKER-POOL-SKIP id=c provider=glm reason=worktree",
    "2026-10-17 10:09:00 WORKER-START id=d provider=anthropic mode=headless",
    "2026-10-17 10:10:00 WORKER-POOL-SKIP id=d provider=anthropic reason=native-provider",
    "2026-10-17 11:00:00 WORKER-START id=e provider=glm mode=headless",
    "2026-10-15 10:00:00 WORKER-START id=old provider=glm mode=headless",
    "2026-10-15 10:00:01 WORKER-POOL-SKIP id=old provider=glm reason=mcp",
  ]),
  nowMs: NOW,
  ...over,
});

describe("buildPoolPanel", () => {
  it("shows slots with state, age, tasks and per-slot carry", () => {
    const p = buildPoolPanel(input());
    expect(p.slots.map((s) => [s.provider, s.state, s.tasks])).toEqual([
      ["local30x8", "idle", 2],
      ["glm", "busy", 1],
    ]);
    expect(p.slots[0]!.ageSecs).toBe(3600);
    expect(p.slots[0]!.idleSecs).toBe(120);
    expect(p.slots[0]!.tokensCarried).toBe(20000);
    expect(p.slots[0]!.hitRatio).toBeCloseTo(20000 / 30000);
    expect(p.slots[1]!.tokensCarried).toBe(10000);
    expect(p.totals.tokensCarried).toBe(30000);
    expect(p.totals.carriedTasks).toBe(3);
    expect(p.totals.hitRatio).toBeCloseTo(30000 / 40000);
  });

  it("counts 24 h runs, pooled ones and rejection reasons (older rows excluded)", () => {
    const p = buildPoolPanel(input());
    expect(p.last24h.runs).toBe(5);
    expect(p.last24h.pooled).toBe(1);
    expect(p.last24h.notPooled).toBe(4);
    expect(p.last24h.reasons).toEqual([
      { reason: "worktree", runs: 2 },
      { reason: "native-provider", runs: 1 },
    ]);
    expect(p.last24h.topReason).toBe("worktree");
    expect(p.last24h.unattributed).toBe(1);
  });

  it("says plainly when the pool is off, down, or never used, and names the reason", () => {
    // provider-neutral: the pool pre-starts spares for every provider, so no message names claude
    const off = buildPoolPanel(input({ enabled: false }));
    expect(off.message).toMatch(/OFF/);
    expect(off.message).toContain("config disabled");
    expect(off.message).not.toMatch(/claude/i);
    const down = buildPoolPanel(input({ hostUp: false }));
    expect(down.message).toMatch(/DOWN/);
    expect(down.message).toContain("host down");
    expect(down.message).not.toMatch(/claude/i);
    const idle = buildPoolPanel(input({ state: null, metrics: [], ledger: [] }));
    expect(idle.message).toMatch(/not served a task/);
    expect(idle.slots).toEqual([]);
    expect(idle.totals.hitRatio).toBeNull();
    expect(idle.last24h.topReason).toBeNull();
  });

  it("counts ready spares per provider and spare misses by reason from the host state", () => {
    const p = buildPoolPanel(
      input({
        state: {
          hostPid: 1,
          port: 8798,
          startedAt: "2026-10-17 07:35:52",
          updatedAt: "2026-10-17 11:59:00",
          tasksServed: 3,
          tokensCarried: 30000,
          slots: [],
          spares: [
            { id: "sp1", repo: "/repo", provider: "anthropic", model: "m", dir: "/wt/1", branch: "b1", base: "h", pid: 4, createdAt: "x", state: "ready" },
            { id: "sp2", repo: "/repo", provider: "anthropic", model: "m", dir: "/wt/2", branch: "b2", base: "h", pid: 5, createdAt: "x", state: "ready" },
            { id: "sp3", repo: "/repo", provider: "glm", model: "g", dir: "/wt/3", branch: "b3", base: "h", pid: 6, createdAt: "x", state: "starting" },
          ],
          spareClaims: 2,
          spareMisses: { "pane rule: a pane owns every run": 3, "no-spare": 1 },
        },
      })
    );
    expect(p.spares).toEqual([
      { provider: "anthropic", ready: 2, starting: 0 },
      { provider: "glm", ready: 0, starting: 1 },
    ]);
    expect(p.spareClaims).toBe(2);
    expect(p.spareMisses).toEqual([
      { reason: "pane rule: a pane owns every run", misses: 3 },
      { reason: "no-spare", misses: 1 },
    ]);
    // no spares in the state file (older hosts): empty, not invented
    expect(buildPoolPanel(input()).spares).toEqual([]);
    expect(buildPoolPanel(input()).spareMisses).toEqual([]);
  });
});

describe("cockpit pool wiring", () => {
  it("serves /cockpit/pool and the page carries the Worker pool section", async () => {
    const panel = buildPoolPanel(input());
    const limits = { get: async () => [] };
    const srv = http.createServer((req, res) => {
      if (!handleCockpit(req, res, limits, () => [], () => new Map(), undefined, () => [], () => null, async () => panel)) res.end("other");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const body = await new Promise<string>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/cockpit/pool" }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(b));
      });
    });
    srv.close();
    expect(JSON.parse(body).last24h.topReason).toBe("worktree");
    expect(COCKPIT_HTML).toContain("Worker pool");
    expect(COCKPIT_HTML).toContain("loadPool()");
  });
});
