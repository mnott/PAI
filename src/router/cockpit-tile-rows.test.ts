import { describe, expect, it } from "vitest";
import { COCKPIT_HTML } from "./cockpit-page.js";

/** The .rt-tiles grids must never leave a partial last row: the remainder rules live in the CSS. */
describe(".rt-tiles last row is always full", () => {
  const css = COCKPIT_HTML.match(/<style>[\s\S]*?<\/style>/g)!.join("");

  it("wide mode: 12 tracks, every tile spans 3", () => {
    expect(css).toMatch(/@container \(min-width:720px\)\{\.rt-tiles:not\(\.two\)\{grid-template-columns:repeat\(12,minmax\(0,1fr\)\)\}\.rt-tiles:not\(\.two\) \.mt\{grid-column:span 3\}/);
  });

  it("wide mode: remainder 1 — the lone tile spans the whole row", () => {
    expect(css).toContain(".rt-tiles:not(.two) .mt:last-child:nth-child(4n+1){grid-column:1/-1}");
  });

  it("wide mode: remainder 2 — the last two tiles span 6 each", () => {
    expect(css).toContain(".rt-tiles:not(.two) .mt:nth-last-child(2):nth-child(4n+1),.rt-tiles:not(.two) .mt:nth-last-child(2):nth-child(4n+1) ~ .mt{grid-column:span 6}");
  });

  it("wide mode: remainder 3 — the last three tiles span 4 each", () => {
    expect(css).toContain(".rt-tiles:not(.two) .mt:nth-last-child(3):nth-child(4n+1),.rt-tiles:not(.two) .mt:nth-last-child(3):nth-child(4n+1) ~ .mt{grid-column:span 4}");
  });

  it("2-column mode: an odd last tile spans the whole row, below the wide breakpoint", () => {
    expect(css).toMatch(/@container \(max-width:719px\)\{\.rt-tiles \.mt:last-child:nth-child\(odd\)\{grid-column:1\/-1\}\}/);
  });

  it(".rt-tiles.two: an odd last tile spans the whole row, at any width", () => {
    expect(css).toMatch(/\.rt-tiles\.two \.mt:last-child:nth-child\(odd\)\{grid-column:1\/-1\}/);
  });

  it("1-column mode: spans reset to auto", () => {
    expect(css).toMatch(/@container \(max-width:339px\)\{\.rt-tiles,\.rt-tiles\.two\{grid-template-columns:minmax\(0,1fr\)\}\.rt-tiles \.mt\{grid-column:auto\}\}/);
  });
});
