// scratch-cockpit.ts — synthetic cockpit on :8791 for the layout proof. Untracked, never committed.
import http from "node:http";
import fs from "node:fs";
import { handleCockpit } from "./src/router/cockpit.js";
import { LimitsCache } from "./src/router/limits.js";
import type { UsageRow } from "./src/router/usage.js";
import type { SystemMonitor, SystemSnapshot, SystemWindow } from "./src/router/system.js";

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** model count knob: echo 3 > /tmp/cockpit-models.txt, page picks it up on next poll */
function gen(): UsageRow[] {
  const want = fs.existsSync("/tmp/cockpit-models.txt") ? fs.readFileSync("/tmp/cockpit-models.txt", "utf8").trim() : "1";
  const n = Math.min(4, Math.max(1, parseInt(want, 10) || 1));
  const models = ["glm-4.7", "kimi-k2-thinking", "qwen3.8-27b", "claude-sonnet-5-5"].slice(0, n);
  const rows: UsageRow[] = [];
  const now = Date.now();
  models.forEach((model, mi) => {
    const sessions = [`s${mi + 1}-a`, `s${mi + 1}-b`];
    for (let i = 0; i < 26; i++) {
      const minsAgo = 55 - i * 2.1 - rnd(0, 1.5);
      const expired = i % 9 === 4; // pause 5-60m: cache went cold between turns
      const first = i % 13 === 0;
      const read = first || expired ? 0 : Math.round(rnd(9000, 52000));
      const write = first || expired ? Math.round(rnd(1200, 2600)) : Math.round(rnd(0, 300));
      rows.push({
        ts: new Date(now - minsAgo * 60_000).toISOString(),
        model,
        provider: i % 9 === 0 ? "glm-mirror" : "glm",
        status: i === 17 ? 429 : 200,
        ms: Math.round(rnd(900, 9000)),
        bytes: 12345,
        cache: first || expired ? "write" : "hit",
        input_tokens: Math.round(rnd(60, 400)),
        output_tokens: Math.round(rnd(250, 1400)),
        cache_creation_input_tokens: write,
        cache_read_input_tokens: read,
        session_id: sessions[i % 2]!,
        gap_s: first ? undefined : expired ? Math.round(rnd(320, 900)) : Math.round(rnd(15, 70)),
        bust: i === 20 && mi === 0 ? ["tools"] : undefined,
        requested_model: model,
        routed_model: model,
      });
    }
  });
  return rows;
}

const sessions = () =>
  new Map([
    ["s0-a", { name: "fix cache expiry", worker: "20261016-170145", verdict: "ok", provider: "glm" }],
    ["s1-a", { name: "cockpit layout rebalance", worker: "20261016-172014", verdict: "ok", provider: "glm" }],
    ["s2-a", { name: "night bench", worker: "20261015-231002", verdict: "failed", provider: "glm" }],
  ]);

const sys = {
  async snapshot(win: SystemWindow): Promise<SystemSnapshot> {
    const now = Date.now();
    const bucket = 300_000;
    const n = Math.ceil(3_600_000 / bucket);
    const series = Array.from({ length: n }, (_, i) => ({
      t: now - (n - 1 - i) * bucket,
      n: 5,
      totalW: +(22 + 8 * Math.sin(i / 2.5) + rnd(0, 3)).toFixed(1),
      gpu: Math.round(18 + 30 * Math.abs(Math.sin(i / 1.7))),
      cpu: Math.round(12 + 20 * Math.abs(Math.cos(i / 2.1))),
    }));
    return {
      current: {
        t: now,
        cpu: 14,
        gpu: 38,
        gpuFreqMhz: 780,
        socTemp: 41.5,
        cpuW: 4.2,
        gpuW: 9.8,
        systemW: 6.1,
        totalW: 29.3,
        memTotal: 34359738368,
        memUsed: 21474836480,
        swapTotal: 4294967296,
        swapUsed: 536870912,
        wired: 8589934592,
        compressed: 2147483648,
        pressureLevel: 62,
        source: "mactop",
        notes: [],
      },
      unavailable: {},
      series: { window: win, bucketMs: bucket, series, wh: { "1h": 24.1, "24h": 512, "7d": 3900 } as never, coveredMin: { "1h": 58, "24h": 1310, "7d": 8100 } as never },
    };
  },
} as unknown as SystemMonitor;

const limits = new LimitsCache({ providers: () => ({}), rows: () => [], advisorFile: "/nonexistent" }, 60_000);
const srv = http.createServer((req, res) => {
  if (!handleCockpit(req, res, limits, gen, sessions, sys)) {
    res.writeHead(404);
    res.end("no route");
  }
});
srv.listen(8791, "127.0.0.1", () => console.log("scratch cockpit: http://127.0.0.1:8791/cockpit"));
