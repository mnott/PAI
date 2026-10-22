import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsageCached } from "./usage.js";

const dir = mkdtempSync(join(tmpdir(), "pai-usage-cache-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-20T12:00:00Z");
const day = 86_400_000;
const line = (msAgo: number, model: string) =>
  JSON.stringify({ ts: new Date(NOW - msAgo).toISOString(), model, provider: "anthropic", input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, status: 200, ms: 1, ttftMs: 1, session_id: "s", gap_s: 1 });

describe("readUsageCached", () => {
  it("an in-place rewrite that keeps the inode and grows is re-read, not served stale", () => {
    const f = join(dir, "rewrite.jsonl");
    writeFileSync(f, line(3000, "old-a") + "\n" + line(2000, "old-b") + "\n");
    expect(readUsageCached(f, NOW).map((r) => r.model)).toEqual(["old-a", "old-b"]);
    // same inode (writeFileSync truncates in place), different and longer content
    writeFileSync(f, line(3000, "new-a") + "\n" + line(2000, "new-b") + "\n" + line(1000, "new-c") + "\n");
    expect(readUsageCached(f, NOW).map((r) => r.model)).toEqual(["new-a", "new-b", "new-c"]);
  });

  it("appends still extend the cache without a re-read", () => {
    const f = join(dir, "append.jsonl");
    writeFileSync(f, line(3000, "a") + "\n");
    const first = readUsageCached(f, NOW);
    appendFileSync(f, line(2000, "b") + "\n");
    const second = readUsageCached(f, NOW);
    expect(second).toBe(first);
    expect(second.map((r) => r.model)).toEqual(["a", "b"]);
  });

  it("rows older than the 7 d window are dropped", () => {
    const f = join(dir, "bound.jsonl");
    writeFileSync(f, line(20 * day, "ancient") + "\n" + line(9 * day, "old") + "\n" + line(6 * day, "week") + "\n");
    expect(readUsageCached(f, NOW).map((r) => r.model)).toEqual(["week"]);
    appendFileSync(f, line(1000, "fresh") + "\n");
    expect(readUsageCached(f, NOW).map((r) => r.model)).toEqual(["week", "fresh"]);
  });
});
