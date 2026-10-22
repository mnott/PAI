/** Header version from the server, and the order of the "Hit ratio per model" rings: default (provider, then requests), the user's stored order wins, new models take their default slot, reset. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleCockpit } from "./cockpit.js";
import { WIN_CACHE_JS } from "./cockpit-page/win/cards-cache.js";

function page(): string {
  const sent = { body: "" };
  const fake = { setHeader: () => undefined, writeHead: () => undefined, end: (b: string) => void (sent.body = b) } as never;
  handleCockpit({ url: "/cockpit", method: "GET" } as never, fake, { get: async () => [] } as never, () => [], () => new Map(), undefined, () => []);
  return sent.body;
}

describe("cockpit header version", () => {
  it("shows v<package.json version> from the server, with a tooltip carrying version and build", () => {
    const v = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
    const html = page();
    expect(html).toMatch(new RegExp(`<span id="ver" title="PAI ${v.replace(/\./g, "\\.")} · build [0-9a-f]{12}">v${v.replace(/\./g, "\\.")}</span>`));
    expect(html).not.toContain("__COCKPIT_VERSION__");
  });
});

class Mem {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
const mk = () => {
  const ls = new Mem();
  const lim = { routing: { choices: [{ entry: "local" }, { entry: "glm" }, { entry: "anthropic" }] } };
  const api = new Function("localStorage", "lim", "LOW_REQ", "Win", "WinT", `${WIN_CACHE_JS}\nreturn {cacheRingIds:cacheRingIds,cacheSetUserOrder:cacheSetUserOrder};`)(ls, lim, 5, { registerType: () => undefined }, {}) as {
    cacheRingIds: (d: unknown) => string[]; cacheSetUserOrder: (o: string[] | null) => void;
  };
  return api;
};
const row = (provider: string, model: string, requests: number) => ({ provider, model, requests, cacheRead: 1, cacheWrite: 1, input: 1 });
const hour = { byModel: [row("anthropic", "a1", 50), row("glm", "g1", 10), row("glm", "g2", 30), row("local", "l1", 6), row("anthropic", "a2", 90)] };
const week = { byModel: [row("anthropic", "a1", 500), row("glm", "g1", 400), row("glm", "g2", 30), row("local", "l1", 60), row("anthropic", "a2", 90)] };
const id = (p: string, m: string) => `cache.ring:${p}/${m}`;

describe("hit ratio rings order", () => {
  it("default: routing order of providers, then requests descending, for two data sets", () => {
    const a = mk();
    expect(a.cacheRingIds(hour)).toEqual([id("local", "l1"), id("glm", "g2"), id("glm", "g1"), id("anthropic", "a2"), id("anthropic", "a1")]);
    expect(a.cacheRingIds(week)).toEqual([id("local", "l1"), id("glm", "g1"), id("glm", "g2"), id("anthropic", "a1"), id("anthropic", "a2")]);
  });
  it("providers outside the routing order follow alphabetically", () => {
    const a = mk();
    expect(a.cacheRingIds({ byModel: [row("zed", "z", 9), row("alpha", "x", 9), row("local", "l", 9)] })).toEqual([id("local", "l"), id("alpha", "x"), id("zed", "z")]);
  });
  it("low-request models (<5) get a ring too, after the normal rings of their provider; all-low data gives the same ids", () => {
    const a = mk();
    const d = { byModel: [row("glm", "g-low", 2), row("glm", "g1", 10), row("local", "l-low", 1), row("anthropic", "a1", 50), row("anthropic", "a-low", 4)] };
    expect(a.cacheRingIds(d)).toEqual([id("local", "l-low"), id("glm", "g1"), id("glm", "g-low"), id("anthropic", "a1"), id("anthropic", "a-low")]);
    expect(a.cacheRingIds({ byModel: [row("glm", "x", 1), row("glm", "y", 3)] })).toEqual([id("glm", "y"), id("glm", "x")]);
  });
  it("a stored user order persists across a range switch; new models take their default slot", () => {
    const a = mk();
    a.cacheSetUserOrder([id("anthropic", "a1"), id("glm", "g1"), id("local", "l1"), id("glm", "g2")]);
    // a2 is new: it lands right after its default predecessor (hour: g1, week: a1)
    expect(a.cacheRingIds(hour)).toEqual([id("anthropic", "a1"), id("glm", "g1"), id("anthropic", "a2"), id("local", "l1"), id("glm", "g2")]);
    expect(a.cacheRingIds(week)).toEqual([id("anthropic", "a1"), id("anthropic", "a2"), id("glm", "g1"), id("local", "l1"), id("glm", "g2")]);
    // a new model with no default predecessor placed goes first
    const b = mk();
    b.cacheSetUserOrder([id("glm", "g1"), id("anthropic", "a1")]);
    expect(b.cacheRingIds(week)).toEqual([id("local", "l1"), id("glm", "g1"), id("glm", "g2"), id("anthropic", "a1"), id("anthropic", "a2")]);
  });
  it("reset restores the default order", () => {
    const a = mk();
    a.cacheSetUserOrder([id("anthropic", "a1"), id("glm", "g1"), id("local", "l1")]);
    expect(a.cacheRingIds(hour)[0]).toBe(id("anthropic", "a1"));
    a.cacheSetUserOrder(null);
    expect(a.cacheRingIds(hour)[0]).toBe(id("local", "l1"));
  });
});
