/** liveWrite is the one owner of live DOM writes: it holds the first tile at or below the viewport top
 *  at the same offset across a write, and logs scroll moves behind ?debug=scroll. */

import { describe, expect, it } from "vitest";
import { cockpitHtml } from "./cockpit-page.js";

const html = cockpitHtml();
const start = html.indexOf("var scrollWhy=");
const end = html.indexOf("function setHtml(el,html)");

type Box = { top: number; connected: boolean; getBoundingClientRect(): { top: number }; getAttribute(n: string): string | null; contains(o: unknown): boolean };

function harness(search = "") {
  const state = { scrollY: 500, logs: [] as string[] };
  const mk = (top: number, tid: string | null = null): Box => ({ top, connected: true, getBoundingClientRect() { return { top: this.top - state.scrollY }; }, getAttribute: (n) => (n === "data-tid" ? tid : null), contains: () => false, ...{ isConnected: true } });
  const cards = [mk(100), mk(600), mk(900)];
  const win = { get scrollY() { return state.scrollY; }, scrollX: 0, addEventListener() {}, scrollTo(o: { top: number }) { state.scrollY = o.top; } };
  const doc = { querySelectorAll: () => cards };
  const loc = { search };
  const f = new Function("window", "document", "location", "console", `${html.slice(start, end)};return liveWrite`);
  return { state, cards, liveWrite: f(win, doc, loc, { log: (m: string) => state.logs.push(m) }) as (el: unknown, w: () => unknown, why?: string) => unknown };
}

describe("liveWrite", () => {
  it("keeps the first card at or below the viewport top where it was when a write moves it", () => {
    const h = harness();
    const el = { contains: () => false };
    h.liveWrite(el, () => { h.cards[1]!.top += 240; h.cards[2]!.top += 240; }, "t");
    expect(h.state.scrollY).toBe(740);
    expect(h.cards[1]!.getBoundingClientRect().top).toBe(100);
  });
  it("leaves the scroll alone when nothing moved, and returns the write's result", () => {
    const h = harness();
    expect(h.liveWrite({ contains: () => false }, () => 7, "t")).toBe(7);
    expect(h.state.scrollY).toBe(500);
  });
  it("?debug=scroll logs a move caused by the write", () => {
    const h = harness("?debug=scroll");
    h.liveWrite({ contains: () => false }, () => { h.cards[1]!.top += 50; }, "setHtml#x");
    expect(h.state.logs.join("\n")).toContain("setHtml#x moved 500 -> 550");
  });
});
