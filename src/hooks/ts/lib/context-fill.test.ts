import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  configuredTrigger,
  resolveAutocompactPct,
  measureCompactionTrigger,
  modelFamily,
  isForeignModelFamily,
  nativeModelFamilies,
  selectedCompactionSamples,
  transcriptModelFamily,
  crossedThresholds,
  isImmediate,
  DEFAULT_CONTEXT_WINDOW,
  type ContextFillReading,
} from "./context-fill.js";
import { contextWindowFromModelId } from "../../../utils/model-window.js";

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
  // effectiveTrigger = configuredTrigger(windowSize, pct) = pct/100 *
  // (windowSize - 20,000) — NOT windowSize * pct/100. An EXPLICIT override
  // of 80 and an ABSENT override that defaults to the same 80 must agree,
  // and they do: both give 784,000 on a 1M window, warmUp 684,000.
  it("derives warmup from configuredTrigger(windowSize, override) - 100k, for an explicit override", () => {
    const t = contextFillThresholds(readingAt(1_000_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" });
    expect(t.effectiveTriggerTokens).toBe(784_000);
    expect(t.warmupTokens).toBe(684_000);
  });

  it("derives the same effective trigger when the override is absent (defaults to 80)", () => {
    const t = contextFillThresholds(readingAt(1_000_000), {});
    expect(t.autocompactPct).toBe(80);
    expect(t.effectiveTriggerTokens).toBe(784_000);
    expect(t.warmupTokens).toBe(684_000);
  });

  it("scales down correctly for a 200k window with the override absent", () => {
    const t = contextFillThresholds(readingAt(200_000), {});
    expect(t.effectiveTriggerTokens).toBe(144_000);
    expect(t.warmupTokens).toBe(44_000);
  });

  it("computes refresh 40k and immediate 15k below the effective trigger", () => {
    const t = contextFillThresholds(readingAt(1_000_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" });
    expect(t.refreshTokens).toBe(744_000);
    expect(t.immediateTokens).toBe(769_000);
  });

  it("marks the window confirmed only for a statusline-sourced reading", () => {
    expect(contextFillThresholds(readingAt(1_000_000, "statusline"), {}).windowConfirmed).toBe(true);
    expect(contextFillThresholds(readingAt(DEFAULT_CONTEXT_WINDOW, "transcript"), {}).windowConfirmed).toBe(false);
  });

  it("clamps a threshold that would go negative instead of returning it", () => {
    // A tiny window where even the trigger itself is below the warmup margin.
    const t = contextFillThresholds(readingAt(50_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" });
    expect(t.effectiveTriggerTokens).toBe(24_000); // 0.8 * (50,000 - 20,000)
    expect(t.warmupTokens).toBe(0); // 24,000 - 100,000 would be negative
  });
});

describe("configuredTrigger", () => {
  it("is pct/100 * (windowSize - 20,000), not windowSize * pct/100", () => {
    expect(configuredTrigger(1_000_000, 80)).toBe(784_000);
    expect(configuredTrigger(200_000, 80)).toBe(144_000);
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
  const thresholds = { warmupTokens: 900_000, refreshTokens: 960_000, immediateTokens: 985_000, effectiveTriggerTokens: 1_000_000, measuredTriggerTokens: null, configuredTriggerTokens: 1_000_000, autocompactPct: 100, triggerSource: "configured" as const, windowConfirmed: true };

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
  const thresholds = { warmupTokens: 900_000, refreshTokens: 960_000, immediateTokens: 985_000, effectiveTriggerTokens: 1_000_000, measuredTriggerTokens: null, configuredTriggerTokens: 1_000_000, autocompactPct: 100, triggerSource: "configured" as const, windowConfirmed: true };

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

function compactBoundaryLine(preTokens: number, timestamp: string, uuid?: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: { trigger: "auto", preTokens },
    timestamp,
    ...(uuid ? { uuid } : {}),
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

  it("BUG FIX: orders by the EVENT'S OWN timestamp, not by file mtime — a stale file with a recent event beats a fresh file with an old one", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/mtime-bug";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(projectDir, { recursive: true });

    // "old.jsonl" has an OLD file mtime but a RECENT event inside it (e.g. a
    // conversation started long ago, archived, and never touched again on
    // disk since). "new.jsonl" has a FRESH file mtime (touched just now) but
    // an OLD event inside it. The old bug picked files by mtime first, so it
    // would have scanned new.jsonl (mtime-fresh, event-old) and possibly
    // missed old.jsonl (mtime-stale, event-recent) entirely if enough other
    // fresh-mtime files crowded the file-selection cap.
    const oldFile = join(projectDir, "old.jsonl");
    const newFile = join(projectDir, "new.jsonl");
    writeFileSync(oldFile, compactBoundaryLine(784_500, "2026-09-14T00:00:00.000Z") + "\n");
    writeFileSync(newFile, compactBoundaryLine(998_000, "2026-08-16T00:00:00.000Z") + "\n");

    const longAgo = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(oldFile, longAgo, longAgo); // file mtime: ancient
    // newFile keeps its just-written (fresh) mtime.

    try {
      const trigger = measureCompactionTrigger(cwd, projectsDir);
      // The correct answer is the minimum of the (only) two DISTINCT events
      // by their own timestamps: 784,500 and 998,000 -> 784,500. A
      // mtime-ordered implementation that dropped the mtime-ancient file
      // would instead find only 998,000.
      expect(trigger).toBe(784_500);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it("BUG FIX: deduplicates an event mirrored into sessions/ — three copies of one old event must not masquerade as three distinct samples", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/dedup-bug";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(join(projectDir, "sessions"), { recursive: true });

    // The SAME event (same uuid), once in the live top-level file and once
    // in the sessions/ archive that mirrors it — this is the exact
    // structure Claude Code produces when a session is archived. Without
    // dedup, "most recent three" becomes three readings of this one old
    // event, which is a stale trigger wearing a plausible sample count.
    writeFileSync(
      join(projectDir, "live.jsonl"),
      compactBoundaryLine(998_267, "2026-09-10T00:00:00.000Z", "same-event-uuid") + "\n"
    );
    writeFileSync(
      join(projectDir, "sessions", "archived.jsonl"),
      compactBoundaryLine(998_267, "2026-09-10T00:00:00.000Z", "same-event-uuid") + "\n"
    );
    // One genuinely distinct, more recent event.
    writeFileSync(
      join(projectDir, "sessions", "recent.jsonl"),
      compactBoundaryLine(786_000, "2026-09-13T00:00:00.000Z", "a-different-uuid") + "\n"
    );

    try {
      const samples = selectedCompactionSamples(cwd, projectsDir);
      // Two DISTINCT events, not three — the mirrored one counted once.
      expect(samples).toHaveLength(2);
      expect(measureCompactionTrigger(cwd, projectsDir)).toBe(786_000);
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
    expect(t.effectiveTriggerTokens).toBe(784_000);
    expect(t.warmupTokens).toBe(684_000);
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
      expect(t.effectiveTriggerTokens).toBe(784_000);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // The clamp: effectiveTrigger = min(measured, configured). A measured
  // value from a stale (pre-regime-change) history is honest but unsafe if
  // used directly — real case: a project measured 998,267 while its actual
  // current boundary (per a different, fresher project's history) is
  // ~784,000. Using 998,267 outright would compute a warm-up of 898,267,
  // above the real boundary, so the handover would never fire.
  // ---------------------------------------------------------------------

  it("CLAMPS a stale-HIGH measured value down to the configured one — the real CaseLeaf case", () => {
    // measured=998,267 (this project's real, but stale, most-recent trigger)
    // configured=784,000 (80% of a 1,000,000 window, platform formula)
    const t = contextFillThresholds(readingAt(1_000_000), {}, { measuredTrigger: 998_267 });
    expect(t.measuredTriggerTokens).toBe(998_267);
    expect(t.configuredTriggerTokens).toBe(784_000);
    expect(t.triggerSource).toBe("measured-clamped");
    expect(t.effectiveTriggerTokens).toBe(784_000); // min(998267, 784000)
    expect(t.warmupTokens).toBe(684_000);
  });

  it("uses the measured value directly when it is LOWER than configured — no clamp needed", () => {
    // measured=700,000, configured=784,000 -> measured wins, tighter warm-up.
    const t = contextFillThresholds(readingAt(1_000_000), {}, { measuredTrigger: 700_000 });
    expect(t.triggerSource).toBe("measured");
    expect(t.effectiveTriggerTokens).toBe(700_000);
    expect(t.warmupTokens).toBe(600_000);
  });

  it("uses measured directly when it exactly equals configured (boundary case, not clamped)", () => {
    const t = contextFillThresholds(readingAt(1_000_000), {}, { measuredTrigger: 784_000 });
    expect(t.triggerSource).toBe("measured");
    expect(t.effectiveTriggerTokens).toBe(784_000);
  });

  it("reports both raw values on the result even when one of them wasn't used, so the clamp is visible", () => {
    const t = contextFillThresholds(readingAt(1_000_000), {}, { measuredTrigger: 998_267 });
    // Both numbers are on the object — a caller can see what was measured
    // AND what was configured, not just the winner.
    expect(t.measuredTriggerTokens).toBe(998_267);
    expect(t.configuredTriggerTokens).toBe(784_000);
  });
});

// ---------------------------------------------------------------------------
// contextFillThresholds — the 2026-09-20 regime change (override 80 -> 20 on
// a 1M window). Same min(measured, configured) formula, no code change
// needed, but the specific numbers of that day are worth pinning down: a
// project's measured history (784k, from the prior 78-79% regime) is now
// HIGHER than the newly configured 20%-of-1M trigger (200k), so the clamp
// must take the configured value, not the stale measured one.
// ---------------------------------------------------------------------------

describe("contextFillThresholds — 2026-09-20 regime change (override 80 -> 20)", () => {
  it("measured 784k + configured 196k (override=20, 1M window) -> clamps to 196k", () => {
    const t = contextFillThresholds(readingAt(1_000_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "20" }, { measuredTrigger: 784_000 });
    expect(t.configuredTriggerTokens).toBe(196_000); // 0.2 * (1,000,000 - 20,000)
    expect(t.triggerSource).toBe("measured-clamped");
    expect(t.effectiveTriggerTokens).toBe(196_000);
    expect(t.warmupTokens).toBe(96_000); // 196,000 - 100,000
  });

  it("measured 784k + configured 784k (override=80, 1M window) -> measured wins at 784k", () => {
    const t = contextFillThresholds(readingAt(1_000_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" }, { measuredTrigger: 784_000 });
    expect(t.configuredTriggerTokens).toBe(784_000);
    expect(t.triggerSource).toBe("measured");
    expect(t.effectiveTriggerTokens).toBe(784_000);
  });

  it("measured null + configured 196k (override=20, no compaction history yet) -> 196k", () => {
    const t = contextFillThresholds(readingAt(1_000_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "20" }, { measuredTrigger: null });
    expect(t.triggerSource).toBe("configured");
    expect(t.effectiveTriggerTokens).toBe(196_000);
  });

  it("measured 784k + override unset (defaults to 80, configured 784k) -> measured wins at 784k", () => {
    const t = contextFillThresholds(readingAt(1_000_000), {}, { measuredTrigger: 784_000 });
    expect(t.autocompactPct).toBe(80);
    expect(t.configuredTriggerTokens).toBe(784_000);
    expect(t.triggerSource).toBe("measured");
    expect(t.effectiveTriggerTokens).toBe(784_000);
  });
});

// ---------------------------------------------------------------------------
// measureCompactionTrigger — admissibility filter (Fault 1, 2026-09-20):
// samples from a different override regime must not win just because they
// are numerically <= the CURRENT configured trigger. A compaction that
// fired far below the current configured trigger came from a lower
// override or a smaller window; it is discarded, not averaged in.
// ---------------------------------------------------------------------------

describe("measureCompactionTrigger — other-regime samples are discarded", () => {
  it("discards all samples below half of configured and falls back to configured (measured=null, source configured)", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/other-regime-all-discarded";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "a.jsonl"),
      [
        compactBoundaryLine(196_765, "2026-09-20T13:10:00.000Z", "u1"),
        compactBoundaryLine(195_075, "2026-09-20T15:00:00.000Z", "u2"),
        compactBoundaryLine(197_902, "2026-09-20T19:00:00.000Z", "u3"),
      ].join("\n") + "\n"
    );
    try {
      // configured = configuredTrigger(1,000,000, 80) = 784,000; floor = 392,000.
      const measured = measureCompactionTrigger(cwd, projectsDir, undefined, 784_000);
      expect(measured).toBeNull();

      const t = contextFillThresholds(readingAt(1_000_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" }, { measuredTrigger: measured });
      expect(t.triggerSource).toBe("configured");
      expect(t.effectiveTriggerTokens).toBe(784_000);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it("keeps admissible samples and discards only the other-regime one (measured=780,000, source measured)", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/other-regime-partial";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "a.jsonl"),
      [
        compactBoundaryLine(780_000, "2026-09-19T09:00:00.000Z", "u1"),
        compactBoundaryLine(790_000, "2026-09-19T10:00:00.000Z", "u2"),
        compactBoundaryLine(195_000, "2026-09-20T15:00:00.000Z", "u3"), // other-regime, discarded
      ].join("\n") + "\n"
    );
    try {
      const measured = measureCompactionTrigger(cwd, projectsDir, undefined, 784_000);
      expect(measured).toBe(780_000);

      const t = contextFillThresholds(readingAt(1_000_000), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" }, { measuredTrigger: measured });
      expect(t.triggerSource).toBe("measured");
      expect(t.effectiveTriggerTokens).toBe(780_000);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it("applies no filter at all when configuredTriggerTokens is omitted (back-compat with the raw scan)", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/no-filter";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "a.jsonl"),
      compactBoundaryLine(195_000, "2026-09-20T15:00:00.000Z", "u1") + "\n"
    );
    try {
      expect(measureCompactionTrigger(cwd, projectsDir)).toBe(195_000);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Foreign-model transcripts — a headless worker on another provider (a
// different context window) shares the project folder; its compactions must
// not shape THIS project's measured trigger. Observed 2026-09-17: two such
// workers compacting at ~151k pulled a real trigger from ~784k to ~151k.
// ---------------------------------------------------------------------------

function assistantLine(model: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model, content: [{ type: "text", text: "ok" }] },
  });
}

describe("measureCompactionTrigger — foreign-model transcripts are ignored", () => {
  it("drops compact_boundary samples governed by a non-claude assistant model", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/foreign";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "real.jsonl"),
      [assistantLine("claude-x-1"), compactBoundaryLine(784_000, "2026-09-17T09:00:00.000Z", "u1")].join("\n") + "\n"
    );
    writeFileSync(
      join(projectDir, "worker.jsonl"),
      [
        assistantLine("other-model-1"),
        compactBoundaryLine(151_000, "2026-09-17T09:30:00.000Z", "u2"),
        compactBoundaryLine(152_000, "2026-09-17T09:35:00.000Z", "u3"),
      ].join("\n") + "\n"
    );
    try {
      expect(selectedCompactionSamples(cwd, projectsDir).map((s) => s.preTokens)).toEqual([784_000]);
      expect(measureCompactionTrigger(cwd, projectsDir)).toBe(784_000);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it("keeps samples from a transcript with no model field at all", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/nomodel";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "old.jsonl"), compactBoundaryLine(790_000, "2026-09-17T09:00:00.000Z", "u1") + "\n");
    try {
      expect(measureCompactionTrigger(cwd, projectsDir)).toBe(790_000);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it("judges each sample by the model seen BEFORE it in its own file", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "pai-measured-trigger-test-"));
    const cwd = "/fake/project/order";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "mixed.jsonl"),
      [
        assistantLine("claude-x-1"),
        compactBoundaryLine(780_000, "2026-09-17T09:00:00.000Z", "u1"),
        assistantLine("other-model-1"),
        compactBoundaryLine(150_000, "2026-09-17T09:30:00.000Z", "u2"),
      ].join("\n") + "\n"
    );
    try {
      expect(selectedCompactionSamples(cwd, projectsDir).map((s) => s.preTokens)).toEqual([780_000]);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});

describe("modelFamily / transcriptModelFamily", () => {
  it("keys families from the id itself, not from an Anthropic allowlist", () => {
    expect(modelFamily("claude-opus-5")).toBe("claude");
    expect(modelFamily("other-model-1")).toBe("other-model-1");
    // the variant suffix is stripped, so one family has one key
    expect(modelFamily("glm-5.3[1m]")).toBe("glm-5.3");
    expect(modelFamily("glm-5.3")).toBe("glm-5.3");
    expect(modelFamily("<synthetic>")).toBe("unknown");
    expect(modelFamily(null)).toBe("unknown");
    expect(modelFamily("")).toBe("unknown");
  });

  it("reads the LAST assistant model, skips synthetic turns, and is unknown for an unreadable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-model-family-test-"));
    const path = join(dir, "t.jsonl");
    try {
      writeFileSync(
        path,
        [assistantLine("other-model-1"), compactBoundaryLine(1, "2026-09-17T09:00:00.000Z"), assistantLine("claude-x-1")].join("\n") + "\n"
      );
      expect(transcriptModelFamily(path)).toBe("claude");
      writeFileSync(path, [assistantLine("claude-x-1"), assistantLine("glm-5.3[1m]"), assistantLine("<synthetic>")].join("\n") + "\n");
      expect(transcriptModelFamily(path)).toBe("glm-5.3");
      expect(transcriptModelFamily(join(dir, "missing.jsonl"))).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Foreignness is a comparison, not a prefix: a family is foreign exactly when
// it is neither Claude nor one the worker registry configures. Keying it on
// the claude- prefix made a non-Anthropic PRIMARY model read as foreign and
// lose its own compaction/handover history.
// ---------------------------------------------------------------------------

describe("isForeignModelFamily / nativeModelFamilies", () => {
  it("claude and unknown are never foreign; anything else depends on the registry", () => {
    expect(isForeignModelFamily("claude")).toBe(false);
    expect(isForeignModelFamily("unknown")).toBe(false);
    expect(isForeignModelFamily("glm-5.3", new Set())).toBe(true);
    expect(isForeignModelFamily("glm-5.3", new Set(["glm-5.3"]))).toBe(false);
  });

  it("collects the families of every configured provider model", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-native-families-"));
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        workers: {
          enabled: true,
          active: "glm",
          providers: {
            glm: {
              baseUrl: "https://api.example.com/api/anthropic",
              keyFile: null,
              models: { default: "example-5.3[1m]", fast: "example-5.3-flash" },
              env: {},
            },
          },
        },
      })
    );
    try {
      const families = nativeModelFamilies(configPath);
      expect(families.has("example-5.3")).toBe(true); // variant suffix stripped
      expect(families.has("example-5.3-flash")).toBe(true);
      expect(isForeignModelFamily("example-5.3", families)).toBe(false);
      expect(isForeignModelFamily("other-model-1", families)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unreadable registry means nothing is native (the historical rule)", () => {
    expect(nativeModelFamilies("/nonexistent/pai-config.json").size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A provider-model primary session keeps its compaction history: the samples
// are glm, the registry configures glm, so nothing is discarded — before and
// after a simulated compaction alike.
// ---------------------------------------------------------------------------

describe("measureCompactionTrigger — provider-model transcripts are native", () => {
  it("keeps glm compaction history across a simulated compaction, still drops foreign models", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-native-trigger-"));
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        workers: {
          enabled: true,
          active: "glm",
          providers: {
            glm: {
              baseUrl: "https://api.example.com/api/anthropic",
              keyFile: null,
              models: { default: "glm-5.3[1m]", fast: "glm-5.3-flash" },
              env: {},
            },
          },
        },
      })
    );
    const projectsDir = join(dir, "projects");
    const cwd = "/fake/project/glm";
    const projectDir = join(projectsDir, encodeForFixture(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "live.jsonl"),
      [
        assistantLine("glm-5.3[1m]"),
        compactBoundaryLine(990_000, "2026-09-16T09:00:00.000Z", "u1"), // before
        assistantLine("glm-5.3[1m]"),
        compactBoundaryLine(784_000, "2026-09-17T09:00:00.000Z", "u2"), // after
      ].join("\n") + "\n"
    );
    // a foreign-model worker transcript must still not shape the trigger
    writeFileSync(
      join(projectDir, "worker.jsonl"),
      [assistantLine("other-model-1"), compactBoundaryLine(151_000, "2026-09-17T09:30:00.000Z", "u3")].join("\n") + "\n"
    );
    try {
      expect(selectedCompactionSamples(cwd, projectsDir, configPath).map((s) => s.preTokens))
        .toEqual([784_000, 990_000]);
      expect(measureCompactionTrigger(cwd, projectsDir, configPath)).toBe(784_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Window size from the model id — a session whose model declares its window
// ("[1m]") is measured against that, not against the assumed 200k default.
// ---------------------------------------------------------------------------

describe("contextWindowFromModelId", () => {
  it("reads the bracketed variant suffix, and only that", () => {
    expect(contextWindowFromModelId("glm-5.3[1m]")).toBe(1_000_000);
    expect(contextWindowFromModelId("glm-5.3")).toBeNull();
    expect(contextWindowFromModelId("")).toBeNull();
    expect(contextWindowFromModelId(null)).toBeNull();
  });
});

describe("contextFillFromTranscript — window from the transcript's own model", () => {
  const glmTurn = (tokens: number) => ({
    type: "assistant",
    message: { role: "assistant", model: "glm-5.3[1m]", usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });

  it("derives a 1M window from a glm-5.3[1m] transcript when the caller has none", () => {
    const p = join(root, "glm.jsonl");
    writeJsonl(p, [glmTurn(500_000)]);
    const reading = contextFillFromTranscript(p);
    expect(reading.windowSize).toBe(1_000_000);
    expect(reading.fraction).toBeCloseTo(0.5);
  });

  it("an explicit caller window still wins, and a bare id falls back to the default", () => {
    const p = join(root, "glm.jsonl");
    writeJsonl(p, [glmTurn(500_000)]);
    expect(contextFillFromTranscript(p, 200_000).windowSize).toBe(200_000);

    const bare = join(root, "bare.jsonl");
    writeJsonl(bare, [{
      type: "assistant",
      message: { role: "assistant", model: "glm-5.3", usage: { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }]);
    expect(contextFillFromTranscript(bare).windowSize).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});
