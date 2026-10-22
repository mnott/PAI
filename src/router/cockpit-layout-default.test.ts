import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportDefaultLayout, readDefaultLayout, saveDefaultLayout } from "./cockpit-layout-default.js";

const dir = mkdtempSync(join(tmpdir(), "pai-layout-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const layout = { v: 2, t: 5, tree: { k: "c", id: "a" }, kids: {}, st: {} };

describe("default layout file", () => {
  const state = join(dir, "state.json");
  const shipped = join(dir, "shipped.json");

  it("none saved: null, so the page composes its own", () => {
    expect(readDefaultLayout(state, shipped)).toBeNull();
  });

  it("a posted layout is saved and read back; garbage is refused", () => {
    expect(saveDefaultLayout("not json", state)).toBe(false);
    expect(saveDefaultLayout(JSON.stringify({ v: 2 }), state)).toBe(false);
    expect(existsSync(state)).toBe(false);
    expect(saveDefaultLayout(JSON.stringify(layout), state)).toBe(true);
    expect(readDefaultLayout(state, shipped)).toEqual(layout);
  });

  it("the saved default wins over the shipped one; the shipped one is the fallback", () => {
    writeFileSync(shipped, JSON.stringify({ ...layout, t: 9 }));
    expect(readDefaultLayout(state, shipped)?.t).toBe(5);
    expect(readDefaultLayout(join(dir, "none.json"), shipped)?.t).toBe(9);
  });

  it("export writes the saved default to the target only on the call", () => {
    const to = join(dir, "repo", "cockpit-layout.json");
    expect(existsSync(to)).toBe(false);
    expect(exportDefaultLayout({ stateFile: state, to })).toBe(to);
    expect(JSON.parse(readFileSync(to, "utf8"))).toEqual(layout);
    expect(() => exportDefaultLayout({ stateFile: join(dir, "none.json"), to })).toThrow(/no saved default/);
  });
});
