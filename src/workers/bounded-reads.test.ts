import { mkdtempSync, writeFileSync, appendFileSync, utimesSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTail } from "./loop-watch.js";
import { loadStatuses } from "./status.js";

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

describe("loadStatuses cache", () => {
  const st = (id: string, state: string, note = "") => JSON.stringify({ id, state, note });
  it("re-reads a rewritten status, picks up a new file, drops a deleted one, and never leaks caller mutation", () => {
    const d = mk();
    const a = join(d, "a.status");
    const b = join(d, "b.status");
    writeFileSync(a, st("a", "running"));
    writeFileSync(b, st("b", "done"));
    expect(loadStatuses(d).map((s) => s.id)).toEqual(["a", "b"]);
    loadStatuses(d)[0]!.state = "failed";
    expect(loadStatuses(d)[0]!.state).toBe("running");
    writeFileSync(a, st("a", "done", "longer so the size differs"));
    writeFileSync(b, st("b", "done", "rewritten"));
    utimesSync(b, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const r = loadStatuses(d);
    expect(r.find((s) => s.id === "a")!.state).toBe("done");
    expect((r.find((s) => s.id === "b") as { note?: string }).note).toBe("rewritten");
    writeFileSync(join(d, "c.status"), st("c", "running"));
    expect(loadStatuses(d).map((s) => s.id)).toEqual(["a", "b", "c"]);
    rmSync(b);
    expect(loadStatuses(d).map((s) => s.id)).toEqual(["a", "c"]);
  });
});
