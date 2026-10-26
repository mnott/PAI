import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readHits, RuleHitCounter } from "./tool-call-hits.js";

describe("rule hit counters", () => {
  it("counts per rule with last_hit, skips coerce pseudo ids, adds to an existing file on flush", () => {
    const f = join(mkdtempSync(join(tmpdir(), "hits-")), "logs", "h.json");
    let t = Date.parse("2026-10-25T10:00:00Z");
    const c = new RuleHitCounter(() => f, () => new Date(t), 3_600_000);
    c.record(["close-parameter", "coerce:number", "bool-true"]);
    t += 1000;
    c.record(["close-parameter"]);
    expect(existsSync(f)).toBe(false); // flushed by the timer or at exit, not per hit
    c.flush();
    expect(readHits(f)).toEqual({
      "close-parameter": { hits: 2, last_hit: "2026-10-25T10:00:01.000Z" },
      "bool-true": { hits: 1, last_hit: "2026-10-25T10:00:00.000Z" },
    });
    c.record(["close-parameter"]);
    c.flush();
    expect(readHits(f)["close-parameter"].hits).toBe(3);
    // another process's counts in the file are kept
    writeFileSync(f, JSON.stringify({ ...readHits(f), other: { hits: 5, last_hit: "2026-10-01T00:00:00Z" } }));
    c.record(["bool-true"]);
    c.stop();
    expect(readHits(f).other.hits).toBe(5);
    expect(readHits(f)["bool-true"].hits).toBe(2);
    expect(readFileSync(f, "utf8").endsWith("\n")).toBe(true);
  });
});
