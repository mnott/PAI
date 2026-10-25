/**
 * uhp.ts — the "uhp" runner engine.
 *
 * A provider with `engine: "uhp"` runs a worker on any harness that speaks the
 * Unified Harness Protocol: POST {baseUrl}/v1/responses with stream:true, an
 * SSE reply parsed strictly, events normalised into claude-code-shaped lines
 * (like codex.ts) so follow/replay/report render them unchanged.
 *
 * Pure parts (request builder, SSE parser, fold) are tested with fixture
 * transcripts; runUhp/cancelUhp use fetch, so tests drive them with a local
 * HTTP server.
 */

import { providerKeyPath, resolveProviderKey, type WorkerProvider } from "./config.js";
import { uhpErrorReason, uhpStatusToResult, type Ag2Result, type UhpErrorCode } from "./uhp-vocab.js";

export const UHP_CANCEL_TIMEOUT_MS = 5000;
/** Header carrying the pinned protocol version label, when the provider sets uhpProtocol. */
export const UHP_PROTOCOL_HEADER = "UHP-Version";

export interface UhpRequestOpts {
  harnessId?: string;
  model?: string;
  previousResponseId?: string;
  maxStep?: number;
  timeoutSeconds?: number;
}

/** The JSON body of POST /v1/responses. */
export function buildUhpRequest(prompt: string, o: UhpRequestOpts = {}): Record<string, unknown> {
  return {
    input: prompt,
    stream: true,
    ...(o.model ? { model: o.model } : {}),
    ...(o.previousResponseId ? { previous_response_id: o.previousResponseId } : {}),
    ...(o.maxStep !== undefined ? { max_step: o.maxStep } : {}),
    ...(o.timeoutSeconds !== undefined ? { timeout_seconds: o.timeoutSeconds } : {}),
    metadata: { ...(o.harnessId ? { harness_id: o.harnessId } : {}) },
  };
}

export function buildUhpHeaders(provider: WorkerProvider, workerId: string): Record<string, string> {
  const key = resolveProviderKey(provider);
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    "Idempotency-Key": workerId,
    ...(provider.uhpProtocol ? { [UHP_PROTOCOL_HEADER]: provider.uhpProtocol } : {}),
  };
}

export function uhpUrl(provider: WorkerProvider, path: string): string {
  return provider.baseUrl.replace(/\/+$/, "") + path;
}

// ---------------------------------------------------------------------------
// Strict SSE parsing
// ---------------------------------------------------------------------------

export class UhpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UhpProtocolError";
  }
}

export const UHP_TERMINAL_TYPES = ["response.completed", "response.incomplete", "response.failed", "response.cancelled"] as const;

export interface UhpEvent {
  type: string;
  sequence_number: number;
  [k: string]: unknown;
}

const isTerminalType = (t: string): boolean => (UHP_TERMINAL_TYPES as readonly string[]).includes(t);

/**
 * Incremental SSE parser enforcing the UHP stream rules: every event is JSON
 * with a string `type`, sequence_number starts at 0 and rises by exactly 1,
 * and exactly one terminal event ends the stream. finish() fails when the
 * stream ends without one (including after a non-terminal `error`).
 */
export class UhpSseParser {
  private buf = "";
  private next = 0;
  private terminal: UhpEvent | null = null;
  private pendingError: UhpEvent | null = null;

  /** Feed a text chunk; returns the complete events it finished. */
  push(chunk: string): UhpEvent[] {
    this.buf += chunk.replace(/\r\n/g, "\n");
    const out: UhpEvent[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const ev = this.block(block);
      if (ev) out.push(ev);
    }
    return out;
  }

  private block(block: string): UhpEvent | null {
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return null;
    let ev: unknown;
    try {
      ev = JSON.parse(data.join("\n"));
    } catch {
      throw new UhpProtocolError(`malformed event: data is not JSON: ${data.join("\n").slice(0, 80)}`);
    }
    if (typeof ev !== "object" || ev === null || typeof (ev as { type?: unknown }).type !== "string") {
      throw new UhpProtocolError("malformed event: no string `type`");
    }
    const e = ev as UhpEvent;
    if (!Number.isInteger(e.sequence_number)) throw new UhpProtocolError(`malformed event ${e.type}: no integer sequence_number`);
    if (this.terminal) throw new UhpProtocolError(`event ${e.type} after terminal ${this.terminal.type}: exactly one terminal event allowed`);
    if (e.sequence_number !== this.next) {
      throw new UhpProtocolError(`sequence gap: expected ${this.next}, got ${e.sequence_number} (${e.type})`);
    }
    this.next += 1;
    if (isTerminalType(e.type)) this.terminal = e;
    else if (e.type === "error") this.pendingError = e;
    return e;
  }

  /** End of stream: returns the terminal event or throws. */
  finish(): UhpEvent {
    if (this.buf.trim()) {
      const ev = this.block(this.buf);
      this.buf = "";
      void ev;
    }
    if (this.terminal) return this.terminal;
    if (this.pendingError) {
      throw new UhpProtocolError(`error event not followed by a terminal event: ${errorOf(this.pendingError).message}`);
    }
    throw new UhpProtocolError("stream ended without a terminal event");
  }
}

function errorOf(e: Record<string, unknown>): { code: string; message: string } {
  const inner = (typeof e.error === "object" && e.error !== null ? e.error : e) as Record<string, unknown>;
  return {
    code: typeof inner.code === "string" ? inner.code : "",
    message: typeof inner.message === "string" ? inner.message : "uhp error",
  };
}

// ---------------------------------------------------------------------------
// Folding events into a run result
// ---------------------------------------------------------------------------

export interface UhpResult {
  /** claude-shaped transcript events produced since the last drain. */
  events: Array<Record<string, unknown>>;
  turns: number;
  tools: number;
  last: string | null;
  finalText: string | null;
  responseId: string | null;
  sessionId: string | null;
  /** Terminal status as sent (completed / incomplete / failed / cancelled), null before it. */
  status: string | null;
  result: Ag2Result | null;
  errorCode: UhpErrorCode | null;
  errorMessage: string | null;
  /** Model the harness reports having used (response.model), when it did. */
  model: string | null;
  downloadUrls: string[];
  text: string;
}

export const emptyUhpResult = (): UhpResult => ({
  events: [],
  turns: 0,
  tools: 0,
  last: null,
  finalText: null,
  responseId: null,
  sessionId: null,
  status: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  model: null,
  downloadUrls: [],
  text: "",
});

function collectUrls(v: unknown, out: string[], depth = 0): void {
  if (depth > 6 || typeof v !== "object" || v === null) return;
  if (Array.isArray(v)) {
    for (const x of v) collectUrls(x, out, depth + 1);
    return;
  }
  for (const [k, x] of Object.entries(v)) {
    if (k === "download_url" && typeof x === "string") {
      if (!out.includes(x)) out.push(x);
    } else collectUrls(x, out, depth + 1);
  }
}

function flushText(r: UhpResult, text: string): void {
  if (!text) return;
  r.turns += 1;
  r.last = `says: ${text.slice(0, 70)}`;
  r.finalText = text;
  r.events.push({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

function adoptResponse(r: UhpResult, resp: unknown): void {
  if (typeof resp !== "object" || resp === null) return;
  const o = resp as Record<string, unknown>;
  if (typeof o.id === "string") r.responseId = o.id;
  if (typeof o.model === "string") r.model = o.model;
  const meta = o.metadata;
  if (typeof meta === "object" && meta !== null && typeof (meta as { session_id?: unknown }).session_id === "string") {
    r.sessionId = (meta as { session_id: string }).session_id;
  }
}

/** Fold one parsed event into the running result. */
export function foldUhpEvent(e: UhpEvent, r: UhpResult): void {
  const type = e.type;
  if (type === "response.created" || type === "response.in_progress") {
    adoptResponse(r, e.response);
    return;
  }
  if (type === "response.output_text.delta") {
    if (typeof e.delta === "string") r.text += e.delta;
    return;
  }
  if (type === "response.output_text.done") {
    flushText(r, typeof e.text === "string" ? e.text : r.text);
    r.text = "";
    return;
  }
  if (type === "response.output_item.done" || type === "response.output_item.added") {
    const item = e.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") return;
    const done = type === "response.output_item.done";
    if (item.type === "function_call" && done) {
      r.tools += 1;
      const name = typeof item.name === "string" ? item.name : "tool";
      let input: unknown = item.arguments;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          /* keep the raw string */
        }
      }
      r.last = `${name}`;
      r.events.push({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: String(item.call_id ?? ""), name, input: input ?? {} }] },
      });
    } else if (item.type === "function_call_output" && done) {
      const out = item.output;
      r.events.push({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: String(item.call_id ?? ""),
              is_error: item.is_error === true,
              content: typeof out === "string" ? out : JSON.stringify(out ?? ""),
            },
          ],
        },
      });
    }
    return;
  }
  if (type === "error") {
    const { code, message } = errorOf(e);
    r.errorCode = uhpErrorReason(code);
    r.errorMessage = message;
    r.last = `${r.errorCode}: ${message}`.slice(0, 90);
    return;
  }
  if (isTerminalType(type)) {
    flushText(r, r.text);
    r.text = "";
    adoptResponse(r, e.response);
    collectUrls(e.response, r.downloadUrls);
    r.status = type.slice("response.".length);
    r.result = uhpStatusToResult(r.status);
    const resp = (typeof e.response === "object" && e.response !== null ? e.response : {}) as Record<string, unknown>;
    if (resp.error && typeof resp.error === "object") {
      const { code, message } = errorOf({ error: resp.error });
      r.errorCode = uhpErrorReason(code);
      r.errorMessage = message;
    }
    if (r.status === "cancelled" && !r.errorCode) r.errorCode = "cancelled";
    if (r.status === "failed" && !r.errorCode) r.errorCode = "provider_error";
  }
}

// ---------------------------------------------------------------------------
// The network run
// ---------------------------------------------------------------------------

export interface RunUhpOpts extends UhpRequestOpts {
  provider: WorkerProvider;
  workerId: string;
  prompt: string;
  signal?: AbortSignal;
  /** Called after every folded event (status updates, transcript writes). */
  onEvent?: (r: UhpResult, e: UhpEvent) => void;
  fetchImpl?: typeof fetch;
}

/** POST the request and fold the SSE reply; throws UhpProtocolError / network errors. */
export async function runUhp(o: RunUhpOpts): Promise<UhpResult> {
  const f = o.fetchImpl ?? fetch;
  const res = await f(uhpUrl(o.provider, "/v1/responses"), {
    method: "POST",
    headers: buildUhpHeaders(o.provider, o.workerId),
    body: JSON.stringify(buildUhpRequest(o.prompt, o)),
    signal: o.signal,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    const code: UhpErrorCode = res.status === 429 ? "rate_limited" : res.status >= 500 ? "harness_unavailable" : "provider_error";
    const r = emptyUhpResult();
    r.status = "failed";
    r.result = "-";
    r.errorCode = code;
    r.errorMessage = `HTTP ${res.status}: ${body}`;
    return r;
  }
  if (!res.body) throw new UhpProtocolError("empty response body");
  const parser = new UhpSseParser();
  const r = emptyUhpResult();
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const e of parser.push(dec.decode(value, { stream: true }))) {
      foldUhpEvent(e, r);
      o.onEvent?.(r, e);
    }
  }
  for (const e of parser.push(dec.decode())) {
    foldUhpEvent(e, r);
    o.onEvent?.(r, e);
  }
  parser.finish();
  return r;
}

/** POST /v1/responses/{id}/cancel, bounded to 5 s; true when the harness accepted it. */
export async function cancelUhp(
  provider: WorkerProvider,
  responseId: string,
  workerId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = UHP_CANCEL_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await fetchImpl(uhpUrl(provider, `/v1/responses/${encodeURIComponent(responseId)}/cancel`), {
      method: "POST",
      headers: buildUhpHeaders(provider, workerId),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

/** Validation problems of a uhp provider (config check); empty when fine. */
export function uhpProviderProblems(name: string, p: WorkerProvider): string[] {
  const out: string[] = [];
  if (!p.baseUrl || !/^https?:\/\//.test(p.baseUrl)) out.push(`provider "${name}" (engine uhp): baseUrl must be an http(s) URL`);
  if (!p.key && !providerKeyPath(p)) out.push(`provider "${name}" (engine uhp): no key — set keyFile (or key)`);
  return out;
}

/** Parse `--harness uhp:<id>`; throws on any other shape. */
export function parseHarnessFlag(flag: string): string {
  const m = /^uhp:(.+)$/.exec(flag.trim());
  if (!m) throw new Error(`--harness must be uhp:<harness_id>, got "${flag}"`);
  return m[1];
}

/**
 * The provider a `--harness uhp:<id>` run goes to: the named --provider when
 * given (must be a uhp provider), else the enabled uhp provider pinned to that
 * harness id, else the first enabled uhp provider without a pin.
 */
export function resolveHarnessProvider(
  providers: Record<string, WorkerProvider>,
  harnessId: string,
  providerFlag?: string,
): string {
  if (providerFlag) {
    if (providers[providerFlag]?.engine !== "uhp") throw new Error(`--harness uhp:${harnessId}: provider "${providerFlag}" is not a uhp provider (engine: "uhp")`);
    return providerFlag;
  }
  const uhp = Object.entries(providers).filter(([, p]) => p.engine === "uhp" && p.enabled);
  const hit = uhp.find(([, p]) => p.harnessId === harnessId) ?? uhp.find(([, p]) => !p.harnessId);
  if (!hit) throw new Error(`--harness uhp:${harnessId}: no enabled provider with engine "uhp" (add one to workers.yaml, see docs/uhp.md)`);
  return hit[0];
}
