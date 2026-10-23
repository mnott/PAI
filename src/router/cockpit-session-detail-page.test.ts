/**
 * cockpit-session-detail-page.test.ts — the per-session detail panel on the
 * sessions card: the page's real sessionsHtml / sessDetailHtml / click wiring,
 * run in a function scope with the data a poll would bring.
 */

import { describe, expect, it } from "vitest";
import { COCKPIT_HTML as PAGE } from "./cockpit-page.js";
import { WIN_TABLES_JS } from "./cockpit-page/win/cards-tables.js";
import { fnSrc, hideLib, varSrc } from "./cockpit-page-src.js";
import { WIN_MORPH_JS } from "./cockpit-page/win/morph.js";

const fns = ["esc", "fmt", "pct", "tot", "ago", "cls", "hitCls", "vcls", "runHead", "runRow", "sessMore", "sessionsHtml", "table", "sessDetailBody", "sessDetailHtml", "sessDetailOpen", "sessQ", "sessLabel", "sessHitsHtml", "sessSearch"].map((n) => fnSrc(PAGE, n)).join("\n");

const detail = {
  id: "s0000000x", cwd: "/work/proj", models: ["m-a"], turnCount: 1,
  turns: [{ idx: 0, ts: new Date().toISOString(), prompt: "do the thing", tools: [{ name: "Edit", count: 2 }], edits: ["/work/proj/a.ts"], commands: 1 }],
  filesChanged: [{ path: "/work/proj/a.ts", edits: 2, approxLinesChanged: 6 }],
  skills: [{ name: "End", ts: new Date().toISOString() }],
  mcp: [{ server: "srv", calls: 2, failures: 1 }],
  denials: [{ ts: new Date().toISOString(), tool: "Bash", reason: "not allowed" }],
};

function harness() {
  const updates: string[] = [];
  const fetched: string[] = [];
  const src = `var U=arguments[0],F=arguments[1],SESSION_ROWS=50,wrFolded=function(){return{}},WR_FOLD_KEY="k",WCHX={},Win={update:function(){U.push("data")}},data={},fitTables=function(){},localStorage={getItem:function(){return null},setItem:function(){}},fetch=function(u){F.push(u);return new Promise(function(){})};
${varSrc(PAGE, "SESS_MORE_KEY")}
${varSrc(PAGE, "HIT_WARN")}
${varSrc(PAGE, "SESS_OPEN")}
${varSrc(PAGE, "SESS_Q")}
${hideLib(PAGE)}
${fns}
${WIN_TABLES_JS}
return{html:sessionsHtml,wire:wtWire,run:function(c){return eval(c)},set:function(k,v){if(k==="det")SESS_DET=v},get:function(){return{open:SESS_OPEN,tab:SESS_TAB}}};`;
  const api = new Function(src)
    .call(null, updates, fetched) as { html: (d: unknown) => string; wire: (c: unknown) => void; set: (k: string, v: unknown) => void; get: () => { open: string | null; tab: string }; run: (c: string) => unknown };
  // Function() ignores call args for `arguments` of the outer wrapper: pass them explicitly
  return { api, updates, fetched };
}

const sess = { session: "s0000000x", name: "n0", models: ["m-a"], requests: 1, input: 10, output: 5, cacheRead: 100, cacheWrite: 0, hitRatio: 0.9, busts: 0, errors: 0, lastTs: new Date().toISOString() };
const d = { bySession: [sess] };

describe("session drill-down panel", () => {
  it("rows carry the session id, no panel while nothing is open", () => {
    const { api } = harness();
    const h = api.html(d);
    expect(h).toContain('data-sess="s0000000x"');
    expect(h).not.toContain('class="sd"');
  });

  it("a row click opens the panel under the table, fetches the endpoint, and the panel survives the poll redraw", () => {
    const { api, updates, fetched } = harness();
    let onClick: ((e: unknown) => void) | undefined;
    api.wire({ body: { addEventListener: (_: string, f: (e: unknown) => void) => { onClick = f; }, contains: () => true } });
    const click = (attr: string, val: string) => onClick!({ target: { closest: () => ({ hasAttribute: (a: string) => a === attr, getAttribute: () => val }) }, preventDefault() {} });
    click("data-sess", "s0000000x");
    expect(fetched).toEqual(["/api/session/s0000000x/detail"]);
    expect(updates).toEqual(["data"]);
    expect(api.get().open).toBe("s0000000x");
    const loading = api.html(d);
    expect(loading).toMatch(/class="sd" data-sd="s0000000x"/);
    expect(loading).toContain("loading");
    expect(loading.indexOf('class="sd"')).toBeGreaterThan(loading.indexOf("wr-tbl"));

    api.set("det", detail);
    for (let poll = 0; poll < 2; poll++) {
      const h = api.html(d); // each poll rebuilds the card from the same state
      expect(h).toContain("do the thing");
      for (const tab of ["timeline", "files", "skills", "mcp", "denials"]) expect(h).toContain(`data-sesstab="${tab}"`);
      expect(h).toContain('data-sessclose="1"');
    }
    click("data-sesstab", "mcp");
    expect(api.html(d)).toMatch(/srv[\s\S]*2[\s\S]*1/);
    click("data-sesstab", "denials");
    expect(api.html(d)).toContain("not allowed");
    click("data-sessclose", "1");
    expect(api.get().open).toBeNull();
    expect(api.html(d)).not.toContain('class="sd"');
  });

  it("a second click on the open row closes it", () => {
    const { api } = harness();
    let onClick: ((e: unknown) => void) | undefined;
    api.wire({ body: { addEventListener: (_: string, f: (e: unknown) => void) => { onClick = f; }, contains: () => true } });
    const row = { target: { closest: () => ({ hasAttribute: (a: string) => a === "data-sess", getAttribute: () => "s0000000x" }) }, preventDefault() {} };
    onClick!(row);
    onClick!(row);
    expect(api.get().open).toBeNull();
  });

  it("lists turns, skills and denials newest first, keeping the turn numbers", () => {
    const { api } = harness();
    let onClick: ((e: unknown) => void) | undefined;
    api.wire({ body: { addEventListener: (_: string, f: (e: unknown) => void) => { onClick = f; }, contains: () => true } });
    onClick!({ target: { closest: () => ({ hasAttribute: (a: string) => a === "data-sess", getAttribute: () => "s0000000x" }) }, preventDefault() {} });
    const mk = (i: number) => ({ idx: i, ts: new Date().toISOString(), prompt: `prompt-${i}`, tools: [], edits: [], commands: 0 });
    api.set("det", { ...detail, turns: [mk(0), mk(1)], turnCount: 2, skills: [{ name: "first", ts: "2026-01-01T00:00:00Z" }, { name: "second", ts: "2026-01-02T00:00:00Z" }], denials: [{ ts: "2026-01-01T00:00:00Z", tool: "t-old", reason: "r" }, { ts: "2026-01-02T00:00:00Z", tool: "t-new", reason: "r" }] });
    expect(api.html(d).indexOf("prompt-1")).toBeLessThan(api.html(d).indexOf("prompt-0"));
    for (const tab of ["skills", "denials"]) {
      onClick!({ target: { closest: () => ({ hasAttribute: (a: string) => a === "data-sesstab", getAttribute: () => tab }) }, preventDefault() {} });
      const h = api.html(d);
      const [a, b] = tab === "skills" ? ["second", "first"] : ["t-new", "t-old"];
      expect(h.indexOf(a)).toBeLessThan(h.indexOf(b));
    }
  });
});

const many = (n: number) => ({ bySession: Array.from({ length: n }, (_, i) => ({ ...sess, session: `sess-${i}xxxxx`, name: `name-${i}`, models: [i === 7 ? "special-model" : "m-a"], input: 1000 - i * 10 })) });

function wired() {
  const h = harness();
  let onClick: ((e: unknown) => void) | undefined;
  h.api.wire({ body: { addEventListener: (_: string, f: (e: unknown) => void) => { onClick = f; }, contains: () => true } });
  const click = (attrs: Record<string, string>) => onClick!({ target: { closest: () => ({ hasAttribute: (a: string) => a in attrs, getAttribute: (a: string) => attrs[a] }) }, preventDefault() {} });
  return { ...h, click };
}

describe("panel placement", () => {
  it("renders the panel directly under the clicked row, not under the table", () => {
    const { api, click } = wired();
    const dd = many(4);
    click({ "data-sess": "sess-1xxxxx" });
    const h = api.html(dd);
    const i = h.indexOf('data-sess="sess-1xxxxx"');
    expect(h.indexOf('class="sd"')).toBeGreaterThan(i);
    expect(h.indexOf('class="sd"')).toBeLessThan(h.indexOf('data-sess="sess-2xxxxx"'));
    expect(h.match(/class="sd"/g)).toHaveLength(1);
  });

  it("keeps the panel of a session hidden behind \"more\" visible", () => {
    const { api, click } = wired();
    const dd = many(30);
    const before = api.html(dd);
    expect(before).not.toContain('data-sess="sess-29xxxxx"');
    click({ "data-sess": "sess-29xxxxx" });
    const h = api.html(dd);
    expect(h).toContain('data-sess="sess-29xxxxx"');
    expect(h.indexOf('class="sd"')).toBeGreaterThan(h.indexOf('data-sess="sess-29xxxxx"'));
    expect(h).toContain("data-sessmore");
  });

  it("uses buttons without href for tabs, close and more, so nothing scrolls to #", () => {
    const { api, click } = wired();
    click({ "data-sess": "sess-1xxxxx" });
    const h = api.html(many(30));
    expect(h).not.toContain('href="#"');
    expect(h).toContain('<button type="button" class="lnk dim sd-x" data-sessclose="1"');
  });
});

describe("session search", () => {
  it("filters the rows by name, id and model as the query changes", () => {
    const { api } = wired();
    const dd = many(30);
    api.run('SESS_Q="name-12"');
    let h = api.html(dd);
    expect(h).toContain('data-sess="sess-12xxxxx"');
    expect(h).not.toContain('data-sess="sess-3xxxxx"');
    api.run('SESS_Q="sess-5x"');
    expect(api.html(dd)).toContain('data-sess="sess-5xxxxx"');
    api.run('SESS_Q="SPECIAL-model"');
    h = api.html(dd);
    expect(h).toContain('data-sess="sess-7xxxxx"');
    expect(h.match(/data-sess="/g)).toHaveLength(1);
    api.run('SESS_Q="nothing-like-this"');
    expect(api.html(dd)).toContain("no session matches");
  });

  it("prompts mode queries the endpoint and lists hits; a hit opens its session at the turn", () => {
    const { api, click, fetched } = wired();
    const dd = many(3);
    api.run('SESS_MODE="prompts";SESS_Q="thing"');
    expect(api.html(dd)).toContain("searching");
    api.run("sessSearch(function(){})");
    expect(fetched).toEqual(["/api/sessions/search?q=thing"]);
    api.run('SESS_HITS={q:"thing",hits:[{id:"sess-2xxxxx",cwd:"/w",turn:4,ts:new Date().toISOString(),snippet:"do the <thing> now"}]}');
    const h = api.html(dd);
    expect(h).toContain('data-hit="sess-2xxxxx" data-turn="4"');
    expect(h).toContain("do the &lt;thing&gt; now");
    expect(h).toContain("name-2");
    click({ "data-hit": "sess-2xxxxx", "data-turn": "4" });
    expect(fetched).toContain("/api/session/sess-2xxxxx/detail");
    expect(api.get().open).toBe("sess-2xxxxx");
    const mk = (i: number) => ({ idx: i, ts: new Date().toISOString(), prompt: i === 4 ? "do the thing" : `other-${i}`, tools: [], edits: [], commands: 0 });
    api.set("det", { ...detail, id: "sess-2xxxxx", turns: [0, 1, 2, 3, 4, 5].map(mk), turnCount: 6 });
    const open = api.html(dd);
    expect(open).toMatch(/<span data-turn="4" class="sd-hl">5<\/span>/);
    expect(open).not.toContain("other-1"); // timeline filtered to the prompts matching the query
    expect(open).toContain("do the thing");
    expect(api.run("SESS_SCROLL")).toBe(true);
    // a second hit on the open session keeps it open
    click({ "data-hit": "sess-2xxxxx", "data-turn": "4" });
    expect(api.get().open).toBe("sess-2xxxxx");
  });
});

describe("prompt search: from memory divider", () => {
  it("renders recent hits, then the divider and memory hits with age; note and mapped/unmapped hits", () => {
    const { api } = wired();
    const dd = many(3);
    api.run('SESS_MODE="prompts";SESS_Q="thing"');
    api.run('SESS_HITS={q:"thing",hits:[{id:"sess-2xxxxx",cwd:"/w",turn:1,ts:new Date().toISOString(),snippet:"recent one"}],memory:[{id:"sess-1xxxxx",turn:-1,path:"Notes/a.md",snippet:"mapped <m>",updatedAt:Date.now()-86400000*5},{id:"",turn:-1,path:"Notes/2026/b.md",projectSlug:"proj",snippet:"plain note",updatedAt:0}],note:"memory search unavailable (x)"}');
    const h = api.html(dd);
    expect(h.indexOf("recent one")).toBeLessThan(h.indexOf("from memory"));
    expect(h.indexOf("from memory")).toBeLessThan(h.indexOf("mapped &lt;m&gt;"));
    expect(h).toContain('data-hit="sess-1xxxxx" data-turn="0"');
    expect(h).toContain("plain note");
    expect(h.match(/data-hit="/g)).toHaveLength(2);
    expect(h).toContain("memory search unavailable");
    api.run('SESS_HITS={q:"thing",hits:[],memory:[],note:""}');
    expect(api.html(dd)).not.toContain("from memory");
  });
});

describe("morph and a focused link", () => {
  // A clicked <a href="#"> keeps focus; the redraw it triggers must still be able to remove the panel holding it.
  const keep = (focused: { nodeName: string }, node: { nodeType: number; contains: (x: unknown) => boolean }) =>
    new Function("document", `${WIN_MORPH_JS}\nreturn _mkeep;`)({ activeElement: focused })(node) as boolean;
  const panel = (inner: unknown) => ({ nodeType: 1, contains: (x: unknown) => x === inner });

  it("does not pin the panel or the link that holds focus", () => {
    const link = { nodeType: 1, nodeName: "A", contains: () => false };
    expect(keep(link, link)).toBeFalsy();
    expect(keep(link, panel(link))).toBeFalsy();
  });

  it("does not pin a focused disclosure button either", () => {
    const btn = { nodeType: 1, nodeName: "BUTTON", classList: { contains: (c: string) => c === "lnk" }, contains: () => false };
    expect(keep(btn, btn)).toBeFalsy();
    expect(keep(btn, panel(btn))).toBeFalsy();
  });

  it("still pins a focused form control and its ancestors", () => {
    const input = { nodeType: 1, nodeName: "INPUT", contains: () => false };
    expect(keep(input, input)).toBeTruthy();
    expect(keep(input, panel(input))).toBeTruthy();
  });
});
