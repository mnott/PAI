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
      "lim", "$", "esc", "gauge", "ago", "dur", "mdl", "modelsHtml", "actRow", "wireAct", "loadLimits", "document",
      `${body}\nrenderLimits();`
    );
    const lim = {
      limits: [
        { provider: "up1", kind: "local", up: true, served: ["m"] },
        ...Array.from({ length: 18 }, (_, i) => ({ provider: `dead${i}`, kind: "local", up: false })),
      ],
    };
    fn(lim, (id: string) => els[id], (s: string) => s, () => "", () => "", () => "", null, () => "",
      (_cls: string, _attrs: string, btns: string) => btns, () => {}, () => {}, { querySelectorAll: () => [] });
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
    COCKPIT_HTML.match(/function shortModel\([\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function actRow[\s\S]*?\n\}/)![0],
    COCKPIT_HTML.match(/function gb\(b,d\)\{[^\n]*\}/)![0],
    COCKPIT_HTML.match(/function gbm\(m\)\{[^\n]*\}/)![0],
    COCKPIT_HTML.match(/function modelsHtml[\s\S]*?\n\}/)![0],
  ].join("\n");
  const modelsHtml = new Function("esc", "pct", `${src}; return modelsHtml;`)(
    (s: unknown) => String(s ?? ""),
    (x: number) => (x * 100).toFixed(1) + "%"
  ) as (inv: unknown) => string;
  const inv = {
    at: "2026-10-19T18:00:00.000Z",
    runtimes: [
      { name: "gyro-m", kind: "strata", status: "running", port: 8035, users: ["worker:flashnext-iq3"], models: [{ model: "flash-next", kind: "coding", loaded: true, memoryMb: 50000, mappedMb: 40030, usedBy: ["worker:flashnext-iq3"] }] },
      { name: "ollama", kind: "ollama", status: "idle", port: 11434, users: ["pai-embedding", "paperfull-llm"], models: [
        { model: "huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16", kind: "embedding", loaded: true, memoryMb: 600, sizeMb: 600, usedBy: ["pai-embedding"] },
        { model: "qwen3:8b", kind: "chat", loaded: false, sizeMb: 4792, usedBy: ["paperfull-llm"] },
      ] },
      { name: "coder", kind: "strata", status: "stopped", port: 8036, users: ["worker:gyro"], models: [] },
    ],
    duplicates: ["embedding runs on 2 runtimes: a + b"],
    live: {
      at: 1,
      runtimes: [
        { name: "gyro-m", status: "running", live: { engine: { decode: 73.4, prefill: 715, phase: "idle", parked: 2, slots: 4, reusedPct: 90, lastDecode: 73.4, lastPrompt: 155000, lastReused: 150000, lastPromptMs: 5000, lastUsed: 155500, gpuMemUsed: 1530000000, gpuMemTotal: 115964116992, maxContext: 262144, liveUsed: null }, rssMb: 36148, workers: [{ id: "w-1", label: "fix-x", session: "PAI", state: "running" }], queued: 2, cap: 1, conversationSlots: 4, sparesReady: 1, sparesConfig: 1 }, history: { decode: [70, null, 73.4], prefill: [700, null, 715], memoryMb: [49000, 50000, 50000], queued: [0, 1, 2], pressurePct: [60, 61, 62] } },
        { name: "ollama", status: "idle", live: { engine: null, workers: [], queued: 0, cap: 1, conversationSlots: null, sparesReady: 0, sparesConfig: 1 }, history: { decode: [], prefill: [], memoryMb: [], queued: [], pressurePct: [] } },
      ],
    },
  };
  const cards = (h: string) => h.match(/<div class="rt-card">[\s\S]*?<\/div>\s*(?=<div class="rt-card">|<\/div>|$)/g) ?? [];

  it("one card per running runtime: header, kind badge, status dot, four metric tiles", () => {
    const h = modelsHtml(inv);
    expect((h.match(/<div class="rt-card">/g) ?? []).length).toBe(2);
    expect(h).toContain('<b title="flash-next">flash-next</b>');
    // kind differs from the name: one separate kind chip, the name shows once
    expect(h).toContain('<span class="badge">strata</span><span class="badge">gyro-m :8035</span>');
    expect(h).toContain("gyro-m :8035");
    expect(h).toContain("used by worker:flashnext-iq3");
    expect(h).toContain('<span class="rt-dot"></span>');
    expect(h).toContain('<span class="rt-dot idle"></span>');
    for (const t of ["Speed", "Memory", "Workers", "Conversation cache"]) expect(h).toContain(t);
    expect(h).toContain("73.4");
    expect(h).toContain("715");
    expect(h).toContain("Decode last request");
    expect(h).toContain("Prefill last request");
    expect(h).toContain("35.3<small>GB</small>");
    // every GB on the card is binary (1024^3), the same rounding as Strata's monitor:
    // 115964116992 bytes = 108 GB (not 115), 1.53e9 bytes = 1.4 GB (not 1.5)
    expect(h).toContain("RAM 35.3 GB · GPU 1.4 / 108 GB");
    expect(h).toContain("39.1 GB file mapped");
    expect(h).toContain("reused 90.0% of prompt tokens");
    expect(h).toContain("2<small>/ 4</small>");
    expect(h).toContain("59% · 156k / 256K");
    expect(h).toContain("queued 2");
    expect(h).toContain("cap 1 · queued 2 · slots 4 · spares 1");
    expect(h).toContain("machine pressure 62%");
  });
  it("a generating engine reads like Strata's monitor: Decode now / Prefill this request, context from the running request", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "strata", kind: "strata", status: "running", port: 8035, users: [], models: [{ model: "m", kind: "coding", loaded: true, memoryMb: 50000, usedBy: [] }] }],
      live: { at: 1, runtimes: [{ name: "strata", status: "running", live: { engine: { decode: 78.04, prefill: 101.8, phase: "generating", parked: 4, slots: 4, reusedPct: 98.8, lastDecode: 50.9, lastPrompt: null, lastReused: null, lastPromptMs: null, lastUsed: null, gpuMemUsed: 45576978432, gpuMemTotal: 115448725504, maxContext: 262144, liveUsed: 155000 }, rssMb: 36148, workers: [], queued: 0, cap: 1, conversationSlots: 4, sparesReady: 0, sparesConfig: 1 }, history: {} }] },
    });
    expect(h).toContain("78.0"); // decode: 1 decimal, as Strata
    expect(h).toContain("102"); // prefill: integer, as Strata
    expect(h).toContain("Decode now");
    expect(h).toContain("Prefill this request");
    expect(h).toContain("59% · 155k / 256K");
    expect(h).toContain('class="mt-bar"');
    expect(h).toMatch(/mt-bar[^>]*><i style="width:59\.1%"/);
  });
  it("GB on the Memory tile is binary (1024^3) like the engine: 115964116992 bytes render as 108, 1.53e9 as 1.4", () => {
    const h = modelsHtml({
      at: "x",
      runtimes: [{ name: "strata", kind: "strata", status: "running", port: 8035, users: [], models: [{ model: "m", kind: "coding", loaded: true, memoryMb: 1, usedBy: [] }] }],
      live: { at: 1, runtimes: [{ name: "strata", status: "running", live: { engine: { decode: null, prefill: null, phase: "idle", parked: null, slots: null, reusedPct: null, lastDecode: null, lastPrompt: null, lastReused: null, lastPromptMs: null, lastUsed: null, gpuMemUsed: 1530000000, gpuMemTotal: 115964116992, maxContext: null, liveUsed: null }, rssMb: null, workers: [], queued: 0, cap: null, conversationSlots: null, sparesReady: 0, sparesConfig: 0 }, history: {} }] },
    });
    expect(h).toContain("GPU 1.4 / 108 GB");
    expect(h).not.toContain("115");
    expect(h).not.toContain("1.5");
  });
  it("the context fill is the secondary value with a small bar on the Conversation cache tile", () => {
    const h = modelsHtml(inv);
    const cache = h.slice(h.indexOf("Conversation cache"));
    expect(cache).toContain('class="mt-fill"');
    expect(cache).toContain("59% · 156k / 256K");
    expect(cache).toContain('style="width:59.3%"');
  });
  it("sparklines carry the history; a runtime with a loaded model keeps all four tiles and – only where the engine does not report", () => {
    const h = modelsHtml(inv);
    const strata = h.slice(h.indexOf('<b title="flash-next">flash-next</b>'), h.indexOf("<b title=\"huggingface.co/"));
    expect(strata.match(/<path class="line/g)!.length).toBeGreaterThanOrEqual(4);
    const ollama = h.slice(h.indexOf('<b title="huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16">multilingual-e5-base-gguf-f16</b>'));
    for (const t of ["Speed", "Memory", "Workers", "Conversation cache"]) expect(ollama).toContain(t);
    expect(ollama).toContain("–");
    expect(ollama).toContain("prompt reuse not reported");
    expect(ollama).toContain("spares 0");
  });
  it("sparklines never break: a null point is interpolated between neighbours into one continuous line; leading/trailing nulls drop", () => {
    const spark = new Function("esc", `${COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0]}; return metricSpark;`)((s: unknown) => String(s ?? "")) as (s: Array<{ data: Array<number | null> }>) => string;
    const svg = spark([{ data: [10, null, 20] }]);
    // one continuous line: a single path, three points, the middle one interpolated at 15
    expect(svg.match(/<path class="line/g)!.length).toBe(1);
    const pts = svg.match(/class="line[^"]*"[^>]*d="M([\d.,L-]+)"/)![1].split("L");
    expect(pts.length).toBe(3);
    expect(pts[1]).toBe("50.0,9.0"); // x mid, y = 30 - 15/20*28 (interpolated 15 between 10 and 20)
    // leading/trailing nulls drop; the line spans the two real points
    const trimmed = spark([{ data: [null, 10, 20, null] }]);
    const tpts = trimmed.match(/class="line[^"]*"[^>]*d="M([\d.,L-]+)"/)![1].split("L");
    expect(tpts.length).toBe(2);
    // x keeps the full-array scale (n=4): points 1 and 2 sit at 33.3 and 66.7
    expect(tpts[0].startsWith("33.3")).toBe(true);
    expect(tpts[1].startsWith("66.7")).toBe(true);
    // all-null series draws nothing
    expect(spark([{ data: [null, null] }])).toBe("");
  });
  it("a long model id renders its short name (last path segment) with the full id in title", () => {
    const h = modelsHtml(inv);
    expect(h).toContain('<b title="huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16">multilingual-e5-base-gguf-f16</b>');
    expect(h).not.toContain("<b>huggingface.co/");
  });
  it("an idle runtime with nothing loaded is a compact card: header + Memory/size + users, no empty Speed/cache tiles", () => {
    const h = modelsHtml({
      at: "2026-10-19T18:00:00.000Z",
      runtimes: [{ name: "docker-model-runner", kind: "docker", status: "idle", port: 8090, users: ["worker:x"], models: [{ model: "qwen3:8b", kind: "chat", loaded: false, sizeMb: 4792 }] }],
      live: { at: 1, runtimes: [] },
    });
    expect((h.match(/<div class="rt-card">/g) ?? []).length).toBe(1);
    expect(h).toContain("Memory / size");
    expect(h).toContain("4.7 GB");
    expect(h).toContain("Users");
    expect(h).toContain("used by worker:x");
    expect(h).not.toContain("Conversation cache");
    expect(h).not.toContain("Speed");
    expect(h).not.toContain("–");
  });
  it("the runtime name never repeats: a kind equal to the name (or name:port) shows no kind chip", () => {
    const h = modelsHtml(inv);
    // strata kind on a runtime named gyro-m: one kind chip; the name appears once in the header
    const strataHead = h.slice(h.indexOf('<b title="flash-next">flash-next</b>'), h.indexOf('<div class="rt-sub'));
    expect(strataHead).toContain('<span class="badge">strata</span><span class="badge">gyro-m :8035</span>');
    expect(strataHead).not.toContain('<span class="badge">gyro-m :8035</span><span class="badge">gyro-m<');
    const dup = modelsHtml({
      at: "x",
      runtimes: [{ name: "docker-model-runner", kind: "docker-model-runner", status: "idle", port: 8090, users: [], models: [{ model: "qwen3:8b", kind: "chat", loaded: false, sizeMb: 4792 }] }],
      live: { at: 1, runtimes: [] },
    });
    // kind equals the runtime name: no kind chip at all, the name shows once in the header
    const dupHead = dup.slice(dup.indexOf('<div class="rt-head">'), dup.indexOf('<div class="rt-sub'));
    expect((dupHead.match(/<span class="badge">[^<]*<\/span>/g) ?? []).length).toBe(2); // runtime chip + status chip, no kind chip
    expect(dupHead).toContain('<span class="badge">docker-model-runner :8090</span>');
    expect(dupHead).not.toContain('<span class="badge">docker-model-runner</span><span class="badge">docker-model-runner');
    const fold = modelsHtml({
      at: "x",
      runtimes: [{ name: "e5", kind: "e5 :8090", status: "idle", port: 8090, users: [], models: [{ model: "qwen3:8b", kind: "chat", loaded: false, sizeMb: 4792 }] }],
      live: { at: 1, runtimes: [] },
    });
    expect(fold).toContain('<span class="badge">e5 :8090</span>');
    expect(fold).not.toContain('<span class="badge">e5 :8090</span><span class="badge">e5 :8090');
  });
  it("worker chips name the sessions with workers on the runtime", () => {
    const h = modelsHtml(inv);
    expect(h).toContain("fix-x");
    expect(h).toContain("<b>PAI</b>");
  });
  it("stopped runtimes are one chip each, no tables, no horizontal scroll; a runtime with a card is never repeated as a chip", () => {
    const h = modelsHtml(inv);
    expect(h).not.toContain("<table");
    expect(h).not.toContain('class="tw"');
    expect(h).not.toContain("<details");
    expect(h).toContain('<span class="chip" title="coder :8036 · used by worker:gyro">coder :8036 · used by worker:gyro</span>');
    expect(h).not.toContain("not loaded:");
    expect(h).toContain("duplicates: embedding runs on 2 runtimes");
    // the chips live after the grid closes: they name only runtimes without a card
    const chips = h.slice(h.indexOf('class="rt-chips dim"'));
    expect(chips).not.toContain("gyro-m");
    expect(chips).not.toContain("ollama");
    expect(chips).toContain("coder");
  });
  it("the grid follows the container at any width: cards share the row, tiles sit in one row, chips ellipsize", () => {
    expect(COCKPIT_HTML).toContain(".rt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));gap:8px;min-width:0;align-items:stretch}");
    expect(COCKPIT_HTML).toContain(".rt-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;min-width:0}");
    // four tiles in one row only when the card itself is wide; a balanced 2x2 below 720px,
    // one column under ~340px — explicit columns per range via a container query on the card, never 3+1
    expect(COCKPIT_HTML).toMatch(/\.rt-card\{[^}]*container-type:inline-size/);
    expect(COCKPIT_HTML).toMatch(/@container \(min-width:720px\)\{\.rt-tiles\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}/);
    expect(COCKPIT_HTML).toMatch(/@container \(max-width:339px\)\{\.rt-tiles,\.rt-tiles\.two\{grid-template-columns:minmax\(0,1fr\)\}\}/);
    // sparklines align at the bottom of every tile; value + unit never break apart
    expect(COCKPIT_HTML).toMatch(/\.mt-spark\{[^}]*margin-top:auto[^}]*\}/);
    expect(COCKPIT_HTML).toMatch(/\.mt-value\{[^}]*white-space:nowrap/);
    expect(COCKPIT_HTML).toMatch(/\.rt-card\{[^}]*min-width:0[^}]*max-width:100%/);
    // header on one line: the name ellipsises, chips stay inline; the used-by line ellipsises too
    expect(COCKPIT_HTML).toMatch(/\.rt-head\{[^}]*flex-wrap:nowrap\}/);
    expect(COCKPIT_HTML).toMatch(/\.rt-head b\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
    expect(COCKPIT_HTML).toMatch(/\.rt-sub\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
    // each chip is its own item, ellipsised, never wider than the card
    expect(COCKPIT_HTML).toMatch(/\.rt-chips\{[^}]*flex-wrap:wrap[^}]*min-width:0\}/);
    expect(COCKPIT_HTML).toMatch(/\.rt-chips \.chip\{[^}]*max-width:100%[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
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
    // a null point is interpolated: each series is one continuous path (no second M)
    expect(html).not.toMatch(/d="M[^"]*M/);
  });
  it("a fill renders a small bar and its text line between the values and the sparkline", () => {
    const src = [COCKPIT_HTML.match(/function metricSpark[\s\S]*?\n\}/)![0], COCKPIT_HTML.match(/function metricTile[\s\S]*?\n\}/)![0]].join("\n");
    const tile = new Function("esc", `${src}\nreturn metricTile;`)((s: unknown) => String(s ?? "")) as (o: unknown) => string;
    const html = tile({ title: "Conversation cache", value: 4, unit: "/ 4", sub: "reused 98.8% of prompt tokens", fill: { pct: 59.1, text: "59% · 155k / 256K" }, series: [] });
    expect(html).toContain('class="mt-fill"');
    expect(html).toContain('style="width:59.1%"');
    expect(html).toContain("59% · 155k / 256K");
    expect(html.indexOf("mt-fill")).toBeLessThan(html.indexOf("mt-spark"));
    expect(COCKPIT_HTML).toMatch(/\.mt-spark\{[^}]*margin-top:auto[^}]*\}/);
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
