/**
 * proxy-loop.ts — per-conversation loop-guard state for the monitor-only proxy guard.
 *
 * The proxy sees the whole conversation on every request, so a conversation key derives from the request itself
 * (system prompt + first user message + the client's metadata.user_id). State lives in a bounded in-memory LRU with
 * a TTL: nothing is written to disk per request. Tool results arrive in the NEXT request as tool_result blocks and
 * are fed to the same loop-guard functions the hook path uses.
 */

import { createHash } from "node:crypto";
import { emptyLoopState, probePath, recordLoopFailure, recordLoopResult, type LoopState } from "../hooks/ts/lib/loop-guard.js";

export const LOOP_MAX_CONVERSATIONS = 200;
export const LOOP_TTL_MS = 2 * 60 * 60 * 1000;

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Msg = { role?: string; content?: unknown };

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v.map((b: Block) => (typeof b === "string" ? b : b?.type === "text" ? (b.text ?? "") : "")).join("\n");
}

function messagesOf(body: unknown): Msg[] {
  const m = (body as { messages?: unknown } | null)?.messages;
  return Array.isArray(m) ? (m as Msg[]) : [];
}

/** Stable key of a conversation, or null when the request carries nothing to key on. */
export function conversationKey(body: unknown): string | null {
  const b = body as { system?: unknown; metadata?: { user_id?: unknown } } | null;
  const first = messagesOf(body).find((m) => m?.role === "user");
  if (!b || !first) return null;
  const h = createHash("sha256");
  h.update(textOf(b.system));
  h.update("\0");
  h.update(textOf(first.content));
  h.update("\0");
  h.update(typeof b.metadata?.user_id === "string" ? b.metadata.user_id : "");
  return h.digest("hex").slice(0, 32);
}

/**
 * What a not-found tool_result says. The proxy cannot ask its own disk whether a path exists (the client may be
 * another machine), so "missing" is decided from the result that answers the call: is_error AND one of these.
 */
export const NOT_FOUND_SIGNATURES: readonly RegExp[] = [/\bENOENT\b/, /no such file or directory/i, /does not exist/i, /not found/i];

export function isNotFoundResult(isError: boolean | undefined, text: string): boolean {
  return !!isError && NOT_FOUND_SIGNATURES.some((re) => re.test(text));
}

/** Bounded LRU of conversation key -> loop state with a TTL. Map insertion order is the recency order. */
export class LoopStore {
  private m = new Map<string, { state: LoopState; at: number }>();
  constructor(private max = LOOP_MAX_CONVERSATIONS, private ttlMs = LOOP_TTL_MS) {}

  get(key: string, now = Date.now()): LoopState {
    const e = this.m.get(key);
    if (!e || now - e.at > this.ttlMs) {
      this.m.delete(key);
      return emptyLoopState();
    }
    return e.state;
  }

  set(key: string, state: LoopState, now = Date.now()): void {
    this.m.delete(key);
    this.m.set(key, { state, at: now });
    for (const [k, e] of this.m) {
      if (this.m.size <= this.max && now - e.at <= this.ttlMs) break;
      this.m.delete(k);
    }
  }

  get size(): number {
    return this.m.size;
  }
}

/** The shared store of the running process. */
export const defaultLoopStore = new LoopStore();

/**
 * Records the results the request carries for the previous turn's tool calls: the tool_result blocks of the last
 * user message, matched to their tool_use blocks by id. Failures go through recordLoopFailure like PostToolUseFailure.
 */
export function applyToolResults(state: LoopState, body: unknown, now = Date.now()): LoopState {
  const msgs = messagesOf(body);
  const last = msgs[msgs.length - 1];
  if (last?.role !== "user" || !Array.isArray(last.content)) return state;
  const uses = new Map<string, { name: string; input: unknown }>();
  for (const m of msgs) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) if (b?.type === "tool_use" && b.id) uses.set(b.id, { name: String(b.name ?? ""), input: b.input });
  }
  for (const b of last.content as Block[]) {
    if (b?.type !== "tool_result" || !b.tool_use_id) continue;
    const use = uses.get(b.tool_use_id);
    if (!use?.name) continue;
    const input = use.name === "Bash" ? ((use.input as { command?: unknown } | undefined)?.command as string | undefined) : (use.input as Record<string, unknown> | undefined);
    const text = textOf(b.content);
    state = b.is_error ? recordLoopFailure(state, use.name, input, text, now, undefined, false, "proxy").state : recordLoopResult(state, use.name, input, text, now);
    if (probePath(use.name, use.input)) state = countMissing(state, isNotFoundResult(b.is_error, text));
  }
  return state;
}

/** The missing-path streak after one Read/Glob/Grep result: one more when the path was answered as not found, else reset. */
function countMissing(state: LoopState, missing: boolean): LoopState {
  const n = missing ? (state.streaks?.missing ?? 0) + 1 : 0;
  const { missing: _old, ...rest } = state.streaks ?? {};
  const streaks = n ? { ...rest, missing: n } : rest;
  return { ...state, streaks: Object.keys(streaks).length ? streaks : undefined };
}
