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
 * BUG FIXED (found in live use, session 77084e72-...): a threshold used to
 * be marked fired the moment the ENQUEUE call succeeded — recording intent,
 * not outcome. When the daemon worker then failed or was restarted mid-spawn
 * (observed: a daemon restart 90s after the enqueue), no handover cache was
 * ever written, but the marker already said "done" — so the session
 * compacted with the mechanical scrape only, and would never have retried,
 * ever, for that session. A threshold is now marked CONFIRMED only after a
 * handover cache file actually appears; an enqueue with no cache to show for
 * it within PENDING_TIMEOUT_MS is treated as failed and retried.
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
import { readContextHandoverCache, type ContextHandoverCache } from "../hooks/ts/lib/context-handover-cache.js";
import { PaiClient } from "../daemon/ipc-client.js";

/** The enqueue only needs to hand the item to the daemon's queue file — the
 *  actual LLM call happens later, asynchronously, in the worker loop. A
 *  short bound keeps a rare (at most twice per session) daemon hiccup from
 *  making the calling hook wait anywhere near as long as a normal IPC call
 *  is allowed to. */
const ENQUEUE_TIMEOUT_MS = 2_000;

/**
 * How long to wait for a handover cache to appear after an enqueue before
 * treating it as failed and retrying. Generous over the worker's own sonnet
 * timeout (120s, see session-summary-worker.ts's CLAUDE_TIMEOUT_MS) plus
 * queue latency, so a slow-but-working run isn't retried out from under
 * itself — and short enough that a genuinely dead attempt (a daemon restart
 * mid-spawn, exactly what happened in the live failure this fixes) is
 * retried well before the next compaction, not "never".
 */
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

/** Both thresholds confirmed — nothing left to check for the rest of the session. */
const ALL_THRESHOLDS: ThresholdName[] = ["warmup", "refresh"];

// ---------------------------------------------------------------------------
// Persisted state — outcome-based, not intent-based
// ---------------------------------------------------------------------------

/**
 * `confirmed`: thresholds whose handover was actually verified written.
 * `pending`: an enqueue attempt awaiting outcome confirmation — cleared
 * either when a fresher cache appears (success) or when PENDING_TIMEOUT_MS
 * elapses with nothing to show for it (treated as failed; retried).
 *
 * A file in the OLD shape (`{fired: [...]}`, no `confirmed` key — exactly
 * what the live failure left behind) parses with `confirmed` defaulting to
 * `[]` and `pending` to `null`: it is treated as "nothing confirmed yet",
 * which self-heals the stuck session that bug left behind rather than
 * requiring a manual cleanup step.
 */
export interface HandoverTriggerState {
  confirmed: ThresholdName[];
  pending: { thresholds: ThresholdName[]; enqueuedAt: string } | null;
}

export function triggerStatePath(sessionId: string): string {
  return join(tmpdir(), `pai-context-handover-fired-${sessionId}.json`);
}

export function loadTriggerState(sessionId: string): HandoverTriggerState {
  const path = triggerStatePath(sessionId);
  if (!existsSync(path)) return { confirmed: [], pending: null };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<HandoverTriggerState>;
    return {
      confirmed: Array.isArray(raw.confirmed) ? (raw.confirmed as ThresholdName[]) : [],
      pending: raw.pending && Array.isArray(raw.pending.thresholds) && typeof raw.pending.enqueuedAt === "string"
        ? raw.pending
        : null,
    };
  } catch {
    return { confirmed: [], pending: null };
  }
}

function saveTriggerState(sessionId: string, state: HandoverTriggerState): void {
  try {
    writeFileSync(triggerStatePath(sessionId), JSON.stringify(state), "utf-8");
  } catch {
    // Best-effort — a missing write only costs a possible re-attempt later.
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
  loadState: (sessionId: string) => HandoverTriggerState;
  saveState: (sessionId: string, state: HandoverTriggerState) => void;
  readCache: (sessionId: string) => ContextHandoverCache | null;
  enqueue: typeof enqueueContextHandover;
  now: () => number;
}

const defaultDeps: HandoverTriggerDeps = {
  getReading: (input) =>
    getContextFill({ sessionId: input.sessionId, transcriptPath: input.transcriptPath }),
  loadState: loadTriggerState,
  saveState: saveTriggerState,
  readCache: readContextHandoverCache,
  enqueue: enqueueContextHandover,
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface HandoverTriggerResult {
  /** Newly enqueued this check — an attempt, not yet a confirmed outcome. */
  attempted: ThresholdName[];
  /** Newly CONFIRMED this check — a handover cache was actually verified. */
  confirmed: ThresholdName[];
}

const NOTHING: HandoverTriggerResult = { attempted: [], confirmed: [] };

/**
 * Check this session's current context fill against the derived thresholds,
 * confirm or retry any in-flight attempt, and enqueue a context-handover job
 * for any newly-crossed threshold. Never marks a threshold done on the
 * strength of the enqueue call alone — only a verified cache file does that.
 *
 * A single check that crosses both warmup and refresh in one jump (a
 * session first observed already close to compaction) enqueues ONE job,
 * tagged with the more urgent of the two, and — once confirmed — marks both
 * done together, since one model-written handover already covers what
 * either alone would have.
 */
export async function checkAndEnqueueContextHandover(
  input: HandoverTriggerInput,
  deps: HandoverTriggerDeps = defaultDeps
): Promise<HandoverTriggerResult> {
  let state = deps.loadState(input.sessionId);
  if (ALL_THRESHOLDS.every((t) => state.confirmed.includes(t))) return NOTHING;

  // Thresholds confirmed DURING this check (from the pending-resolution step
  // below) — carried through every return path so a confirm that falls
  // through to a fresh crossing-check doesn't get silently dropped.
  let confirmedThisCheck: ThresholdName[] = [];

  // -------------------------------------------------------------------
  // Resolve any in-flight attempt first — confirm, keep waiting, or
  // time it out and clear it for retry. This is the outcome check: a
  // handover cache generated AFTER the enqueue is proof the worker ran
  // and actually wrote something, not just that the enqueue call itself
  // succeeded.
  // -------------------------------------------------------------------
  if (state.pending) {
    const cache = deps.readCache(input.sessionId);
    const cacheIsFromThisAttempt =
      cache !== null && Date.parse(cache.generatedAt) > Date.parse(state.pending.enqueuedAt);

    if (cacheIsFromThisAttempt) {
      const newlyConfirmed = state.pending.thresholds.filter((t) => !state.confirmed.includes(t));
      state = { confirmed: [...state.confirmed, ...newlyConfirmed], pending: null };
      deps.saveState(input.sessionId, state);
      confirmedThisCheck = newlyConfirmed;
      console.error(
        `[context-handover-trigger] session ${input.sessionId}: confirmed [${newlyConfirmed.join(", ")}] ` +
        `— handover cache verified (generated ${cache!.generatedAt}).`
      );
      if (ALL_THRESHOLDS.every((t) => state.confirmed.includes(t))) {
        return { attempted: [], confirmed: confirmedThisCheck };
      }
      // Fall through — a session that jumped straight to refresh-confirmed
      // territory may already have crossed further; keep checking below.
    } else if (deps.now() - Date.parse(state.pending.enqueuedAt) < PENDING_TIMEOUT_MS) {
      // Still within the window — no news is not yet failure.
      return NOTHING;
    } else {
      console.error(
        `[context-handover-trigger] session ${input.sessionId}: pending [${state.pending.thresholds.join(", ")}] ` +
        `timed out after ${PENDING_TIMEOUT_MS}ms with no handover cache written — ` +
        `treating as FAILED and retrying (daemon worker likely died or was restarted mid-run).`
      );
      state = { ...state, pending: null };
      deps.saveState(input.sessionId, state);
    }
  }

  const reading = deps.getReading(input);
  if (reading.status !== "ok" || reading.usedTokens === null) {
    return { attempted: [], confirmed: confirmedThisCheck };
  }

  const thresholds = contextFillThresholds(reading, process.env, { cwd: input.cwd });
  if (!thresholds.windowConfirmed) {
    console.error(
      `[context-handover-trigger] session ${input.sessionId}: window size not confirmed — ` +
      `using the assumed default (${reading.windowSize} tokens) rather than a reading Claude Code reported.`
    );
  }

  const newlyCrossed = crossedThresholds(reading.usedTokens, thresholds, state.confirmed);
  if (newlyCrossed.length === 0) return { attempted: [], confirmed: confirmedThisCheck };

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
      `[context-handover-trigger] session ${input.sessionId}: enqueue FAILED — will retry next check: ${err}`
    );
    // Nothing persisted — next check sees no pending and tries again.
    return { attempted: [], confirmed: confirmedThisCheck };
  }

  state = { ...state, pending: { thresholds: newlyCrossed, enqueuedAt: new Date(deps.now()).toISOString() } };
  deps.saveState(input.sessionId, state);
  console.error(
    `[context-handover-trigger] session ${input.sessionId}: enqueued [${newlyCrossed.join(", ")}] ` +
    `at ${reading.usedTokens} tokens (trigger=${thresholds.effectiveTriggerTokens}, ` +
    `triggerSource=${thresholds.triggerSource}, autocompactPct=${thresholds.autocompactPct}, urgent=${urgent}) ` +
    `— awaiting outcome confirmation before marking done.`
  );

  return { attempted: newlyCrossed, confirmed: confirmedThisCheck };
}
