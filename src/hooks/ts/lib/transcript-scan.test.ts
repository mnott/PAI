import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanIncremental, readTailLines, type ScanStats } from "./transcript-scan.js";
import { recentPrompts } from "../../../session/autosave.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-scan-test-"));
  file = join(dir, "t.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const count = (stats: ScanStats) => (st: { n: number }, _line: string) => {
  st.n++;
  void stats;
  return st;
};

const scan = (stats: ScanStats) =>
  scanIncremental(file, "t", () => ({ n: 0 }), count(stats), { cacheDir: dir, stats });
const fresh = (): ScanStats => ({ bytesRead: 0, linesParsed: 0, full: false });

describe("scanIncremental", () => {
  it("parses only appended lines on the second run", () => {
    writeFileSync(file, "a\nb\nc\n");
    const s1 = fresh();
    expect(scan(s1).n).toBe(3);
    expect(s1.linesParsed).toBe(3);

    appendFileSync(file, "d\ne\n");
    const s2 = fresh();
    expect(scan(s2).n).toBe(5);
    expect(s2.linesParsed).toBe(2);
    expect(s2.bytesRead).toBe(4);
    expect(s2.full).toBe(false);
  });

  it("reads nothing when the file did not grow", () => {
    writeFileSync(file, "a\nb\n");
    scan(fresh());
    const s = fresh();
    expect(scan(s).n).toBe(2);
    expect(s.bytesRead).toBe(0);
  });

  it("leaves an unterminated trailing line for the next run", () => {
    writeFileSync(file, "a\nb");
    expect(scan(fresh()).n).toBe(1);
    appendFileSync(file, "\nc\n");
    const s = fresh();
    expect(scan(s).n).toBe(3);
    expect(s.linesParsed).toBe(2);
  });

  it("falls back to a full read when the file shrank", () => {
    writeFileSync(file, "a\nb\nc\nd\n");
    scan(fresh());
    writeFileSync(file, "x\ny\n");
    const s = fresh();
    expect(scan(s).n).toBe(2);
    expect(s.full).toBe(true);
    expect(s.linesParsed).toBe(2);
  });

  it("falls back to a full read when the file was replaced by a longer one", () => {
    writeFileSync(file, "aaaa\nbbbb\n");
    scan(fresh());
    writeFileSync(file, "zzzz\nyyyy\nxxxx\nwwww\n");
    const s = fresh();
    expect(scan(s).n).toBe(4);
    expect(s.full).toBe(true);
  });
});

describe("readTailLines", () => {
  it("returns the last lines without needing the whole file", () => {
    const lines = Array.from({ length: 200000 }, (_, i) => `line-${i}`);
    writeFileSync(file, lines.join("\n") + "\n");
    const tail = readTailLines(file, 40);
    expect(tail.length).toBeGreaterThanOrEqual(40);
    expect(tail[tail.length - 1]).toBe("line-199999");
    expect(tail.length).toBeLessThan(lines.length);
  });

  it("widens the window while the caller keeps asking", () => {
    const lines = ["needle", ...Array.from({ length: 50000 }, (_, i) => `filler-${i}`)];
    writeFileSync(file, lines.join("\n") + "\n");
    const tail = readTailLines(file, 1, (l) => !l.includes("needle"));
    expect(tail[0]).toBe("needle");
  });
});

describe("recentPrompts incremental", () => {
  it("sees prompts appended after the first run, parsing only the new lines", () => {
    const entry = (t: string) => JSON.stringify({ type: "last-prompt", lastPrompt: t }) + "\n";
    writeFileSync(file, entry("one") + entry("two"));
    expect(recentPrompts([file], 6, { cacheDir: dir })).toEqual(["one", "two"]);

    appendFileSync(file, entry("three"));
    const stats = fresh();
    expect(recentPrompts([file], 6, { cacheDir: dir, stats })).toEqual(["one", "two", "three"]);
    expect(stats.linesParsed).toBe(1);
    expect(stats.full).toBe(false);
  });

  it("re-reads fully after truncation", () => {
    const entry = (t: string) => JSON.stringify({ type: "last-prompt", lastPrompt: t }) + "\n";
    writeFileSync(file, entry("one") + entry("two") + entry("three"));
    recentPrompts([file], 6, { cacheDir: dir });
    writeFileSync(file, entry("fresh"));
    const stats = fresh();
    expect(recentPrompts([file], 6, { cacheDir: dir, stats })).toEqual(["fresh"]);
    expect(stats.full).toBe(true);
  });
});
