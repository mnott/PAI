/** Guard: every WIN_*_JS module under cockpit-page/win is in the served /cockpit page (a module that is
 *  defined but never assembled into the page script is dead code that looks wired). */

import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COCKPIT_HTML } from "./cockpit-page.js";

const dir = new URL("./cockpit-page/win/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const mods: [string, string][] = [];
for (const f of files) {
  const m = (await import(new URL(f.replace(/\.ts$/, ".js"), dir).href)) as Record<string, unknown>;
  for (const [k, v] of Object.entries(m)) if (/^WIN_.*_JS$/.test(k) && typeof v === "string") mods.push([k, v]);
}

describe("served cockpit page carries every win module", () => {
  it("finds the modules", () => expect(mods.length).toBeGreaterThanOrEqual(20));
  it.each(mods)("%s", (_name, src) => {
    const first = /^(?:var|function)\s+(\w+)/.exec(src.trimStart());
    expect(first, "module starts with a declaration").not.toBeNull();
    expect(COCKPIT_HTML).toMatch(new RegExp(`(?:var|function)\\s+${first![1]}\\b`));
    expect(COCKPIT_HTML).toContain(src);
  });
  it("starts the drag wiring", () => expect(COCKPIT_HTML).toContain("dragInit(document,window)"));
});
