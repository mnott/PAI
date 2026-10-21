/** Hold-last-good in the real page (Chromium): a failed fetch or a transient payload keeps the last good one with a
 *  stale marker, the error shows after the hold time, a good payload clears the marker and a real change shows at once. */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const NOW = Date.now();
const memory = (files: number, extra: Record<string, unknown> = {}): unknown => ({
  at: NOW, daemon: true, level: "green", reason: "ok", title: "Memory", stallSecs: 300,
  counts: { files, chunks: 1000, embedded: 1000, backlog: 0, coverage: 1, coverageLevel: "green", exact: true },
  segments: null, reembedding: false, binding: null, backend: null, daemonInfo: null, jobs: [], passes: [], lastIndex: null, lastEmbed: null,
  schedule: null, run: null, starting: null, lastRun: null, ...extra,
});
const queue = (label: string, extra: Record<string, unknown> = {}): unknown => ({ providers: [{ provider: "anthropic", cap: 4, running: [{ id: "w1", label, model: "m", session: "s", ageSec: 5, now: "" }], waiting: [] }], plans: [], ...extra });
const limits = (extra: Record<string, unknown> = {}): unknown => ({ now: NOW, limits: [], routing: null, activeLocal: null, ...extra });

type Step = "good" | "fail" | "transient" | "change";
let seq: Record<string, Step[]> = {};
const counts: Record<string, number> = {};
let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();

function answer(ep: string): { status: number; body: unknown } {
  const n = counts[ep] ?? 0;
  counts[ep] = n + 1;
  const list = seq[ep] ?? ["good"];
  const step = list[Math.min(n, list.length - 1)]!;
  if (step === "fail") return { status: 500, body: { error: "boom" } };
  const t = step === "transient" ? { transient: "daemon not answering" } : {};
  const c = step === "change";
  if (ep === "memory") return { status: 200, body: memory(c ? 888 : 500, t) };
  if (ep === "queue") return { status: 200, body: queue(c ? "model-changed" : "model-first", t) };
  return { status: 200, body: limits(t) };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-hold-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/page")) {
      const skew = /skew=(\d+)/.exec(url)?.[1] ?? "0";
      const seed = `<script>var __n=Date.now,__s=0;Date.now=function(){return __n()+__s};setTimeout(function(){__s=${skew}},12000)</script>`;
      const probe = `<script>setTimeout(function(){function mk(n,f){var s=document.querySelector('[data-section="'+n+'"]');return Array.prototype.map.call(s?s.querySelectorAll("h2 .stalemark[data-stale="+f+"]"):[],function(m){return m.textContent+"|"+m.className}).join(";")}document.body.setAttribute("data-probe",JSON.stringify({mem:document.getElementById("memorypanel").textContent,que:document.getElementById("queuepanel").textContent,mMark:mk("memory","memory"),qMark:mk("workers","queue"),lMark:mk("cloud","limits")}))},32000)</script>`;
      res.setHeader("content-type", "text/html");
      return res.end(cockpitHtml().replace("<body>", "<body>" + seed).replace("</body>", probe + "</body>"));
    }
    const m = /^\/cockpit\/(memory|queue|limits)/.exec(url);
    if (m) {
      const a = answer(m[1]!);
      res.statusCode = a.status;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(a.body));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { for (const c of browsers) c.kill("SIGKILL"); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function dump(url: string): Promise<string> {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", `--user-data-dir=${join(tmp, "p")}`, "--window-size=1000,1200", "--virtual-time-budget=40000", "--dump-dom", url];
  return new Promise((resolve, reject) => {
    const c = execFile(CHROME!, args, { encoding: "utf8", timeout: 100_000, maxBuffer: 64 << 20 }, (err, stdout) => { browsers.delete(c); err ? reject(err) : resolve(stdout); });
    browsers.add(c);
  });
}

async function run(s: Record<string, Step[]>, skew = 0): Promise<{ mem: string; que: string; mMark: string; qMark: string; lMark: string }> {
  seq = s;
  for (const k of Object.keys(counts)) delete counts[k];
  const dom = await dump(`${base}/page?skew=${skew}`);
  const m = /data-probe="([^"]*)"/.exec(dom);
  expect(m, "probe result in the dump").not.toBeNull();
  return JSON.parse(m![1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
}

describe.skipIf(!CHROME)("hold-last-good in the real page", () => {
  it("a failed fetch or a transient payload keeps the last good one with a stale marker (Memory, Workers, Cloud)", async () => {
    const p = await run({ memory: ["good", "fail"], queue: ["good", "transient"], limits: ["good", "fail"] });
    expect(p.mem).toContain("500");
    expect(p.mem).not.toContain("unavailable");
    expect(p.mMark).toMatch(/^stale · \d+ s · HTTP 500\|stalemark$/);
    expect(p.que).toContain("model-first");
    expect(p.qMark).toMatch(/^stale · \d+ s · daemon not answering\|stalemark$/);
    expect(p.lMark).toMatch(/^stale · \d+ s · HTTP 500\|stalemark$/);
  }, 120_000);

  it("past the hold time the section shows the error", async () => {
    const p = await run({ memory: ["good", "fail"], queue: ["good", "fail"], limits: ["good", "fail"] }, 200_000);
    expect(p.mem).toContain("memory status unavailable");
    expect(p.mMark).toMatch(/^unavailable · .* · HTTP 500\|stalemark err$/);
    expect(p.que).toContain("queue status unavailable");
    expect(p.lMark).toContain("stalemark err");
  }, 120_000);

  it("a good payload clears the marker and a real change shows at once", async () => {
    const p = await run({ memory: ["good", "fail", "change"], queue: ["good", "transient", "change"] });
    expect(p.mem).toContain("888");
    expect(p.mMark).toBe("");
    expect(p.que).toContain("model-changed");
    expect(p.qMark).toBe("");
  }, 120_000);

  it("a real change in a good payload replaces the view without any marker", async () => {
    const p = await run({ memory: ["good", "change"], queue: ["good", "change"] });
    expect(p.mem).toContain("888");
    expect(p.que).toContain("model-changed");
    expect(p.mMark + p.qMark).toBe("");
  }, 120_000);
});
