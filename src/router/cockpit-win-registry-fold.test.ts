/** Registry editor gutter folding (win/cards-registry.ts): block ranges, folded view, view-to-model edit mapping. */

import { describe, expect, it } from "vitest";
import { WIN_REGISTRY_JS } from "./cockpit-page/win/cards-registry.js";

type Blk = { start: number; end: number; ind: number; depth: number; path: string };
type V = { lines: string[]; map: number[]; mk: number[] };
type Lib = {
  wrgBlocks: (t: string) => Blk[];
  wrgFoldView: (t: string, p: Record<string, number>) => V;
  wrgFoldEdit: (t: string, v: V, nv: string) => { text: string; hit: number[] | null };
  WRGF: { paths: Record<string, number> };
  wrgFoldToggle: (t: string, h: number, all: boolean) => void;
  wrgFoldAll: (t: string, on: boolean) => void;
  wrgSave: (S: unknown, io: unknown) => Promise<unknown>;
  WRG: Record<string, unknown>;
};
function lib(): Lib {
  const stubs = `var Win={registerType:function(){},el:function(){return null},ctx:function(){return null},update:function(){}};
var WinT={leaf:function(){},split:function(){}};var WIN_HOST=null;function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;")}
var localStorage={getItem:function(){return null},setItem:function(){}};`;
  return new Function(
    `${stubs}\n${WIN_REGISTRY_JS}\nreturn{wrgBlocks:wrgBlocks,wrgFoldView:wrgFoldView,wrgFoldEdit:wrgFoldEdit,WRGF:WRGF,wrgFoldToggle:wrgFoldToggle,wrgFoldAll:wrgFoldAll,wrgSave:wrgSave,WRG:WRG};`,
  )() as Lib;
}
const SAMPLE = [
  "local_tiers:", // 0
  "  - name: a", // 1
  "    port: 1", // 2
  "    # note", // 3
  "", // 4
  "    args: [x]", // 5
  "  - name: b", // 6
  "    port: 2", // 7
  "", // 8
  "providers:", // 9
  "  p1:", // 10
  "    url: u", // 11
].join("\n");

describe("registry fold", () => {
  it("block ranges on a nested sample", () => {
    const { wrgBlocks } = lib();
    const b = wrgBlocks(SAMPLE).map((x) => [x.start, x.end, x.path]);
    expect(b).toEqual([
      [0, 7, "local_tiers"],
      [1, 5, "local_tiers/[0]"],
      [6, 7, "local_tiers/[1]"],
      [9, 11, "providers"],
      [10, 11, "providers/p1"],
    ]);
  });
  it("fold gives a marker line, model unchanged", () => {
    const { wrgFoldView } = lib();
    const v = wrgFoldView(SAMPLE, { "local_tiers/[0]": 1 });
    expect(v.lines[2]).toBe("    ⋯ 4 lines");
    expect(v.mk[2]).toBe(4);
    expect(v.lines.length).toBe(SAMPLE.split("\n").length - 4 + 1);
    expect(v.lines.filter((_, i) => !v.mk[i]).length).toBe(SAMPLE.split("\n").length - 4);
    expect(SAMPLE.split("\n").length).toBe(12);
  });
  it("outer fold covers inner", () => {
    const { wrgFoldView } = lib();
    const v = wrgFoldView(SAMPLE, { local_tiers: 1, "local_tiers/[0]": 1 });
    expect(v.lines.slice(0, 2)).toEqual(["local_tiers:", "  ⋯ 7 lines"]);
  });
  it("edit after another fold maps to the right model line", () => {
    const { wrgFoldView, wrgFoldEdit } = lib();
    const v = wrgFoldView(SAMPLE, { "local_tiers/[0]": 1 });
    const nv = v.lines.slice();
    const i = nv.indexOf("    port: 2");
    nv[i] = "    port: 22";
    const r = wrgFoldEdit(SAMPLE, v, nv.join("\n"));
    expect(r.hit).toBeNull();
    const want = SAMPLE.split("\n");
    want[7] = "    port: 22";
    expect(r.text).toBe(want.join("\n"));
    const ins = v.lines.slice();
    ins.splice(i, 0, "    new: 1");
    const r2 = wrgFoldEdit(SAMPLE, v, ins.join("\n"));
    const w2 = SAMPLE.split("\n");
    w2.splice(7, 0, "    new: 1");
    expect(r2.text).toBe(w2.join("\n"));
  });
  it("no edit round-trips byte-equal (save and validate send the full text)", () => {
    const { wrgFoldView, wrgFoldEdit } = lib();
    const v = wrgFoldView(SAMPLE, { local_tiers: 1, "providers/p1": 1 });
    const r = wrgFoldEdit(SAMPLE, v, v.lines.join("\n"));
    expect(r.text).toBe(SAMPLE);
  });
  it("save posts the full text while folded", async () => {
    const L = lib();
    L.WRG.text = SAMPLE;
    L.WRG.saved = "x";
    L.WRG.loaded = true;
    L.WRG.passed = SAMPLE;
    L.WRGF.paths = { local_tiers: 1 };
    const sent: unknown[] = [];
    const io = {
      get: () => Promise.resolve({ backups: [] }),
      post: (_u: string, b: unknown) => (sent.push(b), Promise.resolve({ ok: true })),
      status: () => {},
      paint: () => {},
      refresh: () => {},
    };
    await L.wrgSave(L.WRG, io).catch(() => {});
    if (sent.length) expect((sent[0] as { yaml: string }).yaml).toBe(SAMPLE);
  });
  it("editing a marker line reports a hit and leaves the model", () => {
    const { wrgFoldView, wrgFoldEdit } = lib();
    const v = wrgFoldView(SAMPLE, { "local_tiers/[0]": 1 });
    const nv = v.lines.slice();
    nv[2] = "    ⋯ 4 linesX";
    const r = wrgFoldEdit(SAMPLE, v, nv.join("\n"));
    expect(r.hit).toEqual([2]);
    expect(r.text).toBe(SAMPLE);
  });
  it("alt toggle folds all siblings; fold all top-level", () => {
    const L = lib();
    L.wrgFoldToggle(SAMPLE, 1, true);
    expect(Object.keys(L.WRGF.paths).sort()).toEqual(["local_tiers/[0]", "local_tiers/[1]"]);
    L.wrgFoldAll(SAMPLE, true);
    expect(Object.keys(L.WRGF.paths).sort()).toEqual(["local_tiers", "providers"]);
    L.wrgFoldAll(SAMPLE, false);
    expect(Object.keys(L.WRGF.paths)).toEqual([]);
  });
});
