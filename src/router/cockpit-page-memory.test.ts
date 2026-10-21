/** The real page (shell + every script) in Chromium: the Memory card exists, fills from a stubbed
 *  /cockpit/memory, and survives a layout saved before the section existed. */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const OLD_LAYOUT = [["cloud"], ["system"], ["models"], ["workers"], ["pool"], ["kpis"], ["cache"], ["tokens"], ["speed"], ["pause"], ["sessions"], ["daily"], ["runs"], ["routing"]];
const NOW = Date.now();
const MEMORY = {
  at: NOW, daemon: true, level: "amber", reason: "re-embed neutral-b-reembed running", title: "Memory", stallSecs: 300,
  counts: { files: 500, chunks: 2_000_000, embedded: 1_877_697, backlog: 122_303, coverage: 0.9388, coverageLevel: "amber", exact: false },
  segments: { fresh: 111_111, old: 1_766_586, missing: 122_303 }, reembedding: true,
  binding: { mismatch: true, hint: "re-embed to neutral-b in progress", error: null, bound: { backend: "neutral-a", model: "model-a" }, configured: { backend: "neutral-b", model: "model-b", dims: 8 } },
  backend: { id: "neutral-b", model: "model-b", dims: 8, available: true, reason: "ready", loaded: [], loadedModel: "model-b:1", gpuShare: 0.75, alsoLoaded: ["neutral-chat:9b"] },
  daemonInfo: { pid: 4321, uptimeSecs: 7300, version: "1.2.3", storage: "neutral-store" },
  jobs: [
    { id: "job-neutral-b-reembed", kind: "reembed", name: "neutral-b-reembed", phase: "embed", done: 111_111, total: 1_000_000, pct: 11.1, rate: 12.5, etaSec: 5000, doneAt: NOW + 5_000_000, lastProgressAt: NOW - 400_000, stalled: true, series: [1, 5, 9, 12, 12.5], by: null },
    { id: "run-embed", kind: "embed", name: "embed run", phase: "embed", done: 50, total: 100, pct: 50, rate: 2, etaSec: 25, doneAt: NOW + 25_000, lastProgressAt: NOW - 1000, stalled: false, series: [2, 2, 2], by: "cockpit" },
  ],
  passes: [
    { name: "index", state: "ok", lastEnd: NOW - 3_600_000, nextAt: NOW + 3_600_000, failure: null, detail: null },
    { name: "embed", state: "failed", lastEnd: NOW - 7_200_000, nextAt: NOW + 7_200_000, failure: { at: NOW, error: "neutral failure", attempts: 1, gaveUp: false, retryAt: NOW + 600_000 }, detail: { embedded: 321, backlogLeft: 55, stopReason: "pass-budget", note: null, at: NOW - 7_200_000 } },
  ],
  lastIndex: { at: NOW - 3_600_000, durationSec: 95, files: 40, chunks: 300 }, lastEmbed: null,
  schedule: { maintenanceHour: 3, indexIntervalSecs: 86400, embedIntervalSecs: 86400 },
  run: { kind: "embed", by: "cockpit", pid: 1, jobId: "", startedAt: new Date(NOW - 5000).toISOString(), elapsedSec: 5, done: 50, backlogStart: 100, rate: 2, etaSec: 25, tail: "", stoppable: true },
  starting: null, lastRun: null,
};
// the finished-run tile and the merged last pass the operator did not see before
MEMORY.jobs.push({ id: "last-index", kind: "index", name: "index run", phase: "failed", done: 12, total: null, pct: null, rate: 0.5, etaSec: null, doneAt: null, lastProgressAt: NOW - 60_000, stalled: false, series: [], by: "cli", finished: { outcome: "failed", reason: "neutral reason", endedAt: NOW - 60_000, durationSec: 24 } } as never);
(MEMORY.passes[1] as Record<string, unknown>).last = { at: NOW - 120_000, chunks: 4321, result: "done", by: "cockpit" };

let server: Server;
let base = "";
let tmp = "";
const browsers = new Set<ChildProcess>();

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-mem-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/page")) {
      // seed the browser's storage before the page script runs
      const seed = `<script>try{localStorage.setItem("pai.cockpit.layout.v1",${JSON.stringify(JSON.stringify(OLD_LAYOUT))})}catch(e){}</script>`;
      const probe = `<script>setTimeout(function(){var s=document.getElementById("sec-memory");document.body.setAttribute("data-probe",JSON.stringify({sec:!!s,panel:s?s.textContent:"",tiles:s?Array.prototype.map.call(s.querySelectorAll(".mt"),function(t){return t.getAttribute("data-tid")}):[],rings:s?s.querySelectorAll(".mt svg circle").length:0,gauges:s?s.querySelectorAll(".mt-bar").length:0,sparks:s?s.querySelectorAll(".mt-spark").length:0,grips:s?s.querySelectorAll(".mt [data-tgrip]").length:0,mins:s?s.querySelectorAll(".mt .tctl").length:0,segs:s?s.querySelectorAll("[data-part=segments] i").length:0,stalled:s?s.querySelectorAll("[data-part=stalled]").length:0,pill:document.getElementById("memrun").textContent,title:s?s.querySelector("h2").textContent:"",tileStop:s?s.querySelectorAll(".mt [data-a='memory.stop']").length:0,embedDis:s?s.querySelectorAll(".act button")[0].disabled:null,firstTile:s?s.querySelector(".mt").getAttribute("data-tid"):"",layout:localStorage.getItem("pai.cockpit.layout.v1")}))},1500)</script>`;
      res.setHeader("content-type", "text/html");
      return res.end(cockpitHtml().replace("<body>", "<body>" + seed).replace("</body>", probe + "</body>"));
    }
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/cockpit/memory")) return res.end(JSON.stringify(MEMORY));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { for (const c of browsers) c.kill("SIGKILL"); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function dump(url: string): Promise<string> {
  const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", `--user-data-dir=${join(tmp, "p")}`, "--window-size=1000,1200", "--virtual-time-budget=5000", "--dump-dom", url];
  return new Promise((resolve, reject) => {
    const c = execFile(CHROME!, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 }, (err, stdout) => { browsers.delete(c); err ? reject(err) : resolve(stdout); });
    browsers.add(c);
  });
}

describe.skipIf(!CHROME)("cockpit Memory card in the real page", () => {
  it("an older saved layout without memory still shows the card, filled from /cockpit/memory, and the layout is updated", async () => {
    const dom = await dump(`${base}/page`);
    const m = /data-probe="([^"]*)"/.exec(dom);
    expect(m, "probe result in the dump").not.toBeNull();
    const p = JSON.parse(m![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    expect(p.sec, "section with id sec-memory").toBe(true);
    const t: string = p.panel;
    // index tile: coverage, estimate marker, files, split legend, bound vs configured, hint
    for (const x of ["93.9", "embedded of 2.00M chunks (est.)", "500", "new backend", "old backend, still to replace", "missing", "122303", "bound to neutral-a / model-a", "configured neutral-b / model-b", "re-embed to neutral-b in progress"]) expect(t, x).toContain(x);
    expect(p.segs).toBe(3);
    // backend tile: id, availability, loaded model, GPU share gauge
    for (const x of ["neutral-b", "available", "model-b:1", "GPU share 75%"]) expect(t, x).toContain(x);
    // job tiles: ring %, rate, done/total, ETA, done-about, phase, stalled
    for (const x of ["11.1", "12.5 chunks/s", "111.1k / 1.00M done", "ETA", "done about", "last progress", "STALLED"]) expect(t, x).toContain(x);
    expect(p.stalled).toBe(1);
    // passes tile
    for (const x of ["index", "embed", "failed", "next", "neutral failure", "retry at", "embedded 321", "55 left", "pass-budget", "40 files"]) expect(t, x).toContain(x);
    // daemon tile
    for (const x of ["pid 4321", "v1.2.3", "storage neutral-store"]) expect(t, x).toContain(x);
    // header pill + actions
    expect(t).toContain("attention");
    expect(t).toContain("embed backlog");
    expect(t).toContain("stop");
    // nested-tile mechanism: ids, grips, minimize buttons, rings, sparklines
    expect(p.tiles).toEqual(expect.arrayContaining(["index", "backend", "re-embed-neutral-b-reembed", "embed-run", "passes", "daemon"]));
    expect(p.grips).toBe(p.tiles.length);
    expect(p.mins).toBe(p.tiles.length);
    expect(p.rings).toBeGreaterThanOrEqual(4);
    expect(p.sparks).toBe(p.tiles.length);
    expect(JSON.parse(p.layout).flat()).toContain("memory");
    // fault 1-3: the embed model's own loaded line, the muted others, the merged last pass, the kept finished run
    for (const x of ["also loaded: neutral-chat:9b", "4.3k chunks · done · by cockpit", "Last index run", "failed · neutral reason", "12 done", "by cli"]) expect(t, x).toContain(x);
    // running state: pill in the title row, first tile is the stoppable run tile, buttons busy
    expect(p.pill).toMatch(/embedding 50% · 2\/s · ETA 25 s/);
    expect(p.title).toContain("embedding 50%");
    expect(p.tileStop).toBeGreaterThanOrEqual(1);
    expect(p.embedDis).toBe(true);
  }, 120_000);
});
