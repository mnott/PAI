/**
 * run/event-fold.ts — the result-event rule shared by every consumer that treats a `result` line as the run's end.
 *
 * A resumed worker (claude --resume) first replays its previous session's pending notifications (a
 * system/task_notification for a stopped background shell) and emits one `result` event answering NO turn of this
 * run — num_turns 0, duration_api_ms 0, empty text — BEFORE the real turn for the new prompt. A consumer that arms
 * its end-of-run machinery on it closes stdin and starts the leftover grace while the first tool call is still
 * running (2026-11-19: worker 20261119-045451-23508 was reaped at WORKER-LEFTOVER-ENDED mid-Bash, rc 0).
 */

import type { StreamEvent } from "./types.js";

/** The minimal event shape this fold reads: a stream-json line's type, subtype and result counters. */
export type StreamEventLike = Pick<StreamEvent, "type" | "subtype" | "num_turns" | "duration_api_ms" | "result">;

/** A result that answers no turn of its run AND says nothing: the resumed session's replay. A num_turns-0 result
 * carrying text is an empty-response outcome (isEmptyResponse reads state.resultEvent for exactly that), never a replay. */
export function isReplayedEmptyResult(e: StreamEvent): boolean {
  return (e.num_turns ?? 0) === 0 && !(e.result ?? "").trim();
}

/** The index of the last `type:"result"` line, -1 when there is none. */
function lastResultIndex(lines: string[]): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("{")) continue;
    try {
      if ((JSON.parse(lines[i]!) as StreamEvent).type === "result") idx = i;
    } catch {
      /* not json */
    }
  }
  return idx;
}

/**
 * The final `result` event of a transcript, skipping a replayed empty one: the last result answers no turn
 * (num_turns 0) while an assistant or user event follows it — the resumed session's replay, its real turn still
 * running. A real result follows an assistant turn; a transcript that ends on its num_turns-0 result keeps it
 * (the run really ended there — an empty response is still an outcome).
 */
export function finalResultEvent(lines: string[]): StreamEvent | null {
  const lastIdx = lastResultIndex(lines);
  if (lastIdx < 0) return null;
  let last: StreamEvent;
  try {
    last = JSON.parse(lines[lastIdx]!) as StreamEvent;
  } catch {
    return null;
  }
  if (!isReplayedEmptyResult(last)) return last;
  const after = lines.slice(lastIdx + 1).some((line) => {
    if (!line.startsWith("{")) return false;
    try {
      const t = (JSON.parse(line) as StreamEvent).type;
      return t === "assistant" || t === "user";
    } catch {
      return false;
    }
  });
  return after ? null : last;
}

export interface ResultFoldDeps {
  /** An assistant event was seen: a later result answers a turn of this run. */
  onTurn(): void;
  /** The run's real final result arrived: record it, close stdin, end the run. */
  onFinalResult(e: StreamEvent): void;
}

/**
 * The fold's result-event state machine: a `result` is the run's end only once an assistant event proves this run
 * answered a turn (a resumed worker's replayed num_turns-0 result answers none); a later real result still counts.
 */
export function createResultFold(d: ResultFoldDeps): { onAssistant(): void; onResult(e: StreamEvent): void } {
  let turnSeen = false;
  return {
    onAssistant() {
      turnSeen = true;
    },
    onResult(e) {
      if (!turnSeen && isReplayedEmptyResult(e)) return;
      d.onFinalResult(e);
    },
  };
}
