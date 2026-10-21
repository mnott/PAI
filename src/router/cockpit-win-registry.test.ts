/**
 * B8b-client: the registry editor cards (win/cards-registry.ts). The logic runs in node against a fake fetch over an
 * in-memory registry (never the real workers.yaml): Save disabled until Validate passed on exactly this text, results
 * in the status slot, restore needs a second click, duplicate inserts and validates. A headless Chromium test (skipped
 * when none is installed) renders the `settings` group of the real page against a fake server.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { WIN_REGISTRY_JS } from "./cockpit-page/win/cards-registry.js";

type Io = { get: (u: string) => Promise<any>; post: (u: string, b: any) => Promise<any>; status: (k: string, t: string) => void; paint: () => void };
type Api = { WRG: any; wrgCanSave: (S: any) => true | string; wrgLoad: Function; wrgValidate: Function; wrgSave: Function; wrgRestore: Function; wrgDuplicate: Function; wrgTierNames: (t: string) => string[]; wrgBackupsHtml: (S: any) => string };

const NAMES = "wrgCanSave,wrgLoad,wrgValidate,wrgSave,wrgRestore,wrgDuplicate,wrgTierNames,wrgBackupsHtml";
function lib(): Api {
  const stubs = `var Win={registerType:function(){},el:function(){return null},ctx:function(){return null},update:function(){}};
var WinT={leaf:function(){},split:function(){}};var WIN_HOST=null;function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;")}`;
  return new Function(`${stubs}\n${WIN_REGISTRY_JS}\nreturn{WRG:WRG,${NAMES}};`)() as Api;
}

const A = "local_tiers:\n  gyro-m:\n    port: 8101\n    file: a.gguf\nproviders:\n  p1:\n    url: http://x\n";
const hash = (t: string) => `h${t.length}:${t.charCodeAt(t.length - 2)}`;

/** An in-memory registry behind the routes of cockpit-registry.ts; `calls` records every request. */
function fake() {
  const st = { yaml: A, backups: [] as { name: string; yaml: string }[], calls: [] as string[], n: 0 };
  const stamp = () => `workers.yaml.20260101-00000${st.n++}.bak`;
  const check = (y: string) => (y.includes("BAD") ? [{ path: "local_tiers", line: 3, message: "bad port" }] : []);
  const write = (y: string, base: string) => {
    if (base !== hash(st.yaml)) return { ok: false, error: "changed on disk - reload" };
    const e = check(y);
    if (e.length) return { ok: false, error: e[0]!.message };
    const name = stamp();
    st.backups.unshift({ name, yaml: st.yaml });
    st.yaml = y;
    return { ok: true, backup: name };
  };
  const io: Io & { status: any } = {
    get: async (u) => {
      st.calls.push("GET " + u);
      if (u === "/cockpit/registry") return { yaml: st.yaml, mtime: 1, hash: hash(st.yaml) };
      return { backups: st.backups.map((b) => ({ name: b.name, size: b.yaml.length, mtime: 1, summary: "+1 -0 lines" })) };
    },
    post: async (u, b) => {
      st.calls.push("POST " + u);
      if (u.endsWith("/validate")) return b.baseHash !== hash(st.yaml) ? { ok: false, errors: [], diff: [], stale: true } : { ok: !check(b.yaml).length, errors: check(b.yaml), diff: b.yaml === st.yaml ? [] : ["+ changed"] };
      if (u.endsWith("/save")) return write(b.yaml, b.baseHash);
      if (u.endsWith("/restore")) return write(st.backups.find((x) => x.name === b.name)!.yaml, b.baseHash);
      if (b.newName === "gyro-m") return { ok: false, error: 'name "gyro-m" already exists' };
      return { ok: true, yaml: b.yaml + "# dup\n", name: b.newName ?? "gyro-m-2", port: b.port ?? 8102 };
    },
    status: () => {},
    paint: () => {},
  };
  const log: [string, string][] = [];
  io.status = (k: string, t: string) => log.push([k, t]);
  return { st, io, log };
}

describe("registry editor logic (fake fetch)", () => {
  it("Save is disabled until Validate passed on exactly this text, and again after any edit", async () => {
    const L = lib(), f = fake(), S = L.WRG;
    await L.wrgLoad(S, f.io, false);
    expect(S.text).toBe(A);
    expect(S.backups).toEqual([]);
    expect(L.wrgCanSave(S)).toBe("no changes to save");
    S.text = A + "# edit\n";
    expect(L.wrgCanSave(S)).toBe("validate this text first");
    await L.wrgValidate(S, f.io);
    expect(L.wrgCanSave(S)).toBe(true);
    expect(f.log.at(-1)![0]).toBe("ok");
    S.text += "x";
    expect(L.wrgCanSave(S)).toBe("validate this text first");
    expect(f.st.calls.filter((c) => c === "POST /cockpit/registry/save")).toEqual([]);
  });

  it("a failed Validate keeps Save disabled and shows line-numbered errors in the diff slot and the status", async () => {
    const L = lib(), f = fake(), S = L.WRG;
    await L.wrgLoad(S, f.io, false);
    S.text = A + "BAD\n";
    await L.wrgValidate(S, f.io);
    expect(L.wrgCanSave(S)).toBe("validate this text first");
    expect(S.diff).toBe("line 3 · local_tiers: bad port");
    expect(f.log.at(-1)).toEqual(["err", "1 error · first: line 3"]);
    expect(await L.wrgSave(S, f.io)).toBeNull();
    expect(f.st.calls).not.toContain("POST /cockpit/registry/save");
    expect(f.log.at(-1)![1]).toBe("cannot save: validate this text first");
  });

  it("Save posts the text and the base hash, reloads, lists the backup, and reports it in the status", async () => {
    const L = lib(), f = fake(), S = L.WRG;
    await L.wrgLoad(S, f.io, false);
    const B = A + "# edit\n";
    S.text = B;
    await L.wrgValidate(S, f.io);
    const r = await L.wrgSave(S, f.io);
    expect(r.ok).toBe(true);
    expect(f.st.yaml).toBe(B);
    expect(S.saved).toBe(B);
    expect(S.hash).toBe(hash(B));
    expect(S.backups.length).toBe(1);
    expect(f.log.at(-1)![0]).toBe("ok");
    expect(f.log.at(-1)![1]).toContain("saved · backup workers.yaml.");
    expect(L.wrgCanSave(S)).toBe("no changes to save");
  });

  it("a server refusal (stale hash) shows the exact text and leaves the file", async () => {
    const L = lib(), f = fake(), S = L.WRG;
    await L.wrgLoad(S, f.io, false);
    f.st.yaml = A + "# changed elsewhere\n";
    S.text = A + "# mine\n";
    await L.wrgValidate(S, f.io);
    expect(f.log.at(-1)).toEqual(["err", "changed on disk - reload"]);
    expect(L.wrgCanSave(S)).toBe("validate this text first");
  });

  it("Restore needs a second click inside the window; the result lands in the status and the editor shows the restored text", async () => {
    const L = lib(), f = fake(), S = L.WRG;
    await L.wrgLoad(S, f.io, false);
    S.text = A + "# B\n";
    await L.wrgValidate(S, f.io);
    await L.wrgSave(S, f.io);
    const name = S.backups[0].name;
    expect(await L.wrgRestore(S, f.io, name, 1000)).toBeNull();
    expect(S.arm).toBe(name);
    expect(L.wrgBackupsHtml(S)).toContain("confirm restore");
    expect(f.st.calls).not.toContain("POST /cockpit/registry/restore");
    await L.wrgRestore(S, f.io, name, 1000 + 4001);
    expect(f.st.calls).not.toContain("POST /cockpit/registry/restore");
    await L.wrgRestore(S, f.io, name, 1000 + 4001 + 100);
    expect(f.st.yaml).toBe(A);
    expect(S.text).toBe(A);
    expect(f.log.at(-1)![1]).toContain("restored · backup workers.yaml.");
    expect(S.backups.length).toBe(2);
  });

  it("Duplicate inserts the copy into the text without saving, then validates; a clash is refused with the server's text", async () => {
    const L = lib(), f = fake(), S = L.WRG;
    await L.wrgLoad(S, f.io, false);
    expect(L.wrgTierNames(A)).toEqual(["gyro-m"]);
    const r = await L.wrgDuplicate(S, f.io, { name: "gyro-m", newName: "", port: "" });
    expect(r.name).toBe("gyro-m-2");
    expect(S.text).toBe(A + "# dup\n");
    expect(f.st.yaml).toBe(A);
    expect(f.st.calls).toContain("POST /cockpit/registry/validate");
    expect(L.wrgCanSave(S)).toBe(true);
    expect(f.log.at(-1)![1]).toBe("duplicated as gyro-m-2 on port 8102 · not saved");
    await L.wrgDuplicate(S, f.io, { name: "gyro-m", newName: "gyro-m", port: "" });
    expect(f.log.at(-1)).toEqual(["err", 'name "gyro-m" already exists']);
  });

  it("a dead fetch is reported, never silent", async () => {
    const L = lib(), f = fake(), S = L.WRG;
    await L.wrgLoad(S, f.io, false);
    f.io.post = async () => { throw new Error("offline"); };
    S.text += "x";
    await L.wrgValidate(S, f.io);
    expect(f.log.at(-1)).toEqual(["err", "no answer: offline"]);
    expect(S.busy).toBe(false);
  });
});

const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
const PROBE = `<script>setTimeout(function(){
function card(id){return document.querySelector('#win-root [data-card="'+id+'"]')}
var e=card("settings.registry-edit"),b=card("settings.registry-backups"),o={err:window.__err||null};
if(e){var ta=e.querySelector("textarea");o.ta=ta&&ta.value;o.acts=Array.prototype.map.call(e.querySelectorAll(".cact"),function(x){return x.getAttribute("data-act")+":"+(x.disabled?"off":"on")});
 o.saveTitle=e.querySelector('[data-act="save"]').title;o.heads=Array.prototype.map.call(e.querySelectorAll(".chead > *"),function(x){return x.className.split(" ")[0]}).join(",");
 e.querySelector('[data-act="validate"]').click()}
setTimeout(function(){if(e){o.status=e.querySelector(".cstatus").textContent;o.saveAfter=e.querySelector('[data-act="save"]').disabled}
 o.bk=b&&b.textContent.replace(/\\s+/g," ");document.body.setAttribute("data-r",JSON.stringify(o))},700);
},1500)</script>`;

describe.skipIf(!CHROME)("B8b-client settings group on the win runtime", () => {
  let server: Server, base = "", tmp = "";
  const browsers = new Set<ChildProcess>();
  const seen: string[] = [];
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cockpit-win-registry-"));
    server = createServer((req, res) => {
      const url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      seen.push(`${req.method} ${url.split("?")[0]}`);
      if (url.startsWith("/cockpit/registry/backups")) return res.end(JSON.stringify({ backups: [{ name: "workers.yaml.20260101-000000.bak", size: 300, mtime: 1, summary: "+1 -0 lines" }] }));
      if (url.startsWith("/cockpit/registry/validate")) return res.end(JSON.stringify({ ok: true, errors: [], diff: [] }));
      if (url.startsWith("/cockpit/registry")) return res.end(JSON.stringify({ yaml: A, mtime: 1, hash: "h" }));
      if (url.startsWith("/page")) {
        res.setHeader("content-type", "text/html");
        return res.end(cockpitHtml().replace("</head>", '<script>window.onerror=function(m,s,l,c){window.__err=String(m)+" @"+l+":"+c}</script></head>').replace("</body>", PROBE + "</body>"));
      }
      if (url.startsWith("/cockpit/")) return res.end("{}");
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { for (const c of browsers) c.kill("SIGKILL"); server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  function run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const c = execFile(CHROME!, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 }, (err, stdout) => { browsers.delete(c); err ? reject(err) : resolve(stdout); });
      browsers.add(c);
    });
  }

  it("renders the editor and the backups list; Save is disabled before Validate and Validate posts to the fake server", async () => {
    const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(tmp, "p")}`, "--window-size=1400,1800", "--virtual-time-budget=8000"];
    const dom = await run([...args, "--dump-dom", `${base}/page`]);
    const m = /data-r="([^"]*)"/.exec(dom);
    if (!m) throw new Error("no probe result in dump");
    const r = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    expect(r.err).toBeNull();
    expect(r.ta).toBe(A);
    expect(r.acts).toEqual(["validate:on", "diff:on", "save:off", "duplicate:on"]);
    expect(r.saveTitle).toBe("no changes to save");
    expect(r.heads).toBe("cgrip,ctitle,cstatus,cbtn,cbtn,cbtn,cbtn,cbtn");
    expect(r.status).toContain("valid");
    expect(r.bk).toContain("20260101-000000");
    expect(r.bk).toContain("restore");
    expect(seen).toContain("POST /cockpit/registry/validate");
  }, 120_000);
});
