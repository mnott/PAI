/** Registry editor YAML highlighting (win/cards-registry.ts wrgHl): pure tokenizer, line parity with the textarea, speed. */

import { describe, expect, it } from "vitest";
import { WIN_REGISTRY_JS } from "./cockpit-page/win/cards-registry.js";

type Hl = { wrgHlLine: (l: string) => string; wrgHl: (t: string) => string };
function lib(): Hl {
  const stubs = `var Win={registerType:function(){},el:function(){return null},ctx:function(){return null},update:function(){}};
var WinT={leaf:function(){},split:function(){}};var WIN_HOST=null;function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;")}`;
  return new Function(`${stubs}\n${WIN_REGISTRY_JS}\nreturn{wrgHlLine:wrgHlLine,wrgHl:wrgHl};`)() as Hl;
}
const { wrgHlLine, wrgHl } = lib();
const plain = (h: string) => h.replace(/<[^>]*>/g, "");

describe("registry yaml highlight", () => {
  it("comment with quotes inside is one comment", () => {
    const h = wrgHlLine(`  # it's "quoted" text`);
    expect(h).toBe(`  <span class="wrg-c"># it's &quot;quoted&quot; text</span>`);
  });
  it("key with list value", () => {
    expect(wrgHlLine("  args: [a, 8101]")).toContain(`<span class="wrg-k">args</span>:`);
    expect(wrgHlLine("  args: [a, 8101]")).toContain(`<span class="wrg-n">8101</span>`);
    const d = wrgHlLine("    - name: x");
    expect(d).toContain(`<span class="wrg-d">-</span>`);
    expect(d).toContain(`<span class="wrg-k">name</span>`);
  });
  it("quoted # is not a comment, trailing comment is", () => {
    const h = wrgHlLine(`url: "http://x/#a" # note`);
    expect(h).toContain(`<span class="wrg-s">&quot;http://x/#a&quot;</span>`);
    expect(h).toContain(`<span class="wrg-c"># note</span>`);
    expect(wrgHlLine("url: http://x/#a")).not.toContain("wrg-c");
  });
  it("booleans, null, numbers, anchors", () => {
    expect(wrgHlLine("a: true")).toContain(`<span class="wrg-b">true</span>`);
    expect(wrgHlLine("a: null")).toContain(`<span class="wrg-b">null</span>`);
    expect(wrgHlLine("a: ~")).toContain(`<span class="wrg-b">~</span>`);
    expect(wrgHlLine("a: 1.5e3")).toContain(`<span class="wrg-n">1.5e3</span>`);
    expect(wrgHlLine("a: &base")).toContain(`<span class="wrg-a">&amp;base</span>`);
    expect(wrgHlLine("b: *base")).toContain(`<span class="wrg-a">*base</span>`);
    expect(wrgHlLine("a: truest")).not.toContain("wrg-b");
  });
  it("highlight layer keeps text and line count", () => {
    const t = Array.from({ length: 800 }, (_, i) => (i % 4 === 0 ? `  # comment ${i} with "q" and 'x'` : i % 4 === 1 ? `  name${i}:` : i % 4 === 2 ? `    port: ${8000 + i}  # p` : `    - &a${i} 'str' true`)).join("\n");
    const h = wrgHl(t);
    expect(plain(h).replace(/&amp;/g, "&").replace(/&quot;/g, '"').split("\n").length).toBe(t.split("\n").length + 1);
    expect(h.split("\n").length).toBe(t.split("\n").length + 1);
    expect(plain(h).replace(/&amp;/g, "&").replace(/&quot;/g, '"')).toBe(t + "\n");
  });
  it("800 lines tokenize fast", () => {
    const t = Array.from({ length: 800 }, (_, i) => `  key${i}: "value ${i}" # trailing comment, 'quoted' ${i}`).join("\n");
    wrgHl(t);
    const runs: number[] = [];
    for (let r = 0; r < 20; r++) {
      const s = performance.now();
      wrgHl(t);
      runs.push(performance.now() - s);
    }
    runs.sort((a, b) => a - b);
    console.log(`tokenizer 800 lines: median ${runs[10]!.toFixed(2)} ms, max ${runs[19]!.toFixed(2)} ms`);
    expect(runs[10]!).toBeLessThan(5);
  });
});
