const MODELS = ["claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5-5", "glm-5.3-flash", "qwen3.8-flash-next-gyro-m"];
const bucket = (n: number, hit: number) => ({ label: "x", n, hit });
const stat = (r: number, t: number | null) => ({ requests: r, ttftP50: t, ttftP90: t == null ? null : t * 2.4, readTps: t == null ? null : 1234.5, writeTps: t == null ? null : 41.2 });

export function fixtureData() {
  const long = "worktree-20261021-015130-55831-phone-fit-check-for-the-cockpit-sessions-table";
  const sessions = Array.from({ length: 24 }, (_, i) => ({
    session: `2026102${i % 3}-0${i}1530-5583${i}`,
    name: i < 6 ? (i === 0 ? long : `PAI session ${i}`) : "",
    models: i < 3 ? [MODELS[0], MODELS[1], MODELS[3]] : [MODELS[3]],
    requests: 900 - i * 35, input: 2_000_000 - i * 70_000, cacheWrite: 300_000, cacheRead: 40_000_000 - i * 1_500_000, output: 120_000,
    hitRatio: 0.93, busts: i % 4, errors: i % 5, lastTs: new Date(Date.now() - i * 600_000).toISOString(),
    worker: i === 2 ? "20261021-063345-95575" : undefined, verdict: i === 2 ? "report flagged" : undefined,
  }));
  const workers = ["run.ts split step 1: provider test moved out of the router file", "cockpit tables: sessions, runs, speed and providers read at any width", "fix(cockpit): workers section empty markup counts as empty", "docs: cockpit chart resize keys and screenshots without empty columns", "", "x"].map((name, i) => ({
    worker: `20261021-0${i}3345-9557${i}`, name, workerProvider: i % 2 ? "anthropic" : "glm", requests: 40 + i, input: 800_000, cacheWrite: 0, cacheRead: 5_000_000, output: 20_000,
    verdict: ["ok", "ok", "failed: exit 1", "report flagged", "escalated to session", "handed to session"][i],
  }));
  return {
    window: "1h", totals: { requests: 5000, input: 9e6, output: 4e5, cacheWrite: 1e6, cacheRead: 9e7, errors: 12, hitRatio: 0.9 },
    byModel: MODELS.map((m, i) => ({ provider: i < 3 ? "anthropic" : "glm", model: m, requests: 1000 + i, input: 1e6, cacheWrite: 1e5, cacheRead: 1e7, output: 1e5 })),
    series: [], weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
    cachePause: MODELS.slice(0, 3).map((m) => ({ model: "anthropic/" + m + "-with-a-long-suffix-20261021", buckets: ["<5m", "5-30m", "30m-1h", "1-3h", ">3h"].map((l, j) => ({ ...bucket(40 + j, 30), label: l })) })),
    byProvider: [{ provider: "anthropic", requests: 3000, errors: 4, retries: 6, avgMs: 4100, ttftP50: 900, input: 1e6, output: 1e5, cacheWrite: 1e5, cacheRead: 1e7, hitRatio: 0.94 }, { provider: "glm", requests: 1900, errors: 8, retries: 0, avgMs: 2100, ttftP50: 700, input: 1e6, output: 1e5, cacheWrite: 0, cacheRead: 0, hitRatio: 0 }, { provider: "gyro-m", requests: 100, errors: 0, retries: 0, avgMs: 8100, ttftP50: 2500, input: 1e6, output: 1e5, cacheWrite: 0, cacheRead: 0, hitRatio: 0 }],
    bustParts: { tools: 3, system: 1 }, bySession: sessions, workers, daily: { models: {}, days: [] }, sessionSplit: null,
    speed: MODELS.map((m, i) => ({ provider: i < 3 ? "anthropic" : "glm", model: m, h1: stat(30 + i, 900 + i), h24: stat(400 + i, i === 2 ? null : 1100) })),
    promptByProvider: {}, promptSince: {},
  };
}
export const fixtureSystem = () => ({ current: {}, series: { series: [] }, servers: [{ provider: "gyro-m", up: true, rssMb: 36148, speed: { prefillTps: 245, decodeTps: 58.5, prefillN: 3, decodeN: 2, window: "1h", source: "measured", text: "t", tip: "how" }, prefixCache: { hitRate: 0.91, hits: 910, misses: 90, tokensSaved: 1e6, entries: 4, memoryMb: 2048 } }, { provider: "ollama-local-with-a-long-name", up: true, rssMb: 5100, speed: { prefillTps: 120, decodeTps: 31.2, prefillN: 3, decodeN: 2, window: "1h", source: "measured", text: "t", tip: "how" }, prefixCache: null }] });
export const fixtureQueue = () => ({ providers: [{ provider: "glm", cap: 2, running: [{ id: "w-20261021-063345", label: "run.ts split step 1: provider test moved out of the router file", ageSec: 120, now: "editing script-tables.ts", session: "PAI", model: "glm-5.3" }], waiting: [{ id: "w-2", label: "fix cockpit tables at any width", waitedSec: 30, position: 1, session: "PAI", model: "glm-5.3" }] }], panes: [], paneViolations: [], plans: [], build: { running: [], waiting: [] } });
/** Three cloud providers: at 822 px the old auto-fill grid put the third tile alone on a half-width row. */
export const fixtureLimits = () => ({
  activeLocal: null,
  limits: ["anthropic", "glm", "gyro-m"].map((provider) => ({ provider, kind: "cloud", windows: [{ name: "5h", percent: 30, resetAt: Date.now() + 3600_000 }] })),
});

export function fixturePool() {
  return {
    enabled: true, hostUp: true, port: 8798, maxSlots: 3, idleKillSecs: 1800,
    hostSince: "2026-10-21 09:10:00", hostLastSeen: "2026-10-21 09:23:00", hostBuiltAt: "2026-10-21 09:00:00", hostStale: false,
    slots: [], totals: { tasksServed: 1, tokensCarried: 1_200_000, hitRatio: 0.272, carriedTasks: 128 },
    last24h: { runs: 262, pooled: 2, notPooled: 260, reasons: [{ reason: "tools", runs: 120 }], topReason: "tools", unattributed: 4, poolOff: 100 },
    spares: [{ provider: "anthropic", ready: 2, starting: 0 }], spareClaims: 2, spareMisses: [],
    offReason: null, message: "up",
  };
}

/** fixturePool with one slot: the slots card draws a table (an empty pool draws only its note and is fitted to it). */
export function fixturePoolWithSlot() {
  return {
    ...fixturePool(),
    slots: [{ provider: "anthropic", model: "opus", cwd: "/work/dev/app", state: "idle", task: null, branch: null, firstRequest: "warm", ageSecs: 600, idleSecs: 60, tasks: 1, tokensCarried: 1_200_000, hitRatio: 0.27 }],
  };
}
