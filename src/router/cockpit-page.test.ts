import { beforeEach, describe, expect, it } from "vitest";
import { COCKPIT_FAVICON_SVG, COCKPIT_HTML, cockpitHtml } from "./cockpit-page.js";

const COLLAPSE_KEY_TEST = "pai.cockpit.collapsed";

const stripTags = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");

describe("cockpit page compression", () => {
  it("no static text node outside tooltips is longer than 120 characters, and no <p> prose remains", () => {
    const html = stripTags(COCKPIT_HTML);
    const texts = html.split(/<[^>]*>/).map((t) => t.trim()).filter(Boolean);
    expect(texts.filter((t) => t.length > 120)).toEqual([]);
    expect(html).not.toContain("<p ");
    const script = COCKPIT_HTML.match(/<script>[\s\S]*?<\/script>/)![0];
    expect(script).not.toContain("<p ");
  });

  it("every tooltip icon is focusable and carries an aria-label", () => {
    const tags = COCKPIT_HTML.match(/<span class="tip"[^>]*>/g)!;
    expect(tags.length).toBeGreaterThanOrEqual(8);
    for (const t of tags) {
      expect(t).toContain('tabindex="0"');
      expect(t).toMatch(/aria-label="[^"]+"/);
      expect(t).toContain("data-tip=");
    }
    const helper = COCKPIT_HTML.match(/function tip\(t\)\{[^\n]*\}/)![0];
    expect(helper).toContain("tabindex=");
    expect(helper).toContain("aria-label=");
  });

  it("moved explanations live in tooltips", () => {
    for (const w of ["cache_read / (read + write + fresh input)", "* server counter", "TTFT = request sent", "A drop in hits after 5m", "windows differ", "Weighted: tokens times Anthropic price ratios"]) {
      expect(COCKPIT_HTML).toContain(w);
    }
    expect(COCKPIT_HTML).toMatch(/\.tip::after\{content:attr\(data-tip\)/);
  });

  it("local providers that are down sit in one closed <details>; up ones stay visible", () => {
    const body = COCKPIT_HTML.match(/function renderLimits[\s\S]*?\n\}/)![0];
    const els: Record<string, { innerHTML: string }> = { cloud: { innerHTML: "" }, local: { innerHTML: "" } };
    const fn = new Function(
      "lim", "$", "esc", "gauge", "ago", "dur", "mdl", "modelsHtml",
      `${body}\nrenderLimits();`
    );
    const lim = {
      limits: [
        { provider: "up1", kind: "local", up: true, served: ["m"] },
        ...Array.from({ length: 18 }, (_, i) => ({ provider: `dead${i}`, kind: "local", up: false })),
      ],
    };
    fn(lim, (id: string) => els[id], (s: string) => s, () => "", () => "", () => "", null, () => "");
    const html = els.local!.innerHTML;
    expect(html).toContain("up1");
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain("18 local models down");
    const outside = html.replace(/<details[\s\S]*?<\/details>/, "");
    expect(outside).toContain("up1");
    expect(outside).not.toContain("dead0");
    expect(html.match(/<details[\s\S]*?<\/details>/)![0]).toContain("dead17");
    expect(outside).not.toContain(">down<");
  });
});

describe("cockpit layout follow-up", () => {
  it("top panel: local sizes to content, cloud takes the rest", () => {
    expect(COCKPIT_HTML).toContain('class="grp grp-cloud"');
    expect(COCKPIT_HTML).toContain('class="grp grp-local"');
    expect(COCKPIT_HTML).toMatch(/\.grp-cloud\{flex:1 1 0\}/);
    expect(COCKPIT_HTML).not.toMatch(/\.grp-cloud\{flex:1 1 560px\}/);
    // gauges scale via the viewBox instead of a fixed floor: no 110px min-width,
    // the svg fills the gauge and keeps its aspect ratio
    // max-width:min(120px,100%): a long unbreakable line (an error text at a
    // large minimum font size) must not push a gauge past its container
    expect(COCKPIT_HTML).toMatch(/\.gauge\{[^}]*min-width:0[^}]*flex:1 1 110px[^}]*max-width:min\(120px,100%\)/);
    expect(COCKPIT_HTML).toMatch(/\.gauge svg\{display:block;width:100%;height:auto\}/);
    // no width:min-content: its min-content (a long error line at a large
    // minimum font size) could push the card past the viewport; the group
    // follows the gauges instead, capped at 34% of the card
    expect(COCKPIT_HTML).toMatch(/\.grp-local\{flex:0 1 auto;min-width:min\(200px,100%\);max-width:34%\}/);
    expect(COCKPIT_HTML).not.toMatch(/\.grp-local\{[^}]*width:min-content/);
    expect(COCKPIT_HTML).not.toMatch(/\.grp\{flex:1;/);
  });

  it("shows a loading state until the first limits poll arrives", () => {
    expect(COCKPIT_HTML).toContain("lim?'<span class=\"dim\">not reported</span>':'<span class=\"dim\" title=\"loading: first limits poll pending\">…</span>'");
    expect(COCKPIT_HTML).toContain("lim?\"not reported\":'<span class=\"dim\" title=\"loading: first limits poll pending\">…</span>'");
    expect(COCKPIT_HTML).toContain("lim=j;renderLimits();if(sys)renderSystem();renderDonuts()");
  });

  it("low-request models render as a chip line, not tiles", () => {
    expect(COCKPIT_HTML).toContain('id="donutlow"');
    expect(COCKPIT_HTML).toContain("function lowChips(ms)");
    expect(COCKPIT_HTML).toMatch(/filter\(function\(m\)\{return m\.requests>=LOW_REQ\}\)/);
    expect(COCKPIT_HTML).not.toContain("ring low");
    expect(COCKPIT_HTML).not.toContain('(low?" low":"")');
  });
});

describe("cockpit system tiles: unused metrics", () => {
  const body = COCKPIT_HTML.match(/function renderSystem\(\)\{[\s\S]*?\n\}\n/)![0];
  function render(series: Array<Record<string, number>>, current: Record<string, number>) {
    const els: Record<string, { innerHTML: string }> = { sys: { innerHTML: "" }, sysservers: { innerHTML: "" } };
    const sys = { current, series: { series, wh: { "1h": 0 }, coveredMin: { "1h": 0 } }, servers: [] };
    const fn = new Function(
      "sys", "$", "esc", "gb", "LAST", "win", "data", "lim", "table", "renderDonuts",
      `${body}\nrenderSystem();`
    );
    fn(sys, (id: string) => els[id], (s: string) => s, (b: number) => String(b), {}, "1h", {}, null, () => "", () => {});
    return els.sys!.innerHTML;
  }

  it("hides ANE tiles when ANE is 0 for the whole window and says so", () => {
    const html = render([{ t: 1, n: 1, ane: 0, aneW: 0, gpu: 5 }, { t: 2, n: 1, ane: 0, aneW: 0, gpu: 7 }], { ane: 0, aneW: 0, gpu: 6 });
    expect(html).not.toContain("<span>ANE load</span>");
    expect(html).not.toContain("<span>ANE W</span>");
    expect(html).toContain("<span>GPU load</span>");
    expect(html).toContain("hidden: ANE load, ANE W (0 in this window)");
  });

  it("shows ANE tiles once any bucket has ANE use", () => {
    const html = render([{ t: 1, n: 1, ane: 0, aneW: 0 }, { t: 2, n: 1, ane: 12, aneW: 0.4 }], { ane: 12, aneW: 0.4 });
    expect(html).toContain("<span>ANE load</span>");
    expect(html).toContain("<span>ANE W</span>");
    expect(html).not.toContain("hidden:");
  });

  it("keeps tiles when the window has no samples for them", () => {
    const html = render([{ t: 1, n: 1 }], {});
    expect(html).toContain("<span>ANE load</span>");
    expect(html).not.toContain("hidden:");
  });
});

describe("cockpit favicon and dark mode", () => {
  it("inline SVG favicon: a data URI right after the title, decoding to the 64x64 fan-out icon", () => {
    const link = COCKPIT_HTML.match(/<link rel="icon" type="image\/svg\+xml" href="(data:image\/svg\+xml,[^"]+)">/)![1];
    const svg = decodeURIComponent(link.slice("data:image/svg+xml,".length));
    expect(svg).toMatch(/^<svg[^>]*viewBox="0 0 64 64"/);
    expect(svg).toContain('rx="14"');
    expect(svg).toContain('fill="#3b6fe0"');
    expect(svg).toContain('stroke="#fff"');
    expect(svg).toContain('stroke-width="5"');
    expect(svg).toContain("stroke-linecap=\"round\"");
    expect(svg.match(/<circle/g)!.length).toBe(3);
    expect(svg).toBe(COCKPIT_FAVICON_SVG);
    // no raw characters that would break the URI in Safari/Chrome/Firefox
    for (const ch of ['"', "<", ">", "#", " ", "'"]) expect(link).not.toContain(ch);
    expect(COCKPIT_HTML).toMatch(/<title>PAI router cockpit<\/title>\n<link rel="icon"/);
    expect(COCKPIT_HTML).toContain('<meta name="theme-color" content="#3b6fe0">');
  });

  it("the head script picks the theme before first paint: saved choice, else the system's", () => {
    const head = COCKPIT_HTML.slice(0, COCKPIT_HTML.indexOf("</head>"));
    const script = head.match(/<script>[\s\S]*?<\/script>/)![0];
    expect(script).toContain('localStorage.getItem("pai.cockpit.theme")');
    expect(script).toContain('matchMedia("(prefers-color-scheme: dark)")');
    expect(script).toContain("document.documentElement.dataset.theme");
    // before the stylesheet: the theme is set before the first paint
    expect(head.indexOf("<script>")).toBeLessThan(head.indexOf("<style>"));
  });

  it("a round icon button in the header flips the theme; only a click is saved", () => {
    expect(COCKPIT_HTML).toContain('<button id="theme" type="button" title="Dark mode" aria-label="Dark mode">');
    const header = COCKPIT_HTML.match(/<header>[\s\S]*?<\/header>/)![0];
    expect(header).toContain('id="theme"');
    expect(header.indexOf('id="theme"')).toBeGreaterThan(header.indexOf('id="stamp"'));
    expect(header).toContain('viewBox="0 0 24 24"');
    expect(header).toContain('stroke="currentColor"');
    expect(header).toContain('width="16"');
    expect(header).toContain('class="ic-moon"');
    expect(header).toContain('class="ic-sun"');
    const js = COCKPIT_HTML.match(/\$\("theme"\)\.onclick=[\s\S]*?\}\);/)![0];
    expect(js).toContain('localStorage.setItem("pai.cockpit.theme"');
    expect(js).toContain('document.documentElement.dataset.theme==="dark"?"light":"dark"');
    // while nothing is saved, system changes are followed live
    expect(COCKPIT_HTML).toContain('matchMedia("(prefers-color-scheme: dark)").addEventListener("change"');
    expect(COCKPIT_HTML).toMatch(/if\(!s\)setTheme\(e\.matches\?"dark":"light"\)/);
    // the button's title/aria-label name the mode it switches to
    expect(COCKPIT_HTML).toContain('l=t==="dark"?"Light mode":"Dark mode";b.title=l;b.setAttribute("aria-label",l)');
  });

  it("the dark palette lives under [data-theme=dark], not a media query", () => {
    expect(COCKPIT_HTML).toContain(":root[data-theme=dark]{--bg:#10131a;--card:#181c26;--fg:#e4e8f1;--dim:#8b93a7;--line:#2a3040;--ok:#46c47a;--warn:#e8a43a;--bad:#ef6b6b;--acc:#6b95f5}");
    expect(COCKPIT_HTML).not.toMatch(/@media\(prefers-color-scheme:dark\)/);
    // the icon shows the mode a click switches TO: light shows the moon, dark shows the sun
    expect(COCKPIT_HTML).toContain(":root[data-theme=dark] .ic-moon{display:none}");
    expect(COCKPIT_HTML).toContain(":root:not([data-theme=dark]) .ic-sun{display:none}");
    // title and label follow the theme on load, not only on click
    expect(COCKPIT_HTML).toContain('setTheme(document.documentElement.dataset.theme==="dark"?"dark":"light");');
  });
});

describe("cockpit kept prefix-cache reading", () => {
  const ageMark = new Function(`${COCKPIT_HTML.match(/function ageMark[\s\S]*?\n\}/)![0]}; return ageMark;`)() as (s: unknown) => string;

  it("shows no marker for a fresh reading, a small '(Ns old)' beyond one poll interval", () => {
    expect(ageMark({ prefixCache: {} })).toBe("");
    expect(ageMark({ prefixCacheAgeSec: 45 })).toBe("");
    expect(ageMark({ prefixCacheAgeSec: 90 })).toContain("(90s old)");
    expect(ageMark({ prefixCacheAgeSec: 300 })).toContain("(5 min old)");
  });

  it("the ring caption, providers table and local detail all carry the marker", () => {
    expect(COCKPIT_HTML).toContain("server prefix cache'+ageMark(srv)");
    expect(COCKPIT_HTML).toContain("'*</span>'+ageMark(srv)");
    expect(COCKPIT_HTML).toContain("ageMark(s))");
  });
});

describe("cockpit page scripts", () => {
  it("every inline <script> body compiles", () => {
    const bodies = [...COCKPIT_HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(() => new Function(body)).not.toThrow();
  });
});

describe("cockpit workers panel", () => {
  const table = (COCKPIT_HTML.match(/function table\([\s\S]*?\n/) ?? [""])[0];
  const body = COCKPIT_HTML.match(/var qdrag[\s\S]*?\n\}/)![0];
  const render = (q: unknown) => {
    const els: Record<string, { innerHTML: string; querySelectorAll: () => unknown[] }> = {
      queuepanel: { innerHTML: "", querySelectorAll: () => [] },
      queuetip: { innerHTML: "", querySelectorAll: () => [] },
    };
    const fn = new Function("q", "$", "esc", "setTip", "loadQueue", `${table}\n${body}\nrenderQueue(q);`);
    fn(q, (id: string) => els[id], (s: string) => s, () => {}, () => {});
    return els.queuepanel!.innerHTML;
  };

  it("renders running chips with no waiting entries", () => {
    const html = render({ providers: [{ provider: "glm", cap: 2, running: [{ id: "w1", label: "fix-x", ageSec: 120, now: "editing" }], waiting: [] }] });
    expect(html).toContain("glm/?");
    expect(html).toContain("other"); // no session: the "other" block
    expect(html).toContain("fix-x");
    expect(html).toContain("editing");
    expect(html).not.toContain("nothing running or waiting");
  });

  it("renders waiting entries with buttons", () => {
    const html = render({ providers: [{ provider: "anthropic", cap: 1, running: [], waiting: [{ id: "w-2", label: "later", waitedSec: 30, position: 1 }] }] });
    expect(html).toContain("later");
    expect(html).toContain('data-q="next"');
    expect(html).toContain('data-q="up"');
  });

  it("one block per session, models inside, the cap-1 provider on its own block first", () => {
    const html = render({
      providers: [
        { provider: "anthropic", cap: 4, running: [
          { id: "w1", label: "alpha", ageSec: 10, session: "PAI", model: "sonnet" },
          { id: "w2", label: "beta", ageSec: 20, session: "PAI", model: "sonnet" },
          { id: "w3", label: "gamma", ageSec: 30, session: "AIBroker", model: "opus" },
          { id: "w4", label: "shelly", ageSec: 30, session: "other", model: "haiku" },
        ], waiting: [] },
        { provider: "local", cap: 1, running: [{ id: "l1", label: "running-local", ageSec: 5, session: "PAI", model: "flashnext-iq3" }],
          waiting: [
            { id: "l2", label: "first-wait", waitedSec: 9, position: 1, session: "AIBroker", model: "flashnext-iq3" },
            { id: "l3", label: "second-wait", waitedSec: 4, position: 2, session: "PAI", model: "flashnext-iq3" },
          ] },
      ],
    });
    const at = (x: string) => html.indexOf(x);
    expect(at("local: flashnext-iq3 (slots 1/1)")).toBeGreaterThanOrEqual(0);
    expect(at("local: flashnext-iq3 (slots 1/1)")).toBeLessThan(at("AIBroker <span"));
    expect(at("AIBroker <span")).toBeLessThan(at("PAI <span"));
    expect(at("PAI <span")).toBeLessThan(at(">other <span"));
    expect(html).toContain("anthropic/sonnet ×2");
    expect(html).toContain("anthropic/opus ×1");
    // waiting order, session label and drag handle in the local block
    expect(at("first-wait")).toBeLessThan(at("second-wait"));
    expect(at("running-local")).toBeLessThan(at("first-wait"));
    expect(html).toContain('draggable="true" data-id="l2"');
    expect(html).not.toContain('data-id="w1" data-prov'); // running rows are not draggable
  });

  it("marks stale sessions dim and shows the empty state", () => {
    const html = render({ providers: [{ provider: "glm", running: [{ id: "a", label: "AIBroker", ageSec: 250000 }], waiting: [] }] });
    expect(html).toContain("idle session");
    expect(render({ providers: [{ provider: "glm", running: [], waiting: [] }] })).toContain("nothing running or waiting");
  });

  it("sits above the System card, below the gauges", () => {
    const i = (s: string) => COCKPIT_HTML.indexOf(s);
    expect(i("Workers — running and waiting")).toBeGreaterThan(i('id="cloud"'));
    expect(i("Workers — running and waiting")).toBeLessThan(i("<h2>System"));
  });
});

describe("cockpit Models cards", () => {
  const src = [
    COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function metricTile[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function modelsHtml[\s\S]*?\n\}/)![0],
  ].join("\n");
  const modelsHtml = new Function("esc", "pct", `${src}; return modelsHtml;`)(
    (s: unknown) => String(s ?? ""),
    (x: number) => (x * 100).toFixed(1) + "%"
  ) as (inv: unknown) => string;
  const inv = {
    at: "2026-10-19T18:00:00.000Z",
    runtimes: [
      { name: "strata", kind: "strata", status: "running", port: 8035, users: ["worker:flashnext-iq3"], models: [{ model: "flash-next", kind: "coding", loaded: true, memoryMb: 50000, mappedMb: 40000, usedBy: ["worker:flashnext-iq3"] }] },
      { name: "ollama", kind: "ollama", status: "idle", port: 11434, users: ["pai-embedding", "paperfull-llm"], models: [
        { model: "arctic", kind: "embedding", loaded: true, memoryMb: 600, sizeMb: 600, usedBy: ["pai-embedding"] },
        { model: "qwen3:8b", kind: "chat", loaded: false, sizeMb: 4792, usedBy: ["paperfull-llm"] },
      ] },
      { name: "gyro-m", kind: "strata", status: "stopped", port: 8036, users: ["worker:gyro"], models: [] },
    ],
    duplicates: ["embedding runs on 2 runtimes: a + b"],
    live: {
      at: 1,
      runtimes: [
        { name: "strata", status: "running", engine: { decode: 73.4, prefill: 715, phase: "idle", parked: 2, slots: 4, reused: 900, prompt: 1000 }, workers: [{ id: "w-1", label: "fix-x", session: "PAI", state: "running" }], queued: 2, cap: 1, conversationSlots: 4, sparesReady: 1, sparesConfig: 1, history: { decode: [70, null, 73.4], prefill: [700, null, 715], memoryMb: [49000, 50000, 50000], queued: [0, 1, 2], pressurePct: [60, 61, 62] } },
        { name: "ollama", status: "idle", engine: null, workers: [], queued: 0, cap: 1, conversationSlots: null, sparesReady: 0, sparesConfig: 1, history: { decode: [], prefill: [], memoryMb: [], queued: [], pressurePct: [] } },
      ],
    },
  };
  const cards = (h: string) => h.match(/<div class="rt-card">[\s\S]*?<\/div>\s*(?=<div class="rt-card">|<\/div>|$)/g) ?? [];

  it("one card per running runtime: header, kind badge, status dot, four metric tiles", () => {
    const h = modelsHtml(inv);
    expect((h.match(/<div class="rt-card">/g) ?? []).length).toBe(2);
    expect(h).toContain("<b>flash-next</b>");
    expect(h).toContain('<span class="badge">strata</span>');
    expect(h).toContain("strata :8035");
    expect(h).toContain('<span class="rt-dot"></span>');
    expect(h).toContain('<span class="rt-dot idle"></span>');
    for (const t of ["Speed", "Memory", "Workers", "Conversation cache"]) expect(h).toContain(t);
    expect(h).toContain("73.4");
    expect(h).toContain("715");
    expect(h).toContain("48.8<small>GB</small>");
    expect(h).toContain("39.1 GB file mapped");
    expect(h).toContain("reused 90.0% of prompt tokens");
    expect(h).toContain("2<small>/ 4</small>");
    expect(h).toContain("queued 2");
    expect(h).toContain("cap 1");
    expect(h).toContain("1 spare(s) ready");
    expect(h).toContain("machine pressure 62%");
  });
  it("sparklines carry the history; a runtime without engine readings shows – everywhere live", () => {
    const h = modelsHtml(inv);
    const strata = h.slice(h.indexOf("<b>flash-next</b>"), h.indexOf("<b>arctic</b>"));
    expect(strata.match(/<path class="line/g)!.length).toBeGreaterThanOrEqual(4);
    const ollama = h.slice(h.indexOf("<b>arctic</b>"));
    expect(ollama).toContain("–");
    expect(ollama).toContain("prompt reuse not reported");
    expect(ollama).toContain("spares: none ready");
  });
  it("worker chips name the sessions with workers on the runtime", () => {
    const h = modelsHtml(inv);
    expect(h).toContain("fix-x");
    expect(h).toContain("<b>PAI</b>");
  });
  it("stopped runtimes and not-loaded models are one chip row, no tables, no horizontal scroll", () => {
    const h = modelsHtml(inv);
    expect(h).not.toContain("<table");
    expect(h).not.toContain('class="tw"');
    expect(h).not.toContain("<details");
    expect(h).toContain("stopped: gyro-m :8036");
    expect(h).toContain("not loaded: qwen3:8b chat (ollama)");
    expect(h).toContain("duplicates: embedding runs on 2 runtimes");
  });
  it("the grid follows the container at any width", () => {
    expect(COCKPIT_HTML).toContain(".rt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(180px,100%),1fr));gap:8px;min-width:0}");
    expect(COCKPIT_HTML).toContain(".rt-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(180px,100%),1fr));gap:8px;min-width:0}");
    expect(COCKPIT_HTML).toMatch(/\.rt-card\{[^}]*min-width:0[^}]*max-width:100%/);
  });
  it("the models section polls live every 5 s on its own; the tile sits after the worker panel, before System", () => {
    expect(COCKPIT_HTML).toContain('needModels=has("models")');
    expect(COCKPIT_HTML).toContain("if(needModels)loadModels()");
    expect(COCKPIT_HTML).toContain("if(needModels)setInterval(loadModels,5000)");
    const i = (s: string) => COCKPIT_HTML.indexOf(s);
    expect(i("Models — runtimes")).toBeGreaterThan(i("Workers — running and waiting"));
    expect(i("Models — runtimes")).toBeLessThan(i("<h2>System"));
    const rl = COCKPIT_HTML.match(/function renderLimits[\s\S]*?\n\}\n/)![0];
    expect(rl).toContain('$("local").innerHTML=lo');
    expect(rl).not.toContain("modelsHtml");
  });
});

describe("cockpit collapsible tiles", () => {
  const src = COCKPIT_HTML.match(/var COLLAPSE_KEY[\s\S]*?\n\}\n/)![0];
  const store: Record<string, string> = {};
  const localStorageStub = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  };
  // a tiny DOM: sections with an h2; the fold button is created once and found on later passes
  function makeDom(cards: Array<{ id: string; title: string }>) {
    const nodes = cards.map((c) => {
      const btn: { type: string; className: string; attrs: Record<string, string>; innerHTML: string; title: string; onclick: null | (() => void); setAttribute: (k: string, v: string) => void } = {
        type: "", className: "", attrs: {}, innerHTML: "", title: "", onclick: null,
        setAttribute(k, v) { this.attrs[k] = v; },
      };
      const h2 = {
        textContent: c.title, firstChild: null,
        querySelector: (s: string) => (s === "button.fold" ? btn : null),
        insertBefore() { /* the page creates one; the stub hands back the card's own button */ },
      };
      const card = {
        id: c.id,
        classes: new Set<string>(),
        querySelector: (s: string) => (s === "h2" ? h2 : null),
        classList: { toggle(cl: string, on: boolean) { if (on) card.classes.add(cl); else card.classes.delete(cl); } },
        h2, btn,
      };
      // the page's guard `if(!b.onclick)` must not skip the stub's handler
      Object.defineProperty(btn, "onclick", { value: null, writable: true, configurable: true, enumerable: true });
      return card;
    });
    const document = {
      querySelectorAll: (sel: string) => (sel === "main section.card" ? nodes : []),
      createElement: () => {
        const b: { type: string; className: string; attrs: Record<string, string>; innerHTML: string; title: string; onclick: null | (() => void); setAttribute: (k: string, v: string) => void; closest: () => unknown } = {
          type: "", className: "", attrs: {}, innerHTML: "", title: "", onclick: null,
          setAttribute(k, v) { this.attrs[k] = v; },
          closest: () => null,
        };
        return b;
      },
    };
    return { nodes, document };
  }
  const run = (cards: Array<{ id: string; title: string }>) => {
    const { nodes, document } = makeDom(cards);
    const fn = new Function("localStorage", "document", `${src}\napplyCollapse();return {collapsedSet:collapsedSet,saveCollapsed:saveCollapsed,applyCollapse:applyCollapse};`);
    return { api: fn(localStorageStub, document) as { collapsedSet: () => Record<string, number>; saveCollapsed: (s: Record<string, number>) => void; applyCollapse: () => void }, nodes };
  };
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });

  it("a click folds the tile and saves its id under pai.cockpit.collapsed", () => {
    const { nodes } = run([{ id: "sys", title: "System" }, { id: "models", title: "Models" }]);
    const btn = nodes[0].btn; // the created button is the card's own stub (closest → card)
    expect(nodes[0].classes.has("folded")).toBe(false);
    expect(btn.attrs["aria-expanded"]).toBe("true");
    btn.onclick!();
    expect(nodes[0].classes.has("folded")).toBe(true);
    expect(nodes[1].classes.has("folded")).toBe(false);
    expect(JSON.parse(store[COLLAPSE_KEY_TEST])).toEqual(["sys"]);
    expect(btn.attrs["aria-expanded"]).toBe("false");
  });

  it("the saved set is restored on load: collapsed tiles come back folded, the rest open", () => {
    store[COLLAPSE_KEY_TEST] = JSON.stringify(["models"]);
    const { nodes } = run([{ id: "sys", title: "System" }, { id: "models", title: "Models" }]);
    expect(nodes[0].classes.has("folded")).toBe(false);
    expect(nodes[1].classes.has("folded")).toBe(true);
  });

  it("the functions survive a broken or absent saved value", () => {
    store[COLLAPSE_KEY_TEST] = "{not json";
    const { api } = run([{ id: "a", title: "A" }]);
    expect(api.collapsedSet()).toEqual({});
    api.saveCollapsed({ a: 1, b: 1 });
    expect(JSON.parse(store[COLLAPSE_KEY_TEST])).toEqual(["a", "b"]);
  });

  it("auto-refresh never reopens a collapsed tile: render functions only set innerHTML", () => {
    // the collapse state lives only in localStorage + the .folded class; the
    // render* functions touch innerHTML of the tile's divs, never the class
    const renders = COCKPIT_HTML.match(/function render[A-Za-z]+\(\)\{[\s\S]*?\n\}/g)!;
    for (const r of renders) expect(r).not.toMatch(/classList|folded|applyCollapse/);
    expect(COCKPIT_HTML).toContain("setInterval(function(){load();loadSystem()},5000)");
    expect(COCKPIT_HTML).not.toMatch(/setInterval\([^)]*applyCollapse/);
  });
});

describe("cockpit metric tile", () => {
  it("page carries metricTile and its CSS; it renders title, value, sub, secondary and svg paths", () => {
    expect(COCKPIT_HTML).toContain("function metricTile(");
    expect(COCKPIT_HTML).toMatch(/\.mt-spark\{[^}]*width:100%/);
    const src = [COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0], COCKPIT_HTML.match(/function metricTile[\s\S]*?\n\}/)![0]].join("\n");
    const tile = new Function("esc", `${src}\nreturn metricTile;`)((s: unknown) => String(s ?? "")) as (o: unknown) => string;
    const html = tile({
      title: "Speed", icon: "S", value: "73.4", unit: "t/s", sub: "Decode now",
      secondary: { value: "715", unit: "t/s", sub: "Prefill this request" },
      series: [{ data: [1, 5, null, 3, 8] }, { data: [2, 2, 4, null, 6], tone: "warn" }],
    });
    for (const w of ["Speed", "73.4", "Decode now", "715", "Prefill this request", "viewBox=\"0 0 100 32\""]) expect(html).toContain(w);
    expect(html.match(/<path class="line[^>]* d="M/g)!.length).toBe(2);
    expect(html).toMatch(/d="M[^"]*M/);
  });
});

describe("router.cockpit.sections", () => {
  it("a section not in the list is absent from the rendered page", () => {
    const html = cockpitHtml(["cloud", "workers"]);
    expect(html).toContain('data-section="cloud"');
    expect(html).toContain('data-section="workers"');
    expect(html).not.toContain('data-section="sessions"');
    expect(html).not.toContain('id="sessions"');
    expect(html).not.toContain("Cache hit ratio</h2>");
    expect(html.indexOf('data-section="cloud"')).toBeLessThan(html.indexOf('data-section="workers"'));
  });

  it("missing, empty or all-unknown list renders the full page", () => {
    expect(cockpitHtml()).toBe(COCKPIT_HTML);
    expect(cockpitHtml([])).toBe(COCKPIT_HTML);
    expect(cockpitHtml(["nope"])).toBe(COCKPIT_HTML);
  });
});
