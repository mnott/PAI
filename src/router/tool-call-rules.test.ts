import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRules, RulesError, RulesStore, rulesPathFor, shippedRulesPath } from "./tool-call-rules.js";
import { DEFAULT_STALE_DAYS, listRules, testRules } from "./tool-call-rules-ops.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcr-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rule = (id: string, pattern = "^x$", extra = "") =>
  `  - id: ${id}\n    kind: junk_line\n    pattern: '${pattern}'\n    added: 2026-10-25\n${extra}`;

describe("shipped rules file", () => {
  it("every rule has an example that is repaired to expect and is not redundant", () => {
    const set = loadRules(shippedRulesPath());
    const rows = testRules(set);
    expect(rows.filter((r) => r.status !== "ok").map((r) => `${r.id}: ${r.status} ${r.detail ?? ""}`)).toEqual([]);
    expect(rows.length).toBe(set.rules.length);
  });
});

describe("loading and validation", () => {
  it("a bad regex is refused and named", () => {
    const f = join(dir, "bad.yaml");
    writeFileSync(f, `version: 1\nrules:\n${rule("broken", "([unclosed")}`);
    expect(() => loadRules(f)).toThrow(/rule broken: bad regex/);
  });
  it("an opener without a capture group, an empty-matching pattern and a duplicate id are refused", () => {
    const f = join(dir, "x.yaml");
    writeFileSync(f, `version: 1\nrules:\n  - {id: o, kind: opener, pattern: '<x>', added: 2026-10-25}\n`);
    expect(() => loadRules(f)).toThrow(/capture group/);
    writeFileSync(f, `version: 1\nrules:\n${rule("e", "^$")}`);
    expect(() => loadRules(f)).toThrow(/empty string/);
    writeFileSync(f, `version: 1\nrules:\n${rule("d")}${rule("d")}`);
    expect(() => loadRules(f)).toThrow(RulesError);
  });
  it("inherits default: a child rule replaces the parent's of the same id and may disable it", () => {
    const f = join(dir, "child.yaml");
    writeFileSync(f, `version: 1\ninherits: default\nrules:\n  - {id: junk-lone-gt, kind: junk_line, pattern: '^NEVER$', added: 2026-10-25, disabled: true}\n${rule("mine", "^mine$")}`);
    const set = loadRules(f);
    const shipped = loadRules(shippedRulesPath());
    expect(set.rules.length).toBe(shipped.rules.length + 1);
    expect(set.rules.find((r) => r.id === "junk-lone-gt")?.disabled).toBe(true);
  });
  it("maps provider/model to a file, falling back to the shipped one", () => {
    mkdirSync(join(dir, "tool-call-rules"));
    writeFileSync(join(dir, "tool-call-rules", "a.yaml"), "version: 1\nrules: []\n");
    const cfg = { providers: { strata: { "Coder-L": "a.yaml" }, other: "a.yaml" } };
    expect(rulesPathFor(cfg, dir, "strata", "Coder-L")).toBe(join(dir, "tool-call-rules", "a.yaml"));
    expect(rulesPathFor(cfg, dir, "other", "any")).toBe(join(dir, "tool-call-rules", "a.yaml"));
    expect(rulesPathFor(cfg, dir, "strata", "Other")).toBe(shippedRulesPath());
    expect(rulesPathFor(undefined, dir, "x", "y")).toBe(shippedRulesPath());
  });
});

describe("hot reload", () => {
  const mk = (clock: { t: number }, logs: string[]) =>
    new RulesStore({ config: () => ({ file: "r.yaml" }), homeDir: () => dir, now: () => clock.t, log: (l) => logs.push(l), checkMs: 5000 });
  const bump = (f: string, s: number) => utimesSync(f, s, s);

  it("re-reads on mtime change, at most every 5 s", () => {
    mkdirSync(join(dir, "tool-call-rules"));
    const f = join(dir, "tool-call-rules", "r.yaml");
    writeFileSync(f, `version: 1\nrules:\n${rule("one")}`);
    bump(f, 1000);
    const clock = { t: 1_000_000 };
    const logs: string[] = [];
    const s = mk(clock, logs);
    expect(s.get("p", "m").rules.map((r) => r.id)).toEqual(["one"]);
    writeFileSync(f, `version: 1\nrules:\n${rule("one")}${rule("two")}`);
    bump(f, 2000);
    clock.t += 1000;
    expect(s.get("p", "m").rules.map((r) => r.id)).toEqual(["one"]); // inside the 5 s window
    clock.t += 5000;
    expect(s.get("p", "m").rules.map((r) => r.id)).toEqual(["one", "two"]);
    expect(logs.some((l) => /reloaded/.test(l))).toBe(true);
  });

  it("a bad file keeps the old set and logs why; fixing it loads again", () => {
    mkdirSync(join(dir, "tool-call-rules"));
    const f = join(dir, "tool-call-rules", "r.yaml");
    writeFileSync(f, `version: 1\nrules:\n${rule("one")}`);
    bump(f, 1000);
    const clock = { t: 1_000_000 };
    const logs: string[] = [];
    const s = mk(clock, logs);
    s.get("p", "m");
    writeFileSync(f, `version: 1\nrules:\n${rule("two", "([bad")}`);
    bump(f, 2000);
    clock.t += 6000;
    expect(s.get("p", "m").rules.map((r) => r.id)).toEqual(["one"]);
    expect(logs.join("\n")).toMatch(/NOT reloaded.*rule two: bad regex/);
    const n = logs.length;
    clock.t += 6000;
    s.get("p", "m");
    expect(logs.length).toBe(n); // same bad file: logged once
    writeFileSync(f, `version: 1\nrules:\n${rule("three")}`);
    bump(f, 3000);
    clock.t += 6000;
    expect(s.get("p", "m").rules.map((r) => r.id)).toEqual(["three"]);
  });

  it("the reload marker forces a re-read of an unchanged file inside the window after invalidate", () => {
    mkdirSync(join(dir, "tool-call-rules"));
    const f = join(dir, "tool-call-rules", "r.yaml");
    writeFileSync(f, `version: 1\nrules:\n${rule("one")}`);
    bump(f, 1000);
    const clock = { t: 1_000_000 };
    const s = mk(clock, []);
    s.get("p", "m");
    writeFileSync(f, `version: 1\nrules:\n${rule("one")}${rule("two")}`);
    bump(f, 2000);
    s.invalidate();
    expect(s.get("p", "m").rules.length).toBe(2);
  });

  it("a broken first load falls back to the shipped rules", () => {
    mkdirSync(join(dir, "tool-call-rules"));
    writeFileSync(join(dir, "tool-call-rules", "r.yaml"), "version: 1\nrules:\n  - {id: x, kind: nope, pattern: a}\n");
    const s = mk({ t: 1 }, []);
    expect(s.get("p", "m").rules.length).toBe(loadRules(shippedRulesPath()).rules.length);
  });
});

describe("list", () => {
  it("marks a rule stale when it has no hit within the window; never hit counts from its added date", () => {
    const set = loadRules(shippedRulesPath());
    const now = new Date("2026-11-30T00:00:00Z");
    const rows = listRules(set, { "junk-lone-gt": { hits: 3, last_hit: "2026-11-29T00:00:00Z" } }, DEFAULT_STALE_DAYS, now);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by["junk-lone-gt"]).toMatchObject({ hits: 3, stale: false });
    expect(by["close-parameter"]).toMatchObject({ hits: 0, stale: true, last_hit: "-" });
    expect(listRules(set, {}, DEFAULT_STALE_DAYS, new Date("2026-10-26T00:00:00Z")).every((r) => !r.stale)).toBe(true);
  });
});

describe("provider flag", () => {
  it("toolParsing: router is read from workers.yaml data; other values are refused", async () => {
    const { parseWorkersConfig } = await import("../workers/config.js");
    const base = { baseUrl: "http://127.0.0.1:1", models: { default: "m" } };
    expect(parseWorkersConfig({ providers: { a: { ...base, toolParsing: "router" }, b: base } }).providers.a.toolParsing).toBe("router");
    expect(parseWorkersConfig({ providers: { b: base } }).providers.b.toolParsing).toBeUndefined();
    expect(() => parseWorkersConfig({ providers: { a: { ...base, toolParsing: "nope" } } })).toThrow(/toolParsing/);
  });
});
