/** The cached usage rows are bounded to the look-back of the windows; every whole-log figure of the payload comes from running aggregates and equals the unbounded scan. */
import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCockpitData, cachedRows } from "./cockpit.js";
import type { UsageRow } from "./usage.js";

const dir = mkdtempSync(join(tmpdir(), "pai-bounded-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 86_400_000;
const START = Date.parse("2026-02-01T00:00:00Z");
const PROVIDERS = ["anthropic", "glm", "local30x8", "coder8", "kimi"];
const MODELS = ["claude-opus-5-5", "glm-5.3", "qwen3-coder-30b-8bit", "kimi-k3"];
const providers = {
  anthropic: { enabled: true },
  glm: { enabled: true, models: { default: "glm-5.3" } },
  local30x8: { enabled: true, baseUrl: "http://127.0.0.1:1234", models: { default: "qwen3-coder-30b-8bit" } },
  coder8: { enabled: false, models: { default: "qwen3-coder-30b-8bit" } },
  kimi: { enabled: true, models: { default: "kimi-k3" } },
};

const dayRows = (day: number, perDay = 40): UsageRow[] =>
  Array.from({ length: perDay }, (_, i) => ({
    ts: new Date(START + day * DAY + (i * DAY) / perDay).toISOString(),
    model: MODELS[(i + day) % MODELS.length]!,
    provider: PROVIDERS[(i * 3 + day) % PROVIDERS.length]!,
    status: i % 11 === 0 ? 500 : 200,
    ms: 500 + i,
    ttftMs: 100 + i,
    bytes: 1,
    cache: "hit",
    input_tokens: 10 + i,
    output_tokens: 20 + day,
    cache_creation_input_tokens: i % 3,
    cache_read_input_tokens: 70,
    session_id: `s${(i + day) % 7}`,
  }));

describe("bounded cachedRows", () => {
  const file = join(dir, "usage.jsonl");
  const DAYS = 30;
  let clockMs = START;
  const read = cachedRows(file, () => clockMs);
  const all: UsageRow[] = [];
  const held: number[] = [];
  writeFileSync(file, "");
  for (let d = 0; d < DAYS; d++) {
    const rs = dayRows(d);
    all.push(...rs);
    appendFileSync(file, rs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    clockMs = START + (d + 1) * DAY;
    held.push(read().length);
  }
  const now = START + DAYS * DAY;

  it("holds only the rows of the longest window (+ slack) after appends spanning 30 days", () => {
    const rows = read();
    expect(rows.length).toBeLessThanOrEqual(10 * 40);
    expect(rows.length).toBeGreaterThanOrEqual(8 * 40);
    expect(Math.max(...held)).toBeLessThanOrEqual(10 * 40 + 40);
    expect(all.length).toBe(DAYS * 40);
  });

  it.each(["1h", "24h", "7d"] as const)("payload of the %s window equals the unbounded scan", (win) => {
    const bounded = buildCockpitData(read(), win, now, new Map(), null, providers);
    const unbounded = buildCockpitData(all, win, now, new Map(), null, providers);
    expect(bounded).toEqual(unbounded);
    expect(JSON.stringify(bounded)).toBe(JSON.stringify(unbounded));
    expect(Object.keys(bounded.promptByProvider).length).toBeGreaterThan(2);
  });

  it("a replaced log (new inode) resets the aggregates", () => {
    unlinkSync(file);
    const fresh = dayRows(0, 5).map((r) => ({ ...r, provider: "glm", model: "glm-5.3" }));
    writeFileSync(file, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const rows = read();
    expect(rows.length).toBe(5);
    const d = buildCockpitData(rows, "7d", START + DAY, new Map(), null, providers);
    expect(Object.keys(d.promptByProvider)).toEqual(["glm"]);
    expect(d).toEqual(buildCockpitData(fresh, "7d", START + DAY, new Map(), null, providers));
  });
});
