import { describe, expect, it } from "vitest";
import { COCKPIT_FAVICON_SVG, COCKPIT_HTML } from "./cockpit-page.js";

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
    expect(COCKPIT_HTML).toMatch(/\.grp-cloud\{flex:1 1 560px\}/);
    expect(COCKPIT_HTML).toMatch(/\.grp-local\{flex:0 1 auto;width:min-content;min-width:200px;max-width:34%\}/);
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
    expect(at("local: flashnext-iq3 (cap 1)")).toBeGreaterThanOrEqual(0);
    expect(at("local: flashnext-iq3 (cap 1)")).toBeLessThan(at("AIBroker <span"));
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

describe("cockpit LOCAL models section", () => {
  const modelsHtml = new Function("esc", "table", `${COCKPIT_HTML.match(/function modelsHtml[\s\S]*?\n\}/)![0]}; return modelsHtml;`)(
    (s: unknown) => String(s ?? ""),
    (h: string[], rows: unknown[][]) => `T[${h.join(",")}]${rows.map((r) => r.join("|")).join(";")}`
  ) as (inv: unknown) => string;
  const inv = {
    runtimes: [
      { name: "ollama", status: "running", port: 11434, users: ["pai-embedding"], models: [{ model: "arctic", kind: "embedding", loaded: true, memoryMb: 600, usedBy: ["pai-embedding"] }] },
      { name: "coder", status: "stopped", port: 8034, users: [], models: [] },
    ],
    duplicates: ["embedding runs on 2 runtimes: a + b"],
  };
  it("lists running runtimes with memory and users, collapses stopped, shows duplicates", () => {
    const h = modelsHtml(inv);
    expect(h).toContain("ollama|arctic|embedding|600 MB|pai-embedding|11434");
    expect(h).toContain("duplicates: embedding runs on 2 runtimes");
    expect(h).toContain("1 runtime stopped");
    expect(h).not.toContain("<td>coder");
  });
});
