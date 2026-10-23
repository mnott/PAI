/**
 * cockpit-hide.test.ts — the cockpit's hide rules (router.cockpit.hide): validation and matcher, the config round trip through
 * /cockpit/hide against a temp PAI_HOME (never the live config), the search endpoint applying the rules server side, and the page's
 * own filtering per list ("N hidden", dimmed when shown) run in node.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { fnSrc as FnSrc, hideLib as HideLib, varSrc as VarSrc } from "./cockpit-page-src.js";

const savedHome = process.env.PAI_HOME;
const savedConfigFile = process.env.PAI_CONFIG_FILE;
const root = mkdtempSync(join(tmpdir(), "pai-cockpit-hide-"));
let handleCockpit: typeof import("./cockpit.js")["handleCockpit"];
let hide: typeof import("./cockpit-hide.js");
let srv: http.Server;
// loaded after PAI_CONFIG_FILE is set: the config module resolves its file once, at first import
let PAGE: string;
let WIN_TABLES_JS: string;
let fnSrc: typeof FnSrc;
let hideLib: typeof HideLib;
let varSrc: typeof VarSrc;
const projects = join(root, "projects");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const prompt = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-01-01T10:00:00Z", message: { role: "user", content: text } }) + "\n";

beforeAll(async () => {
  process.env.PAI_HOME = root;
  process.env.PAI_CONFIG_FILE = join(root, "config.yaml");
  writeFileSync(process.env.PAI_CONFIG_FILE, "{}\n");
  hide = await import("./cockpit-hide.js");
  ({ COCKPIT_HTML: PAGE } = await import("./cockpit-page.js"));
  ({ WIN_TABLES_JS } = await import("./cockpit-page/win/cards-tables.js"));
  ({ fnSrc, hideLib, varSrc } = await import("./cockpit-page-src.js"));
  ({ handleCockpit } = await import("./cockpit.js"));
  mkdirSync(join(projects, "-p"), { recursive: true });
  writeFileSync(join(projects, "-p", `${A}.jsonl`), prompt("keepalive ping about the quokka"));
  writeFileSync(join(projects, "-p", `${B}.jsonl`), prompt("real work on the quokka"));
  srv = http.createServer((req, res) => {
    const none = { get: async () => [] } as never;
    const memorySearch = async () => [{ path: "Notes/n.md", snippet: "keepalive quokka note", updatedAt: 1, roots: [root] }, { path: "Notes/m.md", snippet: "other quokka note", updatedAt: 2, roots: [root] }];
    if (!handleCockpit(req, res, none, () => [], () => new Map(), undefined, undefined, undefined, undefined, undefined, { projectsDir: projects, memorySearch })) res.end("other");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
});
afterAll(() => {
  srv.close();
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedHome;
  if (savedConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = savedConfigFile;
});

function ask(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const port = (srv.address() as AddressInfo).port;
  return new Promise<{ status: number; json: any }>((resolve) => {
    const rq = http.request({ host: "127.0.0.1", port, path, method, headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, json: b.startsWith("{") ? JSON.parse(b) : b }));
    });
    if (body !== undefined) rq.write(JSON.stringify(body));
    rq.end();
  });
}

describe("hide rules: validation and matcher", () => {
  it("defaults the lists to all, trims, and refuses a bad rule with a message naming it", () => {
    expect(hide.parseHideRules([{ match: " keepalive " }])).toEqual([{ match: "keepalive", in: ["sessions", "runs", "timeline", "search"] }]);
    expect(hide.parseHideRules([{ match: "x", in: ["search", "runs"], note: "why" }])).toEqual([{ match: "x", in: ["runs", "search"], note: "why" }]);
    expect(() => hide.parseHideRules([{ match: "" }])).toThrow(/rule 1: match must be/);
    expect(() => hide.parseHideRules([{ match: "a" }, { match: "/(/" }])).toThrow(/rule 2: invalid regex/);
    expect(() => hide.parseHideRules([{ match: "a", in: ["nowhere"] }])).toThrow(/in must be a non-empty list/);
    expect(() => hide.parseHideRules("x")).toThrow(/must be a list/);
  });
  it("matches a substring case-insensitively and /regex/ per list", () => {
    const m = hide.hideMatcher(hide.parseHideRules([{ match: "KeepAlive", in: ["runs"] }, { match: "/^probe-\\d+$/", in: ["sessions"] }]));
    expect(m("runs", "probe-keepalive-1")).toBe(true);
    expect(m("sessions", "probe-keepalive-1")).toBe(false);
    expect(m("sessions", "PROBE-42")).toBe(true);
    expect(m("sessions", "probe-x")).toBe(false);
  });
});

describe("/cockpit/hide", () => {
  it("round trip: add, edit, delete through the endpoint, persisted in the config", async () => {
    expect((await ask("/cockpit/hide")).json).toEqual({ rules: [] });
    const add = await ask("/cockpit/hide", "POST", { rules: [{ match: "keepalive", in: ["runs"], note: "beats" }] });
    expect(add.status).toBe(200);
    expect(hide.readHideRules()).toEqual([{ match: "keepalive", in: ["runs"], note: "beats" }]);
    expect((await ask("/cockpit/hide")).json.rules).toHaveLength(1);
    const edit = await ask("/cockpit/hide", "POST", { rules: [{ match: "/keep.*/", in: ["runs", "timeline"] }] });
    expect(edit.json.rules).toEqual([{ match: "/keep.*/", in: ["runs", "timeline"] }]);
    expect(hide.readHideRules()).toEqual([{ match: "/keep.*/", in: ["runs", "timeline"] }]);
    expect((await ask("/cockpit/hide", "POST", { rules: [] })).status).toBe(200);
    expect(hide.readHideRules()).toEqual([]);
  });
  it("refuses an invalid regex with a clear message and keeps the stored list", async () => {
    await ask("/cockpit/hide", "POST", { rules: [{ match: "keep" }] });
    const bad = await ask("/cockpit/hide", "POST", { rules: [{ match: "/(/" }] });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ ok: false });
    expect(bad.json.message).toMatch(/rule 1: invalid regex \/\(\//);
    expect(hide.readHideRules().map((r) => r.match)).toEqual(["keep"]);
    await ask("/cockpit/hide", "POST", { rules: [] });
  });
  it("refuses a cross-origin POST and a non-JSON body", async () => {
    expect((await ask("/cockpit/hide", "POST", { rules: [] }, { origin: "http://evil.example" })).status).toBe(403);
    const port = (srv.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve) => {
      const rq = http.request({ host: "127.0.0.1", port, path: "/cockpit/hide", method: "POST", headers: { "content-type": "text/plain" } }, (res) => (res.resume(), resolve(res.statusCode!)));
      rq.end("{}");
    });
    expect(status).toBe(415);
  });
  it("the search endpoint drops hidden hits so they do not use up the cap", async () => {
    const before = (await ask("/api/sessions/search?q=quokka")).json;
    expect(before.hits.map((h: { id: string }) => h.id).sort()).toEqual([A, B]);
    expect(before.memory).toHaveLength(2);
    await ask("/cockpit/hide", "POST", { rules: [{ match: "keepalive", in: ["search"] }] });
    const after = (await ask("/api/sessions/search?q=quokka")).json;
    expect(after.hits.map((h: { id: string }) => h.id)).toEqual([B]);
    expect(after.memory.map((m: { snippet: string }) => m.snippet)).toEqual(["other quokka note"]);
    // a rule for another list leaves the search alone
    await ask("/cockpit/hide", "POST", { rules: [{ match: "keepalive", in: ["runs"] }] });
    expect((await ask("/api/sessions/search?q=quokka")).json.hits).toHaveLength(2);
    await ask("/cockpit/hide", "POST", { rules: [] });
  });
});

describe("the page filters per list", () => {
  function lib() {
    const fns = ["esc", "fmt", "pct", "tot", "ago", "cls", "hitCls", "vcls", "dur", "runHead", "runRow", "sessMore", "sessQ", "sessLabel", "sessHitsHtml", "sessionsHtml", "findingsCell", "workerGroups", "wrFolded", "workersHtml", "table", "sessDetailBody"].map((n) => fnSrc(PAGE, n)).join("\n");
    const src = `var SESSION_ROWS=50,WORKER_ROWS=50,WCHX={},Win={update:function(){}},data={},fitTables=function(){},document={contains:function(){return false}},store={},localStorage={getItem:function(k){return store[k]==null?null:store[k]},setItem:function(k,v){store[k]=v}};
${varSrc(PAGE, "SESS_MORE_KEY")}\n${varSrc(PAGE, "WR_FOLD_KEY")}\n${varSrc(PAGE, "HIT_WARN")}\n${varSrc(PAGE, "SESS_OPEN")}\n${varSrc(PAGE, "SESS_Q")}\n${varSrc(PAGE, "SESS_TAB")}\n${hideLib(PAGE)}\n${fns}\n${WIN_TABLES_JS}
return{sessions:sessionsHtml,workers:workersHtml,detail:sessDetailBody,hits:sessHitsHtml,n:function(){return HIDE_N},suggest:hideSuggest,rules:function(r){HIDE=r},show:function(l){var s={};s[l]=1;store[HIDE_SHOW_KEY]=JSON.stringify(s)},hideAll:function(){store={}},panel:hidePanelHtml,ed:function(v){HIDE_ED=v},seen:function(){return HIDE_SEEN},setMode:function(h){SESS_Q="qq";SESS_MODE="prompts";SESS_HITS=h}};`;
    return new Function(src)() as any;
  }
  const sess = (id: string, name: string) => ({ session: id, name, models: ["m"], requests: 1, input: 10, output: 5, cacheRead: 100, cacheWrite: 0, hitRatio: 0.9, busts: 0, errors: 0, lastTs: new Date().toISOString() });
  const wrk = (id: string, name: string) => ({ ...sess(id, name), worker: id, workerParent: "pa", workerStart: Date.now() - 5000, workerEnd: Date.now(), verdict: "ok" });
  const data = { bySession: [sess("s1", "probe-keepalive-1"), sess("s2", "real work")], workers: [wrk("w1", "probe-keepalive-20260918-123412-1"), wrk("w2", "implement thing")] };

  it("hides only in the lists a rule names, counts them and keeps the row's hide control", () => {
    const L = lib();
    L.rules([{ match: "keepalive", in: ["runs"] }]);
    const runs = L.workers(data);
    expect(runs).not.toContain("probe-keepalive");
    expect(runs).toContain("implement thing");
    expect(runs).toContain('data-act="hide"');
    expect(L.n().runs).toBe(1);
    const sessions = L.sessions(data);
    expect(sessions).toContain("probe-keepalive-1");
    expect(L.n().sessions).toBe(0);
    L.rules([{ match: "/^probe-/", in: ["sessions"] }]);
    expect(L.sessions(data)).not.toContain("probe-keepalive-1");
    expect(L.n().sessions).toBe(1);
  });
  it("show-hidden (per viewer) keeps the rows, dimmed, and the count", () => {
    const L = lib();
    L.rules([{ match: "keepalive", in: ["runs"] }]);
    L.show("runs");
    const runs = L.workers(data);
    expect(runs).toContain("probe-keepalive-20260918-123412-1");
    expect(runs).toContain("wr-hid");
    expect(L.n().runs).toBe(1);
  });
  it("filters the session timeline and the prompt-search hits", () => {
    const L = lib();
    L.rules([{ match: "keepalive", in: ["timeline", "search"] }]);
    const turns = [{ idx: 0, ts: new Date().toISOString(), prompt: "keepalive ping", tools: [], edits: [], commands: 0 }, { idx: 1, ts: new Date().toISOString(), prompt: "real prompt", tools: [], edits: [], commands: 0 }];
    const tl = L.detail({ turns }, "timeline");
    expect(tl).not.toContain("keepalive ping");
    expect(tl).toContain("real prompt");
    expect(tl).toContain("1 hidden");
    expect(L.n().timeline).toBe(1);
    L.setMode({ q: "qq", hits: [{ id: "s1", turn: 0, ts: new Date().toISOString(), snippet: "keepalive hit" }, { id: "s2", turn: 0, ts: new Date().toISOString(), snippet: "good hit" }], memory: [] });
    const h = L.hits();
    expect(h).not.toContain("keepalive hit");
    expect(h).toContain("good hit");
    expect(L.n().search).toBe(1);
  });
  it("suggests a pattern per list and the editor shows each rule's current count", () => {
    const L = lib();
    expect(L.suggest("runs", "probe-keepalive-20260918-123412-1")).toBe("probe-keepalive");
    expect(L.suggest("sessions", "nightly report builder")).toBe("nightly report");
    expect(L.suggest("timeline", "send the cache keepalive beat now please")).toBe("send the cache keepalive");
    L.rules([{ match: "keepalive", in: ["runs"], note: "beats" }]);
    L.workers(data);
    L.ed("runs");
    const ed = L.panel("runs");
    expect(ed).toContain("hides 1");
    expect(ed).toContain('value="keepalive"');
    expect(ed).toContain('data-act="hidedel"');
  });
});
