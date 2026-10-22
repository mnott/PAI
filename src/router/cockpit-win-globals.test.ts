/** The win block shares one script with the rest of the page: it may not declare any
 *  identifier the rest declares (a duplicate var/function silently replaces the other). */

import { describe, expect, it } from "vitest";
import { COCKPIT_HTML } from "./cockpit-page.js";
import { WIN_ACTIONS_JS } from "./cockpit-page/win/actions.js";
import { WIN_RUNTIME_JS } from "./cockpit-page/script-win.js";

const WIN_RE = /\/\*win-begin\*\/[\s\S]*?\/\*win-end\*\//;

/** Names declared by var/function statements at column 0 (incl. the `,b=` continuations of a var line). */
function declared(src: string): Set<string> {
  const out = new Set<string>();
  for (const line of src.split("\n")) {
    const m = /^(?:var|function)\s+(\w+)/.exec(line);
    if (!m) continue;
    out.add(m[1]);
    if (line.startsWith("var ")) for (const c of line.matchAll(/,\s*(\w+)\s*=/g)) out.add(c[1]);
  }
  return out;
}

describe("win block globals", () => {
  const block = COCKPIT_HTML.match(WIN_RE)![0].replace(WIN_RUNTIME_JS, "").replace(WIN_ACTIONS_JS, "");
  const oldNames = declared(COCKPIT_HTML.replace(WIN_RE, ""));
  const winNames = declared(block);

  it("the extraction sees both sides", () => {
    expect(oldNames.has("feed")).toBe(true);
    expect(winNames.has("Win")).toBe(true);
  });

  it("no identifier is declared by both the win block and the old page", () => {
    expect([...winNames].filter((n) => oldNames.has(n))).toEqual([]);
  });

  it("the IIFE-wrapped sources hold no text the old page tests slice by (var CONFIRM_MS=)", () => {
    expect(WIN_ACTIONS_JS).not.toContain("var CONFIRM_MS=");
    expect(WIN_RUNTIME_JS).not.toContain("var CONFIRM_MS=");
  });
});

// ---- C1 restored guard: config knobs the cards still read ----
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";
import { fnSrc, varSrc } from "./cockpit-page-src.js";

describe("C1 guards: layout knobs", () => {
  // w=5 config knobs: each knob that a card still reads moves that card's output, as the surviving gaugeMin/pollMs tests do (the dead ones are not asserted).
  let dir = "";
  const prev = process.env.PAI_CONFIG_FILE, prevHome = process.env.PAI_HOME;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pai-cockpit-knobs-")); process.env.PAI_CONFIG_FILE = join(dir, "config.json"); delete process.env.PAI_HOME; });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.PAI_CONFIG_FILE; else process.env.PAI_CONFIG_FILE = prev;
    if (prevHome === undefined) delete process.env.PAI_HOME; else process.env.PAI_HOME = prevHome;
  });
  const page = (layout: Record<string, number>) => {
    writeFileSync(join(dir, "config.yaml"), `router:\n  cockpit:\n    layout:\n${Object.entries(layout).map(([k, v]) => `      ${k}: ${v}`).join("\n")}\n`);
    return cockpitHtml();
  };
  const readings = (html: string) => {
    const spark = (new Function(`${fnSrc(html, "esc")}\n${fnSrc(html, "metricSpark")}\nreturn metricSpark;`)() as (s: unknown[]) => string)([{ data: [1, 2, 3] }]);
    const days = Number(/DAILY_DAYS=(\d+)/.exec(html)![1]);
    const th = new Function(`${varSrc(html, "ERROR_WARN")}\n${fnSrc(html, "cls")}\nreturn[ERROR_WARN,ERROR_BAD,cls(0.05,ERROR_WARN,ERROR_BAD)];`)() as [number, number, string];
    const job = new Function(`${varSrc(html, "JOB_TRIES_CFG")}\n${WIN_ACTIONS_JS}\nreturn[JOB_TRIES,JOB_POLL];`)() as [number, number];
    const bar = new Function(`${varSrc(html, "MIN_BAR_PX")}\n${fnSrc(html, "mergeFactor")}\nreturn mergeFactor(100,400,1);`)() as number;
    return { spark, days, th, job, bar };
  };
  it("sparkHeightPx, sparkViewMaxPx, dailyDays, errorWarn/errorBad, jobPollMs/jobMaxTries and minBarPx move their outputs", () => {
    const a = readings(page({})), b = readings(page({ sparkHeightPx: 40, sparkViewMaxPx: 200, dailyDays: 7, errorWarn: 0.06, errorBad: 0.5, jobPollMs: 777, jobMaxTries: 9, minBarPx: 10 }));
    expect(a.spark).toContain("100.0,");
    expect(a.spark).toContain(",32L");
    expect(b.spark).toContain("200.0,");
    expect(b.spark).toContain(",40L");
    expect([a.days, b.days]).toEqual([14, 7]);
    expect(a.th[2]).toBe("warn"); // 5% is above the default 2%
    expect(b.th).toEqual([0.06, 0.5, ""]); // and below the configured 6%
    expect(a.job).toEqual([120, 5000]);
    expect(b.job).toEqual([9, 777]); // the action runner polls with the configured policy
    expect(b.bar).toBeGreaterThan(a.bar);
  });
});

// ---- one owner: the modules of the win runtime share one scope; a function declared by two of them silently replaces the earlier one ----
import { WIN_TREE_JS } from "./cockpit-page/win/tree.js";
import { WIN_DROP_JS } from "./cockpit-page/win/drop.js";
import { WIN_LAYOUT_JS } from "./cockpit-page/win/layout.js";
import { WIN_MORPH_JS } from "./cockpit-page/win/morph.js";
import { WIN_STORE_JS } from "./cockpit-page/win/store.js";
import { WIN_INFO_JS } from "./cockpit-page/win/info.js";
import { WIN_CARD_JS } from "./cockpit-page/win/card.js";
import { WIN_ANCHOR_JS } from "./cockpit-page/win/anchor.js";
import { WIN_DRAGDROP_JS } from "./cockpit-page/win/dragdrop.js";

describe("win runtime modules: one owner per function", () => {
  const mods: Record<string, string> = {
    tree: WIN_TREE_JS, drop: WIN_DROP_JS, layout: WIN_LAYOUT_JS, morph: WIN_MORPH_JS, store: WIN_STORE_JS,
    info: WIN_INFO_JS, card: WIN_CARD_JS, anchor: WIN_ANCHOR_JS, dragdrop: WIN_DRAGDROP_JS,
  };
  it("the runtime is exactly these modules", () => {
    expect(WIN_RUNTIME_JS).toBe(Object.values(mods).join("\n"));
  });
  it("no function is declared by two modules", () => {
    const owners = new Map<string, string[]>();
    for (const [mod, src] of Object.entries(mods)) {
      for (const line of src.split("\n")) {
        const m = /^function\s+(\w+)/.exec(line);
        if (m) owners.set(m[1], [...(owners.get(m[1]) ?? []), mod]);
      }
    }
    expect(owners.get("moveCard")).toEqual(["drop"]);
    expect([...owners].filter(([, v]) => new Set(v).size > 1).map(([k, v]) => `${k}: ${v.join(",")}`)).toEqual([]);
  });
});
