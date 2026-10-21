/** Hold-last-good in the real page (Chromium): a failed fetch or a payload marked `stale` keeps the last good payload on
 *  screen with a "stale" marker; after holdLastGoodSecs the error state shows; a good payload clears the marker, and a
 *  real change in a good payload shows at once. Memory, Workers (queue) and Limits sections, each against a stub. */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const NOW = Date.now();
const memory = (reason: string, extra: Record<string, unknown> = {}) => ({
  at: NOW, daemon: true, level: "green", reason, title: "Memory", stallSecs: 300,
  counts: { files: 5, chunks: 100, embedded: 100, backlog: 0, coverage: 1, coverageLevel: "green", exact: true },
  segments: { fresh: 0, old: 100, missing: 0 }, reembedding: false, binding: null,
  backend: { id: "neutral-b", model: "model-b", dims: 8, available: true, reason: "ready", loaded: [], loadedModel: null, gpuShare: null },
  daemonInfo: { pid: 1, uptimeSecs: 10, version: "1", storage: "s" }, jobs: [], passes: [], lastIndex: null, lastEmbed: null,
  schedule: null, run: null, starting: null, lastRun: null, ...extra,
});
const queue = (text: string, extra: Record<string, unknown> = {}) => ({ providers: [], plans: [], worktrees: text, ...extra });
const limits = (text: string, extra: Record<string, unknown> = {}) => ({ now: NOW, limits: [{ provider: "acme", kind: "plan", windows: [], error: text, fetchedAt: NOW }], routing: null, activeLocal: "", ...extra });

type Step = { status?: number; body?: unknown };
/** Per endpoint a script of responses by request number; the last repeats. */
let script: Record<string, Step[]> = {};
const counts: Record<string, number> = {};
const FAIL: Step = { status: 500, body: { error: "boom" } };

let server: Server;
let base = "";
let tmp = "";
let savedCfg: string | undefined;
const browsers = new Set<ChildProcess>();

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-stale-"));
  savedCfg = process.env.PAI_CONFIG_FILE;
  writeFileSync(join(tmp, "config.yaml"), "router:\n  cockpit:\n    layout:\n      pollMs: 200\n      limitsPollMs: 200\n      memoryPollMs: 200\n      holdLastGoodSecs: 3\n");
  process.env.PAI_CONFIG_FILE = join(tmp, "config.yaml");
  const { cockpitHtml } = await import("./cockpit-page.js");
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    if (url.pathname === "/page") {
      const delay = Number(url.searchParams.get("delay") ?? 1500);
      const probe = `<script>setTimeout(function(){var o={};["memory","workers","cloud"].forEach(function(k){var s=document.querySelector('section[data-section="'+k+'"]');var m=s&&s.querySelector(".stalemark");o[k]={text:s?s.textContent:"",mark:m?m.textContent:"",err:!!(m&&m.className.indexOf("err")>=0)}});document.body.setAttribute("data-probe",JSON.stringify(o))},${delay})</script>`;
      res.setHeader("content-type", "text/html");
      return res.end(cockpitHtml().replace("</body>", probe + "</body>"));
    }
    res.setHeader("content-type", "application/json");
    const steps = script[url.pathname];
    if (!steps) { res.statusCode = 404; return res.end("{}"); }
    const i = (counts[url.pathname] = (counts[url.pathname] ?? 0) + 1) - 1;
    const st = steps[Math.min(i, steps.length - 1)]!;
    res.statusCode = st.status ?? 200;
    res.end(JSON.stringify(st.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  for (const c of browsers) c.kill("SIGKILL");
  server?.close();
  if (savedCfg === undefined) delete process.env.PAI_CONFIG_FILE; else process.env.PAI_CONFIG_FILE = savedCfg;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function dump(url: string): Promise<string> {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", `--user-data-dir=${join(tmp, "p")}`, "--window-size=1000,1200", "--virtual-time-budget=9000", "--dump-dom", url];
  return new Promise((resolve, reject) => {
    const c = execFile(CHROME!, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 }, (err, stdout) => { browsers.delete(c); err ? reject(err) : resolve(stdout); });
    browsers.add(c);
  });
}
type Probe = Record<"memory" | "workers" | "cloud", { text: string; mark: string; err: boolean }>;
async function run(steps: Record<string, Step[]>, delay: number): Promise<Probe> {
  script = steps;
  for (const k of Object.keys(counts)) delete counts[k];
  const dom = await dump(`${base}/page?delay=${delay}`);
  const m = /data-probe="([^"]*)"/.exec(dom);
  expect(m, "probe result in the dump").not.toBeNull();
  return JSON.parse(m![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}
const EP = { memory: "/cockpit/memory", workers: "/cockpit/queue", cloud: "/cockpit/limits" } as const;
const GOOD = { memory: memory("MEM-GOOD"), workers: queue("QUEUE-GOOD"), cloud: limits("LIM-GOOD") };
const CHANGED = { memory: memory("MEM-CHANGED"), workers: queue("QUEUE-CHANGED"), cloud: limits("LIM-CHANGED") };
const WORD = { memory: "MEM-", workers: "QUEUE-", cloud: "LIM-" } as const;
/** The same script for the three endpoints: the first response is the good payload of that section. */
const seq = (f: (k: keyof typeof EP) => Step[]): Record<string, Step[]> => ({
  [EP.memory]: f("memory"), [EP.workers]: f("workers"), [EP.cloud]: f("cloud"),
});
const ok = (b: unknown): Step => ({ body: b });

describe.skipIf(!CHROME)("cockpit hold-last-good in the real page", () => {
  const keys = ["memory", "workers", "cloud"] as const;

  it("a failed fetch keeps the last good payload with a stale marker, within the hold time", async () => {
    const p = await run(seq((k) => [ok(GOOD[k]), FAIL]), 1500);
    for (const k of keys) {
      expect(p[k].text, k).toContain(WORD[k] + "GOOD");
      expect(p[k].mark, k).toMatch(/^stale · \d+ s · http 500/);
      expect(p[k].err, k).toBe(false);
    }
  }, 120_000);

  it("a payload marked stale by the server is held the same way, with the server's reason", async () => {
    const p = await run(seq((k) => [ok(GOOD[k]), ok({ ...CHANGED[k], stale: { since: NOW, reason: "daemon not answering" } })]), 1500);
    for (const k of keys) {
      expect(p[k].text, k).toContain(WORD[k] + "GOOD");
      expect(p[k].text, k).not.toContain(WORD[k] + "CHANGED");
      expect(p[k].mark, k).toContain("daemon not answering");
    }
  }, 120_000);

  it("after the hold time the section shows the error state", async () => {
    const p = await run(seq((k) => [ok(GOOD[k]), FAIL]), 6000);
    for (const k of keys) {
      expect(p[k].mark, k).toMatch(/^error · \d+ s · http 500/);
      expect(p[k].err, k).toBe(true);
    }
    expect(p.memory.text).toContain("memory status unavailable");
    expect(p.workers.text).toContain("queue status unavailable");
  }, 120_000);

  it("a good payload after failures clears the marker at once", async () => {
    const p = await run(seq((k) => [ok(GOOD[k]), FAIL, FAIL, ok(CHANGED[k])]), 3000);
    for (const k of keys) {
      expect(p[k].mark, k).toBe("");
      expect(p[k].text, k).toContain(WORD[k] + "CHANGED");
    }
  }, 120_000);

  it("a real change in a good payload is shown at once, no marker", async () => {
    const p = await run(seq((k) => [ok(GOOD[k]), ok(CHANGED[k])]), 1500);
    for (const k of keys) {
      expect(p[k].text, k).toContain(WORD[k] + "CHANGED");
      expect(p[k].mark, k).toBe("");
    }
  }, 120_000);
});
