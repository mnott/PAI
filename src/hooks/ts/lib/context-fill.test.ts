import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  contextFillFromTranscript,
  readStatuslineFill,
  getContextFill,
  formatContextFill,
  statuslineStateFilePath,
  contextFillThresholds,
  resolveAutocompactPct,
  measureCompactionTrigger,
  crossedThresholds,
  isImmediate,
  DEFAULT_CONTEXT_WINDOW,
  type ContextFillReading,
} from "./context-fill.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pai-context-fill-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJsonl(path: string, entries: unknown[]): void {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

const usageEntry = (usage: Record<string, number>) => ({
  type: "assistant",
  message: { role: "assistant", usage },
});

const textEntry = () => ({ type: "user", message: { role: "user", content: "hi" } });

// ---------------------------------------------------------------------------
// contextFillFromTranscript — the fallback source
// ---------------------------------------------------------------------------

describe("contextFillFromTranscript", () => {
  it("sums the three fields of the MOST RECENT usage entry only — not across entries", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [
      usageEntry({ input_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 }),
      usageEntry({ input_tokens: 2000, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 1000 }),
    ]);

    const reading = contextFillFromTranscript(p, 200_000);
    expect(reading.status).toBe("ok");
    // Last entry only: 2000 + 60000 + 1000 = 63000. A cumulative sum across
    // both entries would wrongly report 114000.
    expect(reading.usedTokens).toBe(63_000);
    expect(reading.fraction).toBeCloseTo(63_000 / 200_000);
    expect(reading.source).toBe("transcript");
  });

  it("scans backwards past trailing lines with no usage field", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [
      usageEntry({ input_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      textEntry(),
      textEntry(),
    ]);

    const reading = contextFillFromTranscript(p, 200_000);
    expect(reading.status).toBe("ok");
    expect(reading.usedTokens).toBe(5000);
  });

  it("returns unknown — never a confident zero — when no usage entry exists in the tail", () => {
    const p = join(root, "t.jsonl");
    writeJsonl(p, [textEntry(), textEntry()]);

    const reading = contextFillFromTranscript(p, 200_000);
    expect(reading.status).toBe("unknown");
    expect(reading.usedTokens).toBeNull();
    expect(reading.fraction).toBeNull();
  });

  it("returns unknown for a missing transcript file", () => {
    const reading = contextFillFromTranscript(join(root, "does-not-exist.jsonl"), 200_000);
    expect(reading.status).toBe("unknown");
  });

  it("only looks at the last TRANSCRIPT_TAIL_LINES lines", () => {
    const p = join(root, "t.jsonl");
    const entries: unknown[] = [
      usageEntry({ input_tokens: 999_999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ];
    for (let i = 0; i < 60; i++) entries.push(textEntry());
    writeJsonl(p, entries);

    // The huge usage entry is now more than 40 lines back — must not surface.
    const reading = contextFillFromTranscript(p, 200_000);
    expect(reading.status).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// readStatuslineFill — the primary source, and its staleness rule
// ---------------------------------------------------------------------------

describe("readStatuslineFill", () => {
  it("reads a fresh state file written by statusline-command.sh", () => {
    const sessionId = randomUUID();
    // Point tmpdir-based lookup at a real file by writing exactly where the
    // helper will look.
    const path = statuslineStateFilePath(sessionId);
    const now = Date.now();
    writeFileSync(
      path,
      JSON.stringify({ used_percentage: 63, context_window_size: 200_000, session_id: sessionId, timestamp: now })
    );

    try {
      const reading = readStatuslineFill(sessionId, now + 1000);
      expect(reading?.status).toBe("ok");
      expect(reading?.usedTokens).toBe(126_000);
      expect(reading?.fraction).toBeCloseTo(0.63);
      expect(reading?.source).toBe("statusline");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("treats a state file older than the staleness window as absent", () => {
    const sessionId = randomUUID();
    const path = statuslineStateFilePath(sessionId);
    const staleTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes old
    writeFileSync(
      path,
      JSON.stringify({ used_percentage: 63, context_window_size: 200_000, session_id: sessionId, timestamp: staleTimestamp })
    );

    try {
      const reading = readStatuslineFill(sessionId, Date.now());
      expect(reading).toBeNull();
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("returns null when no state file exists for this session", () => {
    expect(readStatuslineFill(randomUUID())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getContextFill — precedence
// ---------------------------------------------------------------------------

describe("getContextFill precedence", () => {
  it("prefers a fresh statusline reading over the transcript", () => {
    const sessionId = randomUUID();
    const path = statuslineStateFilePath(sessionId);
    const now = Date.now();
    writeFileSync(
      path,
      JSON.stringify({ used_percentage: 63, context_window_size: 200_000, session_id: sessionId, timestamp: now })
    );

    const transcriptPath = join(root, "t.jsonl");
    writeJsonl(transcriptPath, [
      usageEntry({ input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);

    try {
      const reading = getContextFill({ sessionId, transcriptPath }, now);
      expect(reading.source).toBe("statusline");
      expect(reading.usedTokens).toBe(126_000);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("falls back to the transcript when the statusline state is stale", () => {
    const sessionId = randomUUID();
    const path = statuslineStateFilePath(sessionId);
    const staleTimestamp = Date.now() - 10 * 60 * 1000;
    writeFileSync(
      path,
      JSON.stringify({ used_percentage: 63, context_window_size: 200_000, session_id: sessionId, timestamp: staleTimestamp })
    );

    const transcriptPath = join(root, "t.jsonl");
    writeJsonl(transcriptPath, [
      usageEntry({ input_tokens: 4000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }),
    ]);

    try {
      const reading = getContextFill({ sessionId, transcriptPath }, Date.now());
      expect(reading.source).toBe("transcript");
      expect(reading.usedTokens).toBe(5000);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("returns unknown when neither source is available", () => {
    const reading = getContextFill({ sessionId: randomUUID() });
    expect(reading.status).toBe("unknown");
    expect(reading.windowSize).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

// ---------------------------------------------------------------------------
// formatContextFill — clamp-and-flag
// ---------------------------------------------------------------------------

describe("formatContextFill", () => {
  it("formats a normal reading with a k-suffix", () => {
    const display = formatContextFill({
      status: "ok",
      usedTokens: 63_000,
      windowSize: 200_000,
      fraction: 0.315,
      source: "transcript",
    });
    expect(display.text).toBe("63k");
    expect(display.flagged).toBe(false);
  });

  it("clamps and flags a reading that exceeds the window instead of printing it", () => {
    const display = formatContextFill({
      status: "ok",
      usedTokens: 2_135_399, // a real value pulled from a broken header
      windowSize: 200_000,
      fraction: 10.68,
      source: "transcript",
    });
    expect(display.flagged).toBe(true);
    expect(display.text).toContain("200k");
    expect(display.text).not.toContain("2135399");
  });

  it("renders unknown as text, never a confident zero", () => {
    const display = formatContextFill({
      status: "unknown",
      usedTokens: null,
      windowSize: 200_000,
      fraction: null,
      source: "unknown",
    });
    expect(display.text).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// contextFillThresholds — derived from the live autocompact override, not
// memorized from a past measurement (the trigger moved once already: ~100%
// of a 1M window through 09-10, ~78-79% from 09-12 on, four days apart).
// ---------------------------------------------------------------------------

function readingAt(windowSize: number, source: ContextFillReading["source"] = "statusline"): ContextFillReading {
  return { status: "ok", usedTokens: 0, windowSize, fraction: 0, source };
}

describe("contextFillThresholds", () => {
  // Fixture requested verbatim: override=80 explicit, 1M window → warmUp
  // 684,000. That does not hold up: effectiveTrigger = 1,000,000 * 80/100 =
  // 800,000, and warmUp = effectiveTrigger - 100,000 = 700,000 by the stated
  // formula — 684,000 has no derivation from these inputs, and an EXPLICIT
  // override of 80 cannot legitimately produce a different effectiveTrigger
  // than an ABSENT override that defaults to the same 80, which the next
  // fixture below requires to be 700,000. Asserting 684,000 here would only
  // be possible by special-casing "override was explicitly set" versus
  // "override defaulted", which the formula gives no basis for. Testing the
  // formula as specified instead: both explicit-80 and absent-defaults-to-80
  // must agree, and they do.
  it("derives warmup from windowSize * (override/100) - 100k, for an explicit override", () => {
    const t = contextFillThresholds(readingAt(1_000_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" });
    expect(t.effectiveTriggerTokens).toBe(800_000);
    expect(t.warmupTokens).toBe(700_000);
  });

  it("derives the same effective trigger when the override is absent (defaults to 80)", () => {
    const t = contextFillThresholds(readingAt(1_000_000), {});
    expect(t.autocompactPct).toBe(80);
    expect(t.effectiveTriggerTokens).toBe(800_000);
    expect(t.warmupTokens).toBe(700_000);
  });

  it("scales down correctly for a 200k window with the override absent", () => {
    const t = contextFillThresholds(readingAt(200_000), {});
    expect(t.effectiveTriggerTokens).toBe(160_000);
    expect(t.warmupTokens).toBe(60_000);
  });

  it("computes refresh 40k and immediate 15k below the effective trigger", () => {
    const t = contextFillThresholds(readingAt(1_000_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" });
    expect(t.refreshTokens).toBe(760_000);
    expect(t.immediateTokens).toBe(785_000);
  });

  it("marks the window confirmed only for a statusline-sourced reading", () => {
    expect(contextFillThresholds(readingAt(1_000_000, "statusline"), {}).windowConfirmed).toBe(true);
    expect(contextFillThresholds(readingAt(DEFAULT_CONTEXT_WINDOW, "transcript"), {}).windowConfirmed).toBe(false);
  });

  it("clamps a threshold that would go negative instead of returning it", () => {
    // A tiny window where even the trigger itself is below the warmup margin.
    const t = contextFillThresholds(readingAt(50_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" });
    expect(t.effectiveTriggerTokens).toBe(40_000);
    expect(t.warmupTokens).toBe(0); // 40,000 - 100,000 would be negative
  });
});

describe("resolveAutocompactPct", () => {
  it("defaults to 80 when the env var is absent", () => {
    expect(resolveAutocompactPct({})).toBe(80);
  });

  it("uses a valid override", () => {
    expect(resolveAutocompactPct({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "65" })).toBe(65);
  });

  it("falls back to the default for an unparseable override", () => {
    expect(resolveAutocompactPct({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "not-a-number" })).toBe(80);
  });

  it("falls back to the default for an out-of-range override", () => {
    expect(resolveAutocompactPct({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "0" })).toBe(80);
    expect(resolveAutocompactPct({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "150" })).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// crossedThresholds — once per threshold, catch-up on a big jump
// ---------------------------------------------------------------------------

describe("crossedThresholds", () => {
  const thresholds = { warmupTokens: 900_000, refreshTokens: 960_000, immediateTokens: 985_000, effectiveTriggerTokens: 1_000_000, autocompactPct: 100, triggerSource: "configured" as const, windowConfirmed: true };

  it("fires warmup only on a clean crossing", () => {
    expect(crossedThresholds(910_000, thresholds, [])).toEqual(["warmup"]);
  });

  it("does not re-fire a threshold already recorded as fired", () => {
    expect(crossedThresholds(920_000, thresholds, ["warmup"])).toEqual([]);
  });

  it("fires refresh once warmup is already fired and the session climbs further", () => {
    expect(crossedThresholds(965_000, thresholds, ["warmup"])).toEqual(["refresh"]);
  });

  it("catches up on both thresholds in one poll when first observed already past both (the 75%+ jump case)", () => {
    expect(crossedThresholds(999_000, thresholds, [])).toEqual(["warmup", "refresh"]);
  });

  it("fires nothing once both thresholds have already fired", () => {
    expect(crossedThresholds(1_002_000, thresholds, ["warmup", "refresh"])).toEqual([]);
  });
});

describe("isImmediate", () => {
  const thresholds = { warmupTokens: 900_000, refreshTokens: 960_000, immediateTokens: 985_000, effectiveTriggerTokens: 1_000_000, autocompactPct: 100, triggerSource: "configured" as const, windowConfirmed: true };

  it("is false below the immediate floor", () => {
    expect(isImmediate(950_000, thresholds)).toBe(false);
  });

  it("is true at or above the immediate floor", () => {
    expect(isImmediate(985_000, thresholds)).toBe(true);
    expect(isImmediate(999_000, thresholds)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// measureCompactionTrigger — ground truth from the project's own history,
// preferred over the configured override chain. Never touches the real
// ~/.claude/projects/ — every test points at an isolated fixture directory
// via the injectable `projectsDir` parameter.
// ---------------------------------------------------------------------------

/** Same encoding measureCompactionTrigger uses internally, duplicated here
 *  only so the fixture can be written at the exact path it will look for. */
function encodeForFixture(cwd: string): string {
  return cwd.replace(/[/\s.-]/g, "-");
}

function compactBoundaryLine(preTokens: number, timestamp: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: { trigger: "auto", preTokens },
    timestamp,
  });
}

describe("measureCompactionTrigger", () => {
  it("returns the MINIMUM of the most recent three compact_boundary events, oldest-eligible excluded", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/measured";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(projectDir, { recursive: true });

    // Five events across two files, all in the SAME project. The most
    // recent three (by timestamp) are 784,000 / 786,000 / 998,000 — their
    // minimum is 784,000. The oldest two (990,000 / 995,000, from the prior
    // regime) must be excluded from the sample entirely, not just from the
    // minimum, or a long-lived project would never fully leave a stale
    // regime behind.
    writeFileSync(
      join(projectDir, "a.jsonl"),
      [
        compactBoundaryLine(995_000, "2026-08-16T00:00:00.000Z"),
        compactBoundaryLine(990_000, "2026-08-20T00:00:00.000Z"),
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(projectDir, "b.jsonl"),
      [
        compactBoundaryLine(998_000, "2026-09-12T00:00:00.000Z"),
        compactBoundaryLine(786_000, "2026-09-13T00:00:00.000Z"),
        compactBoundaryLine(784_000, "2026-09-14T00:00:00.000Z"),
      ].join("\n") + "\n"
    );

    try {
      const trigger = measureCompactionTrigger(cwd, projectsDir);
      expect(trigger).toBe(784_000);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it("finds events in the sessions/ subdirectory too", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/sessions-subdir";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(join(projectDir, "sessions"), { recursive: true });

    writeFileSync(
      join(projectDir, "sessions", "archived.jsonl"),
      compactBoundaryLine(850_000, "2026-09-15T00:00:00.000Z") + "\n"
    );

    try {
      expect(measureCompactionTrigger(cwd, projectsDir)).toBe(850_000);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it("returns null for a project with no compaction history at all", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/never-compacted";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "a.jsonl"),
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n"
    );

    try {
      expect(measureCompactionTrigger(cwd, projectsDir)).toBeNull();
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it("returns null when the project directory does not exist yet", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    try {
      expect(measureCompactionTrigger("/fake/project/brand-new", projectsDir)).toBeNull();
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// contextFillThresholds — triggerSource reporting (measured preferred,
// configured as the fallback for a project with no history)
// ---------------------------------------------------------------------------

describe("contextFillThresholds — trigger source", () => {
  it("reports triggerSource 'measured' and uses it as the effective trigger when a measured value is available", () => {
    const t = contextFillThresholds(readingAt(1_000_000), {}, { measuredTrigger: 784_000 });
    expect(t.triggerSource).toBe("measured");
    expect(t.effectiveTriggerTokens).toBe(784_000);
    expect(t.warmupTokens).toBe(684_000); // this is where the coordinator's 684,000 actually comes from
    // The configured chain is still computed and reported, just not used:
    expect(t.autocompactPct).toBe(80);
  });

  it("reports triggerSource 'configured' and falls back to the env chain when there is no measured value", () => {
    const t = contextFillThresholds(readingAt(1_000_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" }, { measuredTrigger: null });
    expect(t.triggerSource).toBe("configured");
    expect(t.effectiveTriggerTokens).toBe(800_000);
    expect(t.warmupTokens).toBe(700_000);
  });

  it("falls back to configured when cwd is given but the project has no compaction history (real scan, empty fixture)", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/no-history-yet";
    try {
      // No directory created at all for this cwd — genuinely no history.
      const t = contextFillThresholds(readingAt(1_000_000), {}, {
        measuredTrigger: measureCompactionTrigger(cwd, projectsDir),
      });
      expect(t.triggerSource).toBe("configured");
      expect(t.effectiveTriggerTokens).toBe(800_000);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});
