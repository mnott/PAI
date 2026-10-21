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
