/**
 * context-handover-trigger.ts — decide whether THIS check is the moment a
 * session should get its threshold-triggered pre-compaction handover, and
 * enqueue it with the daemon if so.
 *
 * Called from the same live hooks that already drive the AG2 rolling
 * autosave (UserPromptSubmit, PostToolUse) — see
 * cli/commands/session/autosave.ts. Reuses the context-fill reading and the
 * derived thresholds from hooks/ts/lib/context-fill.ts; this module only
 * adds the "have we already fired this one" bookkeeping and the enqueue.
 *
 * Never throws. A daemon that isn't running, a stale reading, an unknown
 * fill — every one of those is a reason to do nothing this check and try
 * again next time, not a reason to interrupt the hook that called this.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getContextFill,
  contextFillThresholds,
  crossedThresholds,
  isImmediate,
  type ContextFillReading,
  type ThresholdName,
} from "../hooks/ts/lib/context-fill.js";
import { PaiClient } from "../daemon/ipc-client.js";

/** The enqueue only needs to hand the item to the daemon's queue file — the
 *  actual LLM call happens later, asynchronously, in the worker loop. A
 *  short bound keeps a rare (at most twice per session) daemon hiccup from
 *  making the calling hook wait anywhere near as long as a normal IPC call
 *  is allowed to. */
const ENQUEUE_TIMEOUT_MS = 2_000;

/** Both thresholds fired — nothing left to check for the rest of the session. */
const ALL_THRESHOLDS: ThresholdName[] = ["warmup", "refresh"];

// ---------------------------------------------------------------------------
// Fired-threshold bookkeeping — "at most once per threshold per session"
// ---------------------------------------------------------------------------

export function firedThresholdsPath(sessionId: string): string {
  return join(tmpdir(), `pai-context-handover-fired-${sessionId}.json`);
}

export function loadFiredThresholds(sessionId: string): ThresholdName[] {
  const path = firedThresholdsPath(sessionId);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { fired?: unknown };
    return Array.isArray(raw.fired) ? (raw.fired as ThresholdName[]) : [];
  } catch {
    return [];
  }
}

function saveFiredThresholds(sessionId: string, fired: ThresholdName[]): void {
  try {
    writeFileSync(firedThresholdsPath(sessionId), JSON.stringify({ fired }), "utf-8");
  } catch {
    // Best-effort — a missing write only costs a possible re-fire later.
  }
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface HandoverTriggerInput {
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
}

async function enqueueContextHandover(payload: {
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  threshold: ThresholdName;
  urgent: boolean;
}): Promise<void> {
  const client = new PaiClient();
  await client.call(
    "work_queue_enqueue",
    {
      type: "context-handover",
      // Below session-end (2), above session-summary (4) — this is rarer
      // than session-summary (at most twice per session) and time-sensitive
      // (it exists specifically to beat the compaction it is racing).
      priority: 3,
      payload: {
        sessionId: payload.sessionId,
        cwd: payload.cwd,
        transcriptPath: payload.transcriptPath,
        threshold: payload.threshold,
        urgent: payload.urgent,
      },
    },
    ENQUEUE_TIMEOUT_MS
  );
}

// ---------------------------------------------------------------------------
// Dependency injection — for testing without a real daemon or filesystem
// ---------------------------------------------------------------------------

export interface HandoverTriggerDeps {
  getReading: (input: HandoverTriggerInput) => ContextFillReading;
  loadFired: (sessionId: string) => ThresholdName[];
  saveFired: (sessionId: string, fired: ThresholdName[]) => void;
  enqueue: typeof enqueueContextHandover;
}

const defaultDeps: HandoverTriggerDeps = {
  getReading: (input) =>
    getContextFill({ sessionId: input.sessionId, transcriptPath: input.transcriptPath }),
  loadFired: loadFiredThresholds,
  saveFired: saveFiredThresholds,
  enqueue: enqueueContextHandover,
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Check this session's current context fill against the derived thresholds
 * and enqueue a context-handover job for any newly-crossed one. Returns the
 * threshold name(s) newly fired this call — empty when nothing crossed, the
 * reading is unknown, or every threshold has already fired.
 *
 * A single check that crosses both warmup and refresh in one jump (a
 * session first observed already close to compaction) enqueues ONE job,
 * tagged with the more urgent of the two, and marks both fired — one
 * model-written handover already covers what either alone would have.
 */
export async function checkAndEnqueueContextHandover(
  input: HandoverTriggerInput,
  deps: HandoverTriggerDeps = defaultDeps
): Promise<ThresholdName[]> {
  const alreadyFired = deps.loadFired(input.sessionId);
  if (ALL_THRESHOLDS.every((t) => alreadyFired.includes(t))) return [];

  const reading = deps.getReading(input);
  if (reading.status !== "ok" || reading.usedTokens === null) return [];

  const thresholds = contextFillThresholds(reading, process.env, { cwd: input.cwd });
  if (!thresholds.windowConfirmed) {
    console.error(
      `[context-handover-trigger] session ${input.sessionId}: window size not confirmed — ` +
      `using the assumed default (${reading.windowSize} tokens) rather than a reading Claude Code reported.`
    );
  }

  const newlyCrossed = crossedThresholds(reading.usedTokens, thresholds, alreadyFired);
  if (newlyCrossed.length === 0) return [];

  const urgent = isImmediate(reading.usedTokens, thresholds);
  const mostUrgent = newlyCrossed[newlyCrossed.length - 1];

  try {
    await deps.enqueue({
      sessionId: input.sessionId,
      cwd: input.cwd,
      transcriptPath: input.transcriptPath,
      threshold: mostUrgent,
      urgent,
    });
  } catch (err) {
    console.error(
      `[context-handover-trigger] session ${input.sessionId}: enqueue failed, will retry next check: ${err}`
    );
    // Do NOT mark fired on a failed enqueue — nothing was actually queued.
    return [];
  }

  deps.saveFired(input.sessionId, [...alreadyFired, ...newlyCrossed]);
  console.error(
    `[context-handover-trigger] session ${input.sessionId}: crossed [${newlyCrossed.join(", ")}] ` +
    `at ${reading.usedTokens} tokens (trigger=${thresholds.effectiveTriggerTokens}, ` +
    `triggerSource=${thresholds.triggerSource}, autocompactPct=${thresholds.autocompactPct}, urgent=${urgent}).`
  );

  return newlyCrossed;
}
