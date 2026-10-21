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
const MEMORY = {
  daemon: true, level: "green", reason: "all systems healthy", title: "Memory",
  counts: { files: 500, chunks: 2_000_000, embedded: 1_877_697, backlog: 122_303, coverage: 0.9388, coverageLevel: "amber", exact: true },
  backend: { id: "ollama-f16", model: "arctic", dims: 768, available: true, level: "green", reason: "ready" },
  run: null, jobs: [], passes: [],
};

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
      const probe = `<script>setTimeout(function(){var s=document.getElementById("sec-memory");document.body.setAttribute("data-probe",JSON.stringify({sec:!!s,panel:s?s.textContent:"",layout:localStorage.getItem("pai.cockpit.layout.v1")}))},1500)</script>`;
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
    expect(p.panel).toContain("122303");
    expect(JSON.parse(p.layout).flat()).toContain("memory");
  }, 120_000);
});
