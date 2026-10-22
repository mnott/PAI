import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeSimilarity } from "./edit-assist.js";
import { parsePorcelainZ } from "./help.js";
import { QueueStore } from "./queue.js";
import { withRunLock } from "./run-lock.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "pai-fixes-"));

describe("QueueStore", () => {
  it("refuses a corrupt file and leaves it untouched", () => {
    const f = join(tmp(), "q.json");
    writeFileSync(f, '{"next": 5, "items": [');
    const s = new QueueStore(f);
    expect(() => s.add("x", "/r")).toThrow(new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*unreadable`));
    expect(() => s.list()).toThrow(/unreadable/);
    expect(readFileSync(f, "utf8")).toBe('{"next": 5, "items": [');
  });

  it("refuses a file without items", () => {
    const f = join(tmp(), "q.json");
    writeFileSync(f, '{"next": 3}');
    expect(() => new QueueStore(f).add("x", "/r")).toThrow(/unreadable/);
    expect(readFileSync(f, "utf8")).toBe('{"next": 3}');
  });

  it("a missing file is an empty queue", () => {
    const s = new QueueStore(join(tmp(), "none", "q.json"));
    expect(s.list()).toEqual([]);
    expect(s.add("x", "/r").id).toBe("q1");
  });

  it("concurrent mutations from separate processes are all persisted", () => {
    const dir = tmp();
    const f = join(dir, "q.json");
    const script = join(dir, "add.ts");
    writeFileSync(
      script,
      `import { QueueStore } from ${JSON.stringify(join(process.cwd(), "src/workers/queue.ts"))};
const s = new QueueStore(process.argv[2]);
for (let i = 0; i < 15; i++) s.add(process.argv[3] + i, "/r");
`,
    );
    const bin = join(process.cwd(), "node_modules/.bin/tsx");
    return Promise.all(
      ["a", "b", "c"].map(
        (tag) =>
          new Promise<void>((res, rej) => {
            const c = spawn(bin, [script, f, tag], { stdio: "inherit" });
            c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`exit ${code}`))));
          }),
      ),
    ).then(() => {
      const items = new QueueStore(f).list();
      expect(items).toHaveLength(45);
      expect(new Set(items.map((i) => i.id)).size).toBe(45);
      expect(readdirSync(dir).filter((n) => n.endsWith(".tmp") || n.endsWith(".mutex"))).toEqual([]);
    });
  }, 60_000);
});

describe("withRunLock exclusivity", () => {
  it("a live lock is kept and never overwritten; a stale one is replaced exclusively", async () => {
    const f = join(tmp(), "run.lock");
    writeFileSync(f, JSON.stringify({ pid: 4242, startedAt: 1 }));
    await expect(withRunLock(f, "plan x", async () => 1, { pid: 7, isAlive: (p) => p === 4242 })).rejects.toThrow(/already in progress/);
    expect(JSON.parse(readFileSync(f, "utf8")).pid).toBe(4242);
    await expect(withRunLock(f, "plan x", async () => JSON.parse(readFileSync(f, "utf8")).pid, { pid: 7, isAlive: () => false })).resolves.toBe(7);
    expect(existsSync(f)).toBe(false);
    // unreadable (torn) lock file counts as stale
    writeFileSync(f, "{");
    await expect(withRunLock(f, "plan x", async () => 1, { pid: 7, isAlive: () => true })).resolves.toBe(1);
  });
});

describe("computeSimilarity", () => {
  it("never exceeds 1", () => {
    expect(computeSimilarity("aa", "aaa")).toBeLessThanOrEqual(1);
    expect(computeSimilarity("abcab", "abcabcab")).toBeLessThanOrEqual(1);
    expect(computeSimilarity("aXa", "aYa")).toBeCloseTo(2 / 3);
  });
});

describe("parsePorcelainZ", () => {
  it("handles renames and paths with spaces", () => {
    const out = " M a b.ts\0R  new name.ts\0old name.ts\0?? c.ts\0";
    expect(parsePorcelainZ(out)).toEqual(["a b.ts", "new name.ts", "c.ts"]);
  });
});
