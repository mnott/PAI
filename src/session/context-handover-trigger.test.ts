import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A headless worker running this suite carries the launcher's PAI_WORKER=1;
// the code under test must not mistake the test process for a worker.
delete process.env.PAI_WORKER;
import {
  checkAndEnqueueContextHandover,
  loadTriggerState,
  resetHandoverTriggerState,
  triggerStatePath,
  type HandoverTriggerDeps,
  type HandoverTriggerState,
} from "./context-handover-trigger.js";
import type { ContextFillReading, ThresholdName } from "../hooks/ts/lib/context-fill.js";
import { contextHandoverCachePath, writeContextHandoverCache, type ContextHandoverCache } from "../hooks/ts/lib/context-handover-cache.js";

function readingAt(usedTokens: number, windowSize = 1_000_000): ContextFillReading {
  return { status: "ok", usedTokens, windowSize, fraction: usedTokens / windowSize, source: "statusline" };
}

function makeDeps(overrides: {
  state?: HandoverTriggerState;
  cache?: ContextHandoverCache | null;
  getReading?: HandoverTriggerDeps["getReading"];
  enqueue?: HandoverTriggerDeps["enqueue"];
  now?: number;
} = {}): {
  deps: HandoverTriggerDeps;
  enqueued: Array<{ threshold: ThresholdName; urgent: boolean }>;
  savedStates: HandoverTriggerState[];
  setCache: (c: ContextHandoverCache | null) => void;
  setNow: (n: number) => void;
} {
  const enqueued: Array<{ threshold: ThresholdName; urgent: boolean }> = [];
  const savedStates: HandoverTriggerState[] = [];
  let state: HandoverTriggerState = overrides.state ?? { confirmed: [], pending: null };
  let cache: ContextHandoverCache | null = overrides.cache ?? null;
  let now = overrides.now ?? Date.now();

  const deps: HandoverTriggerDeps = {
    getReading: overrides.getReading ?? (() => readingAt(0)),
    loadState: () => state,
    saveState: (_id, next) => {
      state = next;
      savedStates.push(next);
    },
    readCache: () => cache,
    enqueue: overrides.enqueue ?? (async (payload) => {
      enqueued.push({ threshold: payload.threshold, urgent: payload.urgent });
    }),
    now: () => now,
  };

  return {
    deps,
    enqueued,
    savedStates,
    setCache: (c) => { cache = c; },
    setNow: (n) => { now = n; },
  };
}

const input = { sessionId: "s1", cwd: "/proj" };

function makeCache(overrides: Partial<ContextHandoverCache> = {}): ContextHandoverCache {
  return {
    sessionId: "s1",
    cwd: "/proj",
    threshold: "warmup",
    generatedAt: new Date().toISOString(),
    model: "sonnet",
    summary: "some handover text",
    ...overrides,
  };
}

describe("checkAndEnqueueContextHandover — enqueue attempt vs confirmed outcome", () => {
  it("does nothing when the reading is unknown", async () => {
    const { deps, enqueued } = makeDeps({
      getReading: () => ({ status: "unknown", usedTokens: null, windowSize: 1_000_000, fraction: null, source: "unknown" }),
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual({ attempted: [], confirmed: [] });
    expect(enqueued).toEqual([]);
  });

  it("does nothing below warmup", async () => {
    const { deps, enqueued } = makeDeps({ getReading: () => readingAt(500_000) });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual({ attempted: [], confirmed: [] });
    expect(enqueued).toEqual([]);
  });

  it("enqueues on a clean crossing but does NOT mark confirmed — only attempted", async () => {
    const { deps, enqueued, savedStates } = makeDeps({ getReading: () => readingAt(710_000) });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual({ attempted: ["warmup"], confirmed: [] });
    expect(enqueued).toEqual([{ threshold: "warmup", urgent: false }]);
    // THE BUG THIS FIXES: the persisted state must NOT say "warmup" is done —
    // only that it is pending, awaiting outcome confirmation.
    expect(savedStates[0].confirmed).toEqual([]);
    expect(savedStates[0].pending?.thresholds).toEqual(["warmup"]);
  });

  it("does not re-enqueue while a threshold is pending (worker may still be running)", async () => {
    const pendingAt = new Date(Date.now() - 10_000).toISOString(); // 10s ago — well inside the timeout
    const { deps, enqueued } = makeDeps({
      state: { confirmed: [], pending: { thresholds: ["warmup"], enqueuedAt: pendingAt } },
      getReading: () => readingAt(720_000),
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual({ attempted: [], confirmed: [] });
    expect(enqueued).toEqual([]);
  });

  it("CONFIRMS a pending threshold once a fresher handover cache appears", async () => {
    const pendingAt = new Date(Date.now() - 10_000).toISOString();
    const { deps, savedStates } = makeDeps({
      state: { confirmed: [], pending: { thresholds: ["warmup"], enqueuedAt: pendingAt } },
      cache: makeCache({ generatedAt: new Date().toISOString(), threshold: "warmup" }), // newer than pendingAt
      getReading: () => readingAt(720_000),
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result.confirmed).toEqual(["warmup"]);
    expect(savedStates[0].confirmed).toEqual(["warmup"]);
    expect(savedStates[0].pending).toBeNull();
  });

  it("does NOT confirm from a STALE cache older than the pending attempt (a leftover from an earlier session)", async () => {
    const pendingAt = new Date(Date.now() - 10_000).toISOString();
    const staleCache = makeCache({ generatedAt: new Date(Date.now() - 60_000).toISOString() }); // older than pendingAt
    const { deps, enqueued } = makeDeps({
      state: { confirmed: [], pending: { thresholds: ["warmup"], enqueuedAt: pendingAt } },
      cache: staleCache,
      getReading: () => readingAt(720_000),
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    // Neither confirmed (stale) nor re-attempted (still within the timeout window).
    expect(result).toEqual({ attempted: [], confirmed: [] });
    expect(enqueued).toEqual([]);
  });

  it("THE LIVE BUG, REPRODUCED AND FIXED: a pending attempt that never produces a cache is retried after it times out, not marked done forever", async () => {
    const longAgo = Date.now() - 10 * 60 * 1000; // 10 minutes ago — past PENDING_TIMEOUT_MS (5 min)
    const { deps, enqueued, savedStates } = makeDeps({
      state: { confirmed: [], pending: { thresholds: ["warmup", "refresh"], enqueuedAt: new Date(longAgo).toISOString() } },
      cache: null, // the daemon died mid-spawn — no cache was ever written
      getReading: () => readingAt(999_000), // still well past both thresholds
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    // Old bug: this session's marker said {"fired":["warmup","refresh"]} forever,
    // with no cache and no retry. Fixed behaviour: the timed-out pending clears,
    // both thresholds cross again, and a fresh enqueue happens.
    expect(result.attempted).toEqual(["warmup", "refresh"]);
    expect(enqueued).toEqual([{ threshold: "refresh", urgent: true }]);
    const finalState = savedStates[savedStates.length - 1];
    expect(finalState.confirmed).toEqual([]); // still not confirmed — only re-attempted
    expect(finalState.pending?.thresholds).toEqual(["warmup", "refresh"]);
  });

  it("reads an OLD-FORMAT marker file ({fired:[...]}) as nothing confirmed — self-heals the exact stuck file the bug left behind", async () => {
    // loadTriggerState (the real implementation, not this mock) is what
    // actually parses the old shape; this test exercises that directly.
    const { loadTriggerState, triggerStatePath } = await import("./context-handover-trigger.js");
    const { writeFileSync, unlinkSync, existsSync } = await import("node:fs");
    const sessionId = "old-format-test-session";
    const path = triggerStatePath(sessionId);
    writeFileSync(path, JSON.stringify({ fired: ["warmup", "refresh"] }), "utf-8");
    try {
      const state = loadTriggerState(sessionId);
      expect(state.confirmed).toEqual([]);
      expect(state.pending).toBeNull();
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it("does nothing once both thresholds are confirmed — never checks the daemon again", async () => {
    const getReading = vi.fn(() => readingAt(999_000));
    const { deps, enqueued } = makeDeps({
      state: { confirmed: ["warmup", "refresh"], pending: null },
      getReading,
    });
    const result = await checkAndEnqueueContextHandover(input, deps);
    expect(result).toEqual({ attempted: [], confirmed: [] });
    expect(enqueued).toEqual([]);
    expect(getReading).not.toHaveBeenCalled();
  });

  it("never throws even when enqueue rejects", async () => {
    const { deps } = makeDeps({
      getReading: () => readingAt(710_000),
      enqueue: async () => {
        throw new Error("boom");
      },
    });
    await expect(checkAndEnqueueContextHandover(input, deps)).resolves.toEqual({ attempted: [], confirmed: [] });
  });
});

describe("resetHandoverTriggerState — compaction reset (the one-handover-per-session-life bug)", () => {
  it("clears a fully-confirmed marker so a POST-RESET threshold crossing enqueues a NEW handover", async () => {
    const sessionId = "compaction-reset-repro-session";
    const path = triggerStatePath(sessionId);

    try {
      // Both thresholds already confirmed — exactly the state a session is
      // left in after its first model-written handover, and exactly the
      // state that used to persist for the session's entire remaining life.
      writeFileSync(path, JSON.stringify({ confirmed: ["warmup", "refresh"], pending: null }), "utf-8");

      // Sanity check on the bug itself: before any reset, the real loader
      // sees both confirmed and checkAndEnqueueContextHandover short-circuits.
      const beforeReset = await checkAndEnqueueContextHandover(
        { sessionId, cwd: "/proj" },
        {
          getReading: () => readingAt(999_000),
          loadState: loadTriggerState,
          saveState: () => {},
          readCache: () => null,
          enqueue: async () => {
            throw new Error("must not be called before reset");
          },
          now: () => Date.now(),
        }
      );
      expect(beforeReset).toEqual({ attempted: [], confirmed: [] });

      // The fix under test: a compaction happened. Reset the marker.
      resetHandoverTriggerState(sessionId);

      // Now a fresh threshold crossing (post-compaction refill) must enqueue
      // a brand-new handover — NOT return NOTHING as the old code did.
      const enqueuedThresholds: ThresholdName[] = [];
      const afterReset = await checkAndEnqueueContextHandover(
        { sessionId, cwd: "/proj" },
        {
          getReading: () => readingAt(999_000),
          loadState: loadTriggerState,
          saveState: () => {},
          readCache: () => null,
          enqueue: async (payload) => {
            enqueuedThresholds.push(payload.threshold);
          },
          now: () => Date.now(),
        }
      );

      expect(afterReset).not.toEqual({ attempted: [], confirmed: [] });
      expect(afterReset.attempted.length).toBeGreaterThan(0);
      expect(enqueuedThresholds.length).toBeGreaterThan(0);
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it("is a no-op when no marker file exists (fresh session, or already reset)", () => {
    const sessionId = "reset-noop-session-with-no-marker-file";
    const path = triggerStatePath(sessionId);
    expect(existsSync(path)).toBe(false);
    expect(() => resetHandoverTriggerState(sessionId)).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("does NOT delete the handover cache file — only the fired/confirmed marker", () => {
    const sessionId = "reset-preserves-cache-session";
    const markerPath = triggerStatePath(sessionId);
    const cachePath = contextHandoverCachePath(sessionId);

    try {
      writeFileSync(markerPath, JSON.stringify({ confirmed: ["warmup", "refresh"], pending: null }), "utf-8");
      writeContextHandoverCache({
        sessionId,
        cwd: "/proj",
        threshold: "refresh",
        generatedAt: new Date().toISOString(),
        model: "sonnet",
        summary: "this cache must survive the reset",
      });
      expect(existsSync(cachePath)).toBe(true);

      resetHandoverTriggerState(sessionId);

      expect(existsSync(markerPath)).toBe(false); // marker: gone
      expect(existsSync(cachePath)).toBe(true); // cache: untouched
    } finally {
      if (existsSync(markerPath)) unlinkSync(markerPath);
      if (existsSync(cachePath)) unlinkSync(cachePath);
    }
  });
});

describe("checkAndEnqueueContextHandover — worker sessions and foreign transcripts get no handover", () => {
  it("PAI_WORKER=1: returns nothing without reading fill, enqueuing, or writing state", async () => {
    const prev = process.env.PAI_WORKER;
    process.env.PAI_WORKER = "1";
    try {
      const getReading = vi.fn(() => readingAt(900_000));
      const { deps, enqueued, savedStates } = makeDeps({ getReading });
      const result = await checkAndEnqueueContextHandover(input, deps);
      expect(result).toEqual({ attempted: [], confirmed: [] });
      expect(getReading).not.toHaveBeenCalled();
      expect(enqueued).toEqual([]);
      expect(savedStates).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.PAI_WORKER;
      else process.env.PAI_WORKER = prev;
    }
  });

  it("transcript written by a non-claude model: returns nothing without reading fill or enqueuing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-trigger-foreign-test-"));
    const transcriptPath = join(dir, "t.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "other-model-1", content: [] } }) + "\n"
    );
    const getReading = vi.fn(() => readingAt(900_000));
    const { deps, enqueued } = makeDeps({ getReading });
    try {
      const result = await checkAndEnqueueContextHandover({ ...input, transcriptPath }, deps);
      expect(result).toEqual({ attempted: [], confirmed: [] });
      expect(getReading).not.toHaveBeenCalled();
      expect(enqueued).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("transcript written by a claude model: proceeds normally and enqueues at a crossed threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-trigger-claude-test-"));
    const transcriptPath = join(dir, "t.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-x-1", content: [] } }) + "\n"
    );
    const { deps, enqueued } = makeDeps({ getReading: () => readingAt(900_000) });
    try {
      const result = await checkAndEnqueueContextHandover({ ...input, transcriptPath }, deps);
      expect(result.attempted.length).toBeGreaterThan(0);
      expect(enqueued.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
