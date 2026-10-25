/**
 * responses.ts — POST/GET/DELETE /v1/responses, cancel, input_items. A response
 * is a worker: its state is derived from the worker status file and .jsonl,
 * never held in memory, so a dropped stream or a restarted server loses nothing.
 */

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { redactSecrets } from "../utils/redact.js";
import { type WorkersConfig } from "../workers/config.js";
import { eventsPath } from "../workers/paths.js";
import { parseWorkerReport } from "../workers/report.js";
import { loadStatus, newWorkerId, type WorkerStatus } from "../workers/status.js";
import { ResponseAssembler, sseFrame, splitLines, type EventBody, type ResponseFacts, type Terminal, type UhpStatusName } from "./events.js";
import { UhpHttpError, invalidInput, notFound } from "./errors.js";
import { listHarnesses, type PaiHarness } from "./harnesses.js";
import { providerAvailable, providerModels, type EndpointProbe } from "./models.js";
import { type WorkerRunner } from "./runner.js";
import { hashOf, type ResponseRecord, type UhpStore } from "./store.js";

export interface ServerCtx {
  config: () => WorkersConfig;
  logDir: string;
  store: UhpStore;
  runner: WorkerRunner;
  probe: EndpointProbe;
  keepAliveMs: number;
  pollMs: number;
}

const KNOWN_FIELDS = new Set([
  "input", "model", "metadata", "stream", "previous_response_id", "instructions", "store", "max_step", "timeout_seconds", "background",
]);

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

interface ParsedRequest {
  prompt: string;
  model?: string;
  harnessId?: string;
  stream: boolean;
  background: boolean;
  previous: string | null;
  instructions?: string;
  store: boolean;
  maxStep?: number;
  timeoutSeconds?: number;
  ignored: string[];
  input: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function partText(p: unknown, param: string): string {
  if (typeof p === "string") return p;
  if (isObj(p) && (p.type === "input_text" || p.type === "text") && typeof p.text === "string") return p.text;
  throw invalidInput("only text input is supported by this server", param);
}

function promptOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) throw invalidInput("input must be a string or an array of items", "input");
  const texts: string[] = [];
  for (const it of input) {
    if (isObj(it) && (it.type === "message" || it.role !== undefined) && it.content !== undefined) {
      if (typeof it.content === "string") texts.push(it.content);
      else if (Array.isArray(it.content)) for (const p of it.content) texts.push(partText(p, "input"));
      else throw invalidInput("message content must be a string or an array of parts", "input");
    } else texts.push(partText(it, "input"));
  }
  return texts.join("\n\n");
}

export function parseRequest(body: unknown): ParsedRequest {
  if (!isObj(body)) throw invalidInput("the request body must be a JSON object");
  if (body.input === undefined) throw invalidInput("input is required", "input");
  const prompt = promptOf(body.input);
  if (!prompt.trim()) throw invalidInput("input is empty", "input");
  const num = (k: string): number | undefined => {
    const v = body[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw invalidInput(`${k} must be a positive integer`, k);
    return v;
  };
  const prev = body.previous_response_id;
  if (prev !== undefined && prev !== null && typeof prev !== "string") throw invalidInput("previous_response_id must be a string or null", "previous_response_id");
  if (body.model !== undefined && body.model !== null && typeof body.model !== "string") throw invalidInput("model must be a string", "model");
  if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== "string") throw invalidInput("instructions must be a string", "instructions");
  const meta = isObj(body.metadata) ? body.metadata : {};
  const maxStep = num("max_step");
  const timeoutSeconds = num("timeout_seconds");
  const ignored = Object.keys(body).filter((k) => !KNOWN_FIELDS.has(k));
  return {
    prompt,
    ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
    ...(typeof meta.harness_id === "string" ? { harnessId: meta.harness_id } : {}),
    stream: body.stream === true,
    background: body.background === true,
    previous: typeof prev === "string" ? prev : null,
    ...(typeof body.instructions === "string" && body.instructions ? { instructions: body.instructions } : {}),
    store: body.store !== false,
    ...(maxStep !== undefined ? { maxStep } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ignored,
    input: body.input,
  };
}

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

/** No path, host or token in what a client sees (errors.md: message safe to show). */
export function safeMessage(text: string): string {
  return redactSecrets(text)
    .replace(/https?:\/\/[^\s)"']+/g, "<url>")
    .replace(/(?:~|\/)[\w.@+-]*(?:\/[\w.@+-]+)+/g, "<path>")
    .replace(/\s+at\s+\S+\s+\(.*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const LIVE = new Set(["queued", "running"]);
/** A record whose worker never wrote a status within this long is failed, not forever in progress. */
const START_GRACE_MS = 120_000;

export function deriveStatus(rec: ResponseRecord, st: WorkerStatus | null, a: ResponseAssembler, now = Date.now()): { status: UhpStatusName; term?: Terminal } {
  if (rec.cancelRequested) return { status: "cancelled", term: { status: "cancelled", error: { type: "harness_error", code: "cancelled", message: "the task was cancelled" } } };
  if (!st) {
    if (now - rec.createdAt < START_GRACE_MS) return { status: "in_progress" };
    return { status: "failed", term: { status: "failed", error: { type: "harness_error", code: "harness_unavailable", message: "the worker did not start" } } };
  }
  if (LIVE.has(st.state)) return { status: "in_progress" };
  if (st.state === "killed") return { status: "cancelled", term: { status: "cancelled", error: { type: "harness_error", code: "cancelled", message: "the task was cancelled" } } };
  const why = safeMessage(st.last ?? "");
  if (st.timedOut || st.endReason === "deadline") return { status: "incomplete", term: { status: "incomplete", incompleteReason: "timeout" } };
  if (st.loopStopped || st.endReason === "loop-stopped") return { status: "incomplete", term: { status: "incomplete", incompleteReason: "loop_stopped" } };
  if (a.resultSubtype === "error_max_turns") return { status: "incomplete", term: { status: "incomplete", incompleteReason: "max_step" } };
  if (st.state === "failed" || st.state === "lost") {
    return { status: "failed", term: { status: "failed", error: { type: "harness_error", code: "harness_error", message: why || "the task failed" } } };
  }
  const r = parseWorkerReport(a.resultText)?.result;
  if (r === "-") return { status: "failed", term: { status: "failed", error: { type: "harness_error", code: "harness_error", message: safeMessage(parseWorkerReport(a.resultText)?.why ?? "") || "the task failed" } } };
  if (r === "~" || r === "?") return { status: "incomplete", term: { status: "incomplete", incompleteReason: "budget" } };
  if (r === "!") return { status: "cancelled", term: { status: "cancelled", error: { type: "harness_error", code: "cancelled", message: "the task was cancelled" } } };
  return { status: "completed", term: { status: "completed" } };
}

function factsOf(rec: ResponseRecord): ResponseFacts {
  return {
    id: rec.id,
    model: rec.model,
    sessionId: rec.sessionId,
    previousResponseId: rec.previousResponseId,
    store: rec.store,
    createdAt: Math.floor(rec.createdAt / 1000),
    metadata: rec.metadata,
  };
}

/** Incremental reader of the worker .jsonl from a byte offset. */
class Tail {
  private off = 0;
  private rest = "";
  constructor(private readonly path: string) {}
  read(): ReturnType<typeof splitLines>["lines"] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size <= this.off) return [];
    const buf = Buffer.alloc(size - this.off);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, buf, 0, buf.length, this.off);
    } finally {
      closeSync(fd);
    }
    this.off = size;
    const { lines, rest } = splitLines(this.rest + buf.toString("utf8"));
    this.rest = rest;
    return lines;
  }
}

/** The stored record: a cancel (or anything else written since) is seen by readers holding an older copy. */
const fresh = (ctx: ServerCtx, rec: ResponseRecord): ResponseRecord => ctx.store.get(rec.id, rec.principal) ?? rec;

/** The response as it stands now: assembled from the whole .jsonl plus the derived status. */
export function snapshot(ctx: ServerCtx, rec0: ResponseRecord): Record<string, unknown> {
  const rec = fresh(ctx, rec0);
  const a = new ResponseAssembler(factsOf(rec));
  for (const l of new Tail(eventsPath(ctx.logDir, rec.workerId)).read()) a.push(l);
  const d = deriveStatus(rec, loadStatus(ctx.logDir, rec.workerId), a);
  return a.response(d.status, d.term);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function pickHarness(ctx: ServerCtx, list: PaiHarness[], req: ParsedRequest, prev: ResponseRecord | null): PaiHarness {
  if (prev) {
    if (req.harnessId && req.harnessId !== prev.harnessId) {
      throw new UhpHttpError(409, "invalid_request_error", "harness_mismatch", "a session continues on the harness it started on", "metadata.harness_id");
    }
    const h = list.find((x) => x.id === prev.harnessId);
    if (!h) throw new UhpHttpError(503, "server_error", "harness_unavailable", "the harness of this session is no longer available");
    return h;
  }
  if (req.harnessId) {
    const h = list.find((x) => x.id === req.harnessId);
    if (!h) throw notFound("harness_not_found", "no such harness");
    return h;
  }
  const active = ctx.config().active;
  const h = list.find((x) => x.provider === active && x.className === "implement") ?? list.find((x) => x.className === "implement") ?? list[0];
  if (!h) throw new UhpHttpError(503, "server_error", "harness_unavailable", "no harness is configured");
  return h;
}

const locks = new Map<string, Promise<unknown>>();
async function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  locks.set(key, run.catch(() => undefined));
  return run;
}

export interface Created {
  rec: ResponseRecord;
  req: ParsedRequest;
}

/** Validate, resolve, start (or replay an idempotent request). */
export async function createResponse(ctx: ServerCtx, principal: string, rawBody: unknown, idemKey: string | undefined): Promise<Created> {
  const req = parseRequest(rawBody);
  const bodyHash = hashOf(rawBody);
  const create = async (): Promise<Created> => {
    if (idemKey) {
      const hit = ctx.store.idempotent(principal, idemKey);
      if (hit) {
        if (hit.bodyHash !== bodyHash) {
          throw new UhpHttpError(409, "invalid_request_error", "invalid_input", "this Idempotency-Key was used with a different request", "Idempotency-Key");
        }
        const rec = ctx.store.get(hit.responseId, principal);
        if (rec) return { rec, req };
        ctx.store.forgetKey(principal, idemKey);
      }
    }
    const config = ctx.config();
    const list = listHarnesses(config);
    const prev = req.previous ? ctx.store.get(req.previous, principal) : null;
    if (req.previous && !prev) throw notFound("response_not_found", "no such response");
    const h = pickHarness(ctx, list, req, prev);
    const provider = config.providers[h.provider]!;
    let model = h.model;
    if (req.model) {
      if (!providerModels(provider).includes(req.model)) {
        throw new UhpHttpError(422, "invalid_request_error", "model_unavailable", "the model is not available on this harness", "model");
      }
      model = req.model;
    } else if (prev) model = prev.model;
    if (!(await providerAvailable(provider, ctx.probe))) {
      throw new UhpHttpError(503, "server_error", "harness_unavailable", "the harness cannot serve requests right now");
    }
    const workerId = newWorkerId();
    const sessionId = prev ? prev.sessionId : `hsess${workerId.replace(/[^A-Za-z0-9]/g, "")}`;
    if (prev) {
      for (const r of ctx.store.bySession(sessionId, principal)) {
        const st = loadStatus(ctx.logDir, r.workerId);
        if ((st && LIVE.has(st.state)) || (!st && Date.now() - r.createdAt < START_GRACE_MS && !r.cancelRequested)) {
          throw new UhpHttpError(409, "invalid_request_error", "session_busy", "the session has a task in progress");
        }
      }
    }
    const ignored = req.ignored;
    const rec: ResponseRecord = {
      id: `resp_${randomBytes(12).toString("hex")}`,
      workerId,
      sessionId,
      principal,
      harnessId: h.id,
      provider: h.provider,
      className: h.className,
      model,
      createdAt: Date.now(),
      input: req.input,
      ...(req.instructions ? { instructions: req.instructions } : {}),
      previousResponseId: prev?.id ?? null,
      store: req.store,
      metadata: { harness_id: h.id, ...(ignored.length ? { ignored_fields: ignored } : {}) },
    };
    ctx.store.put(rec);
    if (idemKey) ctx.store.recordKey(principal, idemKey, bodyHash, rec.id);
    try {
      await ctx.runner.start({
        workerId,
        prompt: req.prompt,
        provider: h.provider,
        className: h.className,
        ...(req.model || prev ? { model } : {}),
        ...(req.instructions ? { instructions: req.instructions } : {}),
        ...(req.maxStep !== undefined ? { maxTurns: req.maxStep } : {}),
        ...(req.timeoutSeconds !== undefined ? { timeoutSeconds: req.timeoutSeconds } : {}),
        ...(prev ? { resumeOf: prev.workerId } : {}),
        label: `uhp ${rec.id}`,
      });
    } catch (e) {
      ctx.store.remove(rec.id);
      if (idemKey) ctx.store.forgetKey(principal, idemKey);
      console.error(`uhp-server: worker start failed for ${rec.id}: ${e instanceof Error ? e.message : String(e)}`);
      throw new UhpHttpError(503, "server_error", "harness_unavailable", "the harness could not start the task");
    }
    return { rec, req };
  };
  // same key, same moment: the second waits for the first and then replays it
  return idemKey ? serialised(`${principal}|${idemKey}`, create) : create();
}

/** Block until the response is terminal; returns the final Response. */
export async function waitTerminal(ctx: ServerCtx, rec: ResponseRecord, closed: () => boolean): Promise<Record<string, unknown>> {
  for (;;) {
    const snap = snapshot(ctx, rec);
    if (snap.status !== "in_progress" || closed()) return snap;
    await sleep(ctx.pollMs);
  }
}

/** Stream the response from its first event; the task is not affected when the client leaves. */
export async function streamResponse(ctx: ServerCtx, rec0: ResponseRecord, res: ServerResponse): Promise<void> {
  let rec = rec0;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  let seq = 0;
  const emit = (evs: EventBody[]): void => {
    for (const ev of evs) res.write(sseFrame(seq++, ev));
  };
  const a = new ResponseAssembler(factsOf(rec));
  const tail = new Tail(eventsPath(ctx.logDir, rec.workerId));
  emit(a.opening());
  let lastWrite = Date.now();
  while (!closed) {
    rec = fresh(ctx, rec);
    const lines = tail.read();
    for (const l of lines) emit(a.push(l));
    if (lines.length) lastWrite = Date.now();
    const d = deriveStatus(rec, loadStatus(ctx.logDir, rec.workerId), a);
    if (d.status !== "in_progress") {
      // the worker may have written its last lines between the read and the status check
      for (const l of tail.read()) emit(a.push(l));
      const fin = deriveStatus(rec, loadStatus(ctx.logDir, rec.workerId), a);
      emit([a.terminal(fin.term ?? { status: fin.status as Terminal["status"] })]);
      res.end();
      return;
    }
    if (Date.now() - lastWrite >= ctx.keepAliveMs) {
      res.write(": keep-alive\n\n");
      lastWrite = Date.now();
    }
    await sleep(ctx.pollMs);
  }
}

export function getRecord(ctx: ServerCtx, principal: string, id: string): ResponseRecord {
  const rec = ctx.store.get(id, principal);
  if (!rec) throw notFound("response_not_found", "no such response");
  return rec;
}

/** Cancel: mark, ask the runner to stop the tree, answer now. A terminal response is left as it is. */
export function cancelResponse(ctx: ServerCtx, principal: string, rec: ResponseRecord): Record<string, unknown> {
  const before = snapshot(ctx, rec);
  if (before.status !== "in_progress") return before;
  rec.cancelRequested = true;
  ctx.store.put(rec);
  void ctx.runner.cancel(rec.workerId, `uhp:${principal}`).catch((e) => console.error(`uhp-server: cancel of ${rec.id} failed: ${e instanceof Error ? e.message : String(e)}`));
  return snapshot(ctx, rec);
}

export function inputItems(rec: ResponseRecord): Record<string, unknown> {
  const text = typeof rec.input === "string" ? rec.input : JSON.stringify(rec.input);
  const item = { id: `msg_in_${rec.id.slice(5)}`, type: "message", role: "user", content: [{ type: "input_text", text }] };
  return { object: "list", data: [item], first_id: item.id, last_id: item.id, has_more: false };
}

export function deleteResponse(ctx: ServerCtx, rec: ResponseRecord): Record<string, unknown> {
  const st = loadStatus(ctx.logDir, rec.workerId);
  if (st && LIVE.has(st.state) && !rec.cancelRequested) {
    throw new UhpHttpError(409, "invalid_request_error", "invalid_input", "the task is in progress; cancel it first (delete never cancels)");
  }
  ctx.store.remove(rec.id);
  return { id: rec.id, object: "response.deleted", deleted: true };
}
