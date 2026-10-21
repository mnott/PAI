/**
 * run/stream.ts — stream-event helpers: usage/context meter, tool results, success predicates, stdin messages, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { join } from "node:path";
import { type WorkerStatus } from "../status.js";
import { OPERATOR_MARK } from "../report.js";
import { inputSideTokens, type UsageBlock } from "../../utils/input-side-tokens.js";
import { type StreamEvent } from "./types.js";
import { NATIVE_MODEL_ALIASES } from "./model.js";

/** A stream-json user message for the child's stdin. */
export function stdinUserMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}

/** An operator line as the worker sees it: carrying the contract's marker. */
export function operatorUserText(text: string): string {
  return `${OPERATOR_MARK} ${text}`;
}

/**
 * ISO stamp with seconds, attached to every mirrored event (2g): local time
 * with its offset (`2026-09-17T14:19:23+02:00`), so the viewer can render the
 * wall clock the operator lives in. `offMin` is east-positive minutes —
 * injectable so tests do not depend on the machine's zone.
 */
export function isoStamp(d = new Date(), offMin = -d.getTimezoneOffset()): string {
  const t = new Date(d.getTime() + offMin * 60_000);
  const sign = offMin < 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${t.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

/**
 * Context tokens of an assistant usage block (input+cache+output). Only ever
 * meaningful on a per-turn block: a `result` event's usage is the run's
 * CUMULATIVE total (summed over all turns), so it must never feed the context
 * meter — see `bumpContextTokens`.
 */
export function usageContextTokens(u: UsageBlock | undefined): number | null {
  if (!u) return null;
  const t =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  return t > 0 ? t : null;
}

/** Current context fill of one assistant turn: the input side, no output. */
export function usageContextUsed(u: UsageBlock | undefined): number | null {
  if (!u) return null;
  const t = inputSideTokens(u);
  return t > 0 ? t : null;
}

/**
 * Context never shrinks mid-segment, so the status keeps the high-water
 * mark of the PER-TURN readings it has seen: a smaller later reading (short
 * reply, sidechain answer) must not drag the meter down. A `result` event's
 * usage is the run's cumulative total, never a turn fill, and must not be
 * passed here. Compaction is the one legitimate drop — see
 * `resetContextTokensOnCompact`.
 */
export function bumpContextTokens(status: Pick<WorkerStatus, "contextTokens">, tokens: number | null): void {
  if (tokens === null || tokens <= 0) return;
  status.contextTokens = Math.max(status.contextTokens ?? 0, tokens);
}

/**
 * A compact boundary (`system`/`compact_boundary`, the shape Claude Code
 * writes with `compactMetadata.preTokens`; `compact` kept as the older
 * spelling) legitimately restarts the context at a lower size: the floor
 * drops to the event's own usage — usually none — so the next usage
 * reading re-seeds the meter at the fresh, smaller context.
 */
export function resetContextTokensOnCompact(status: Pick<WorkerStatus, "contextTokens">, e: StreamEvent): void {
  status.contextTokens = usageContextUsed(e.usage) ?? null;
}

/** A compact boundary in a worker's stream, in either event spelling. */
export function isCompactBoundary(e: StreamEvent): boolean {
  return e.type === "system" && (e.subtype === "compact_boundary" || e.subtype === "compact");
}

/** The command string of a Bash tool_use input, "" when there is none. */
export function bashCommand(input: unknown): string {
  if (typeof input === "object" && input !== null && typeof (input as { command?: unknown }).command === "string") {
    return (input as { command: string }).command;
  }
  return "";
}

export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : ""
      )
      .join("\n");
  }
  return "";
}

/**
 * Whether a tool_result block is a failed execution: the harness's own
 * is_error flag, or — the older Bash spelling — an "Exit code N" line with a
 * non-zero N in the result text. Feeds the consecFails counter supervision's
 * thrashing detector reads.
 */
export function toolResultFailed(block: { is_error?: boolean; content?: unknown }): boolean {
  if (block.is_error === true) return true;
  const m = toolResultText(block.content).match(/Exit code (\d+)/);
  return m !== null && Number(m[1]) !== 0;
}

/**
 * The model the init event announces, adopted into the status when the spawn
 * could not name one (a caller that passed `--model` itself in the claude
 * args, or a provider whose table has no entry for the capability) or named
 * only a CLI alias (the built-in provider's "sonnet"/"haiku", which tracks
 * whatever release is current — the init event says which one actually ran).
 * The run's real model is then only knowable from the first event it sends.
 * Never overwrites a concrete resolved or pinned model — that stays the
 * recorded truth.
 */
export function adoptInitModel(status: Pick<WorkerStatus, "model">, e: StreamEvent): void {
  if (status.model && !NATIVE_MODEL_ALIASES.has(status.model)) return;
  const m = (e.model ?? "").trim();
  if (m) status.model = m;
}

/**
 * Whether an invalid final report earns the one bounded re-ask: only when a
 * real validator caught the problem (a missing/broken aibroker must never
 * block the run further), the caller did not opt out, and there is a session
 * to resume into. Cap of exactly one is enforced by the caller never calling
 * this twice for the same run.
 */
export function shouldRetryReport(
  validation: { ok: boolean; validator: "aibroker" | "none" },
  noReportRetry: boolean,
  hasSession: boolean
): boolean {
  return !validation.ok && validation.validator === "aibroker" && !noReportRetry && hasSession;
}

/** Context window announced by the init event, when the endpoint sends one. */
/**
 * An empty model response: the model "answered" without producing anything —
 * no tool ran and the result text is empty. A local model can stop at once with an empty reply;
 * it is a harness failure, not a finished run (rc 0 and a result record
 * notwithstanding). Usage plays no part: local servers report 0/0 on every
 * message, normal ones too.
 */
export function isEmptyResponse(resultText: string | undefined, tools: number): boolean {
  return tools === 0 && (resultText ?? "").trim() === "";
}

/**
 * Did the run end well? A headless run must have produced a stream-json
 * result event that is not an error; an interactive launch IS the chat pane
 * and never emits one, so its clean exit (rc 0) is the whole verdict —
 * without this every interactive session that ends normally was recorded
 * as `failed rc=0` and supervision pinged the spawner about a non-failure.
 */
export function runSucceeded(
  headless: boolean,
  rc: number,
  resultEvent: Pick<StreamEvent, "is_error"> | null,
): boolean {
  if (rc !== 0) return false;
  if (!headless) return true;
  return resultEvent !== null && !resultEvent.is_error;
}

export function initContextWindow(e: StreamEvent): number | null {
  if (typeof e.context_window === "number" && e.context_window > 0) return e.context_window;
  if (e.model_info && typeof e.model_info.context_window === "number" && e.model_info.context_window > 0) {
    return e.model_info.context_window;
  }
  // the `[1m]` model variant announces a 1M-token window by suffix
  if (/\[1m\]$/.test((e.model ?? "").trim())) return 1_000_000;
  return null;
}
