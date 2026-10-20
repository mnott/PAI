import { mkdtempSync, writeFileSync, appendFileSync, utimesSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTail } from "./loop-watch.js";
import { loadStatusesCached, TERMINAL_RECHECK_MS } from "./status.js";

const dirs: string[] = [];
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), "bounded-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("readTail", () => {
  it("returns a small file whole and only whole trailing lines of a big one", () => {
    const d = mk();
    const small = join(d, "s.jsonl");
    writeFileSync(small, '{"a":1}\n{"a":2}\n');
    expect(readTail(fs, small, 1000)).toBe('{"a":1}\n{"a":2}\n');
    const big = join(d, "b.jsonl");
    for (let i = 0; i < 5000; i++) appendFileSync(big, JSON.stringify({ i, pad: "x".repeat(50) }) + "\n");
    const t = readTail(fs, big, 4096);
    expect(t.length).toBeLessThanOrEqual(4096);
    const lines = t.split("\n").filter(Boolean);
    expect(lines.every((l) => JSON.parse(l).i >= 0)).toBe(true);
    expect(JSON.parse(lines[lines.length - 1]!).i).toBe(4999);
  });
});

describe("loadStatusesCached", () => {
  const st = (id: string, state: string, note = "") => JSON.stringify({ id, state, note });
  it("re-parses a running status on change, trusts a terminal one until the recheck, drops removed files", () => {
    const d = mk();
    const run = join(d, "a.status");
    const done = join(d, "b.status");
    writeFileSync(run, st("a", "running"));
    writeFileSync(done, st("b", "done"));
    const t0 = Date.now();
    expect(loadStatusesCached(d, t0).map((s) => s.id)).toEqual(["a", "b"]);
    writeFileSync(run, st("a", "done", "longer so the size differs"));
    utimesSync(run, new Date(t0 + 5000), new Date(t0 + 5000));
    writeFileSync(done, st("b", "done", "rewritten"));
    const r = loadStatusesCached(d, t0 + 1000);
    expect(r.find((s) => s.id === "a")!.state).toBe("done");
    expect((r.find((s) => s.id === "b") as { note?: string }).note).toBe(""); // terminal: served from cache
    const r2 = loadStatusesCached(d, t0 + TERMINAL_RECHECK_MS + 1);
    expect((r2.find((s) => s.id === "b") as { note?: string }).note).toBe("rewritten");
    rmSync(done);
    expect(loadStatusesCached(d, t0 + 2).map((s) => s.id)).toEqual(["a"]);
  });
});
