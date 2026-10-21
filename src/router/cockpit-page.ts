/**
 * cockpit-page.ts — the single static page served at /cockpit. Inline CSS,
 * inline JS, inline SVG; no build step, no dependency. The script uses no
 * inline JS, inline SVG; no build step, no dependency. The script uses no
 * template literals; the page source is split into modules under ./cockpit-page/.
 */

import { cockpitLayout, type CockpitLayout } from "./cockpit-layout.js";
import { COCKPIT_FAVICON_DATA_URI, COCKPIT_FAVICON_SVG } from "./cockpit-page/favicon.js";
import { shellHead, shellBody } from "./cockpit-page/shell.js";
import { css } from "./cockpit-page/css.js";
import { scriptCore } from "./cockpit-page/script-core.js";
import { scriptModels } from "./cockpit-page/script-models.js";
import { scriptCharts } from "./cockpit-page/script-charts.js";
import { scriptTables } from "./cockpit-page/script-tables.js";
import { scriptBoot } from "./cockpit-page/script-boot.js";

export { COCKPIT_FAVICON_SVG, COCKPIT_FAVICON_DATA_URI };


/** The page, built with one layout policy object (router.cockpit.layout in the
 *  config defaults, user config wins). `${L.x}` interpolations bake the values
 *  into the static HTML/JS at module load; cockpitHtml() rebuilds the page from
 *  a layout read at call time, so a user override changes the served page. */
function buildHtml(L: CockpitLayout): string {
  // the page's inline JS interpolates only numbers and quoted strings, so no
  // interpolation can break out of the script; String.raw keeps the page's own
  // backslash sequences verbatim
  const n = (v: number): string => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`cockpit layout: ${v} is not a positive number`);
    return String(v);
  };
  const q = (v: string): string => {
    if (typeof v !== "string" || !v || !/^[\w -]+$/.test(v)) throw new Error(`cockpit layout: ${JSON.stringify(v)} is not a safe label`);
    return JSON.stringify(v);
  };
  // a #rrggbb colour, JSON-quoted for the page's inline JS
  const hex = (v: string): string => {
    if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error(`cockpit layout: ${JSON.stringify(v)} is not a #rrggbb colour`);
    return JSON.stringify(v);
  };
  const parts = [shellHead, css, shellBody, scriptCore, scriptModels, scriptCharts, scriptTables, scriptBoot];
  return parts.map((p) => p(L, n, q, hex)).join("");
}

/** Stable ids of the page's top-level sections, in page order (config key router.cockpit.sections). */
export const COCKPIT_SECTION_IDS = ["cloud", "routing", "workers", "pool", "models", "system", "kpis", "tokens", "cache", "speed", "pause", "sessions", "runs", "daily"] as const;

/** The full page: every section, built once at module load from the config defaults. */
export const COCKPIT_HTML = buildHtml(cockpitLayout());

/**
 * The page with only the listed sections, in the listed order. Unlisted sections are cut out of the
 * HTML (no DOM) and the script skips their fetches. Undefined or empty list = the full page; unknown ids are ignored
 * (all unknown = full page, so a typo never yields a blank cockpit). The layout policy is re-read
 * on every call, so a user config override changes the served page.
 */
export function cockpitHtml(sections?: readonly string[]): string {
  const full = buildHtml(cockpitLayout());
  const want = (sections ?? []).filter((id) => (COCKPIT_SECTION_IDS as readonly string[]).includes(id));
  if (!want.length) return full;
  const re = /<section data-section="([a-z]+)"[\s\S]*?<\/section>\n?/g;
  const found = new Map<string, string>();
  const [head, rest] = [full.slice(0, full.indexOf("<main>") + 7), full.slice(full.indexOf("<main>") + 7)];
  const tail = rest.slice(rest.indexOf("</main>"));
  for (const m of rest.slice(0, rest.indexOf("</main>")).matchAll(re)) found.set(m[1]!, m[0].endsWith("\n") ? m[0] : m[0] + "\n");
  return head + [...new Set(want)].map((id) => found.get(id) ?? "").join("") + tail;
}
