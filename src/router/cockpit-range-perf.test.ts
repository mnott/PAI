/** The range buttons (1 hour / today / week) read the usage log through an append-only cache and
 *  keep the whole-log aggregates between clicks; a big log must not cost a full parse per click. */
import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCockpitData } from "./cockpit.js";
import { readUsageCached, readUsage } from "./usage.js";

const dir = mkdtempSync(join(tmpdir(), "pai-range-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.now();
const row = (msAgo: number, i: number) =>
  JSON.stringify({ ts: new Date(NOW - msAgo).toISOString(), model: "claude-opus-5-5", provider: "anthropic", input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, status: 200, ms: 900, ttftMs: 300, session_id: "s" + (i % 40), gap_s: 30 });

describe("range reads", () => {
  const file = join(dir, "usage.jsonl");
  const N = 50_000;
  // 50k rows over 7 days, oldest first like the real log
  writeFileSync(file, Array.from({ length: N }, (_, i) => row(((N - i) / N) * 7 * 86_400_000, i)).join("\n") + "\n");

  it("1 hour returns the recent rows only, quickly, once the log is cached", () => {
    readUsageCached(file);
    const t0 = performance.now();
    const rows = readUsageCached(file);
    const d = buildCockpitData(rows, "1h", NOW);
    const ms = performance.now() - t0;
    expect(rows.length).toBe(N);
    expect(d.totals.requests).toBeGreaterThan(250);
    expect(d.totals.requests).toBeLessThan(400);
    expect(ms).toBeLessThan(300);
  });

  it("week still counts every row in it", () => {
    expect(buildCockpitData(readUsageCached(file), "7d", NOW).totals.requests).toBe(N);
  });

  it("appended rows are read without a re-parse, a torn tail waits, a truncated file is re-read", () => {
    const before = readUsageCached(file);
    appendFileSync(file, row(1000, 1) + "\n" + '{"ts":"torn');
    const after = readUsageCached(file);
    expect(after).toBe(before);
    expect(after.length).toBe(N + 1);
    appendFileSync(file, '"}\n');
    expect(readUsageCached(file).length).toBe(N + 2); // the finished line is a row now
    truncateSync(file, 0);
    writeFileSync(file, row(5, 1) + "\n");
    expect(readUsageCached(file)).toEqual(readUsage(file));
    expect(readUsageCached(file).length).toBe(1);
  });
});
