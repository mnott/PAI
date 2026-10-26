/**
 * `POST /v1/responses` and the routes around it: read back, input items,
 * delete, cancel (response and session), sessions via previous_response_id,
 * idempotency. Output comes from events.ts, process control from runs.ts.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkersConfig } from "../workers/config.js";
import { killWorker } from "../workers/kill-tree.js";
import { resolveTarget } from "../workers/routing.js";
import { loadStatus, pidAlive } from "../workers/status.js";
import type { Principal } from "./auth.js";
import { uhpError } from "./errors.js";
import { sendJson } from "./errors.js";
import type { Assembler, UhpEventBody } from "./events.js";
import { findEntry, visibleEntries, type HarnessEntry } from "./harnesses.js";
import { modelsOf, type Probe } from "./models.js";
import { finalState, follow, launch, observe, snapshot, type RunsDeps, type WorkerLaunch } from "./runs.js";
import {
  TERMINAL,
  deleteRecord,
  listRecords,
  loadRecord,
  lookupKey,
  newResponseId,
  newSessionId,
  rememberKey,
  saveRecord,
  writePrompt,
  type FinalState,
  type ResponseRecord,
  type UhpStatus,
} from "./store.js";

export interface ResponsesDeps extends RunsDeps {
  entries: HarnessEntry[];
  workers: WorkersConfig;
  probe?: Probe;
}

const MAX_BODY = 8 * 1024 * 1024;

/** Request fields acted on; anything else the request carried is ignored and named (tasks.md 1.1). */
const HONOURED = new Set(["input", "model", "metadata", "stream", "previous_response_id", "instructions", "store", "max_step", "timeout_seconds", "background"]);

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw uhpError(413, null, "file_too_large", "The request body is too large", null, { max_bytes: MAX_BODY });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function partsText(content: unknown, ignored: Set<string>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const p of content) {
    if (!isObj(p)) continue;
    if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string") out.push(p.text);
    else if (typeof p.type === "string") ignored.add(`input.${p.type}`);
  }
  return out.join("\n");
}

/** The task text from `input`; earlier user/assistant turns of a bare conversation come first (tasks.md 2.1). */
export function promptFrom(input: unknown, ignored: Set<string>): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) throw uhpError(400, null, "invalid_input", "input must be a string or an array of items", "input");
  const turns: { role: string; text: string }[] = [];
  for (const item of input) {
    if (typeof item === "string") turns.push({ role: "user", text: item });
    else if (isObj(item) && (item.role === "user" || item.role === "assistant" || item.role === undefined)) {
      turns.push({ role: String(item.role ?? "user"), text: partsText(item.content ?? item.text, ignored) });
    }
  }
  const lastUser = turns.map((t) => t.role).lastIndexOf("user");
  if (lastUser < 0 || !turns[lastUser].text.trim()) throw uhpError(400, null, "invalid_input", "input has no user text", "input");
  const earlier = turns.slice(0, lastUser).filter((t) => t.text.trim());
  const history = earlier.length ? "Conversation so far:\n" + earlier.map((t) => `${t.role}: ${t.text}`).join("\n") + "\n\nTask:\n" : "";
  return history + turns[lastUser].text;
}

const sec = (ms: number): number => Math.floor(ms / 1000);

/** The Response object for a record in its current state. */
export function responseOf(rec: ResponseRecord, output: unknown[], status: UhpStatus, f: FinalState | null, modelNow?: string): Obj {
  const metadata: Obj = { ...rec.metadata, session_id: rec.sessionId, harness_id: rec.harnessId };
  if (rec.ignoredFields.length) metadata.ignored_fields = rec.ignoredFields;
  return {
    id: rec.id,
    object: "response",
    created_at: sec(rec.createdAt),
    status,
    error: f?.error ?? null,
    incomplete_details: f?.incompleteDetails ?? null,
    previous_response_id: rec.previousResponseId,
    model: f?.model ?? modelNow ?? rec.requestedModel ?? rec.model,
    output,
    store: rec.store,
    usage: f?.usage ?? null,
    metadata,
  };
}

/** Current state of a response: frozen when final, else assembled from the worker's log. */
export function currentResponse(d: ResponsesDeps, rec: ResponseRecord): Obj {
  if (rec.final) return responseOf(rec, rec.final.output, rec.final.status, rec.final);
  const obs = observe(d, rec);
  const asm = snapshot(d, rec);
  if (obs.phase === "ended") {
    // nobody was following (the server restarted, or a background task): freeze the result now
    const fresh = loadRecord(rec.id) ?? rec;
    const final = fresh.final ?? finalState(fresh, asm, obs.status);
    saveRecord({ ...fresh, final });
    return responseOf(fresh, final.output, final.status, final);
  }
  return responseOf(rec, asm.items, "in_progress", null, obs.status?.model);
}

/** A record the principal may see; another token's and unknown ids are the same 404. */
export function recordFor(p: Principal, id: string): ResponseRecord {
  const rec = loadRecord(id);
  if (!rec || rec.tokenId !== p.tokenId) throw uhpError(404, null, "response_not_found", "No such response", "response_id");
  return rec;
}

function workerLive(d: RunsDeps, rec: ResponseRecord): boolean {
  if (!rec.workerId) return pidAlive(rec.pid);
  const s = loadStatus(d.logDir, rec.workerId);
  if (!s) return pidAlive(rec.pid);
  return (s.state === "queued" || s.state === "running") && (pidAlive(rec.pid) || pidAlive(s.pid));
}

/** Idempotency and replay: an existing record is served in the mode the new request asks for. */
interface Mode {
  stream: boolean;
  background: boolean;
}

function sseOpen(res: ServerResponse, version: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "uhp-version": version,
  });
  res.flushHeaders();
}

/** Serve a record from its first event: stream it, wait for it, or answer in_progress. */
async function serve(d: ResponsesDeps, rec: ResponseRecord, mode: Mode, req: IncomingMessage, res: ServerResponse, version: string): Promise<void> {
  let closed = false;
  res.on("close", () => (closed = true));
  const created = responseOf(rec, [], "in_progress", null);
  if (mode.background && !mode.stream) return sendJson(res, 200, created, version);
  if (!mode.stream) {
    const done = await follow(d, rec, { event: () => undefined, keepAlive: () => undefined, gone: () => closed });
    if (!done) return;
    sendJson(res, 200, responseOf(done.rec, done.final.output, done.final.status, done.final), version);
    return afterDelivery(done.rec);
  }
  sseOpen(res, version);
  let seq = 0;
  const send = (ev: UhpEventBody) => {
    if (!closed) res.write(`data: ${JSON.stringify({ ...ev, sequence_number: seq++ })}\n\n`);
  };
  send({ type: "response.created", response: created });
  send({ type: "response.in_progress", response: created });
  const done = await follow(d, rec, { event: send, keepAlive: () => !closed && res.write(": keep-alive\n\n"), gone: () => closed });
  if (!done) return;
  const f = done.final;
  const terminal = f.status === "completed" ? "response.completed" : f.status === "incomplete" ? "response.incomplete" : "response.failed";
  send({ type: terminal, response: responseOf(done.rec, f.output, f.status, f) });
  if (!closed) res.end();
  afterDelivery(done.rec);
}

/** `store:false`: the result was delivered, nothing is kept. */
function afterDelivery(rec: ResponseRecord): void {
  if (!rec.store && rec.final) deleteRecord(rec.id);
}

function parseBody(text: string): Obj {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw uhpError(400, null, "invalid_input", "The request body is not valid JSON");
  }
  if (!isObj(body)) throw uhpError(400, null, "invalid_input", "The request body must be a JSON object");
  return body;
}

function intField(body: Obj, key: string): number | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw uhpError(400, null, "invalid_input", `${key} must be a positive integer`, key);
  return v;
}

export async function createResponse(d: ResponsesDeps, req: IncomingMessage, res: ServerResponse, p: Principal, version: string): Promise<void> {
  const raw = await readBody(req);
  const requestHash = createHash("sha256").update(raw).digest("hex");
  const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null;
  const mode = (b: Obj): Mode => ({ stream: b.stream === true, background: b.background === true });
  const replay = (): ResponseRecord | null => {
    if (!key) return null;
    const hit = lookupKey(p.tokenId, key);
    if (!hit) return null;
    if (hit.hash !== requestHash) throw uhpError(409, "invalid_request_error", "invalid_input", "This Idempotency-Key was used with a different request", "Idempotency-Key");
    return loadRecord(hit.responseId);
  };
  const body = parseBody(raw);
  const first = replay();
  if (first) return serve(d, first, mode(body), req, res, version);

  const ignored = new Set(Object.keys(body).filter((k) => !HONOURED.has(k)));
  if (body.input === undefined || body.input === null) throw uhpError(400, null, "invalid_input", "input is required", "input");
  const clientMeta = body.metadata === undefined ? {} : body.metadata;
  if (!isObj(clientMeta)) throw uhpError(400, null, "invalid_input", "metadata must be an object", "metadata");
  const wantHarness = clientMeta.harness_id;
  if (wantHarness !== undefined && typeof wantHarness !== "string") throw uhpError(400, null, "invalid_input", "metadata.harness_id must be a string", "metadata.harness_id");
  const maxStep = intField(body, "max_step");
  const timeoutSeconds = intField(body, "timeout_seconds");
  const prompt0 = promptFrom(body.input, ignored);
  const instructions = typeof body.instructions === "string" && body.instructions.trim() ? body.instructions : null;
  const requestedModel = typeof body.model === "string" && body.model ? body.model : null;

  // session: previous_response_id carries the harness, the worktree and the busy rule
  let prev: ResponseRecord | null = null;
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    if (typeof body.previous_response_id !== "string") throw uhpError(400, null, "invalid_input", "previous_response_id must be a string", "previous_response_id");
    prev = recordFor(p, body.previous_response_id);
  }
  let entry: HarnessEntry;
  if (prev) {
    entry = findEntry(d.entries, p, prev.harnessId);
    if (wantHarness !== undefined && wantHarness !== prev.harnessId) {
      throw uhpError(409, null, "harness_mismatch", "previous_response_id belongs to a different harness", "metadata.harness_id");
    }
  } else if (wantHarness !== undefined) {
    entry = findEntry(d.entries, p, wantHarness);
  } else {
    const first = defaultEntry(d, visibleEntries(d.entries, p));
    if (!first) throw uhpError(404, null, "harness_not_found", "No harness is available to this token", "harness_id");
    entry = first;
  }
  if (requestedModel) {
    const m = (await modelsOf(entry, d.probe)).models.find((x) => x.id === requestedModel);
    if (!m || !m.available) throw uhpError(422, null, "model_unavailable", `Model ${requestedModel} is not available on this harness`, "model");
  }

  // a racing identical request was registered while the checks awaited
  const raced = replay();
  if (raced) return serve(d, raced, mode(body), req, res, version);

  if (prev) {
    const siblings = listRecords().filter((r) => r.sessionId === prev!.sessionId);
    if (siblings.some((r) => workerLive(d, r))) throw uhpError(409, null, "session_busy", "A task is still running in this session", "previous_response_id");
    if (!prev.workerId || !loadStatus(d.logDir, prev.workerId)?.claudeSession) {
      throw uhpError(422, null, "invalid_input", "This harness cannot continue that session", "previous_response_id");
    }
  }

  const id = newResponseId();
  const prompt = (instructions ? `Instructions for this task:\n${instructions}\n\n` : "") + prompt0;
  const label = `uhp ${id}`;
  let spec: WorkerLaunch;
  if (prev) {
    spec = { verb: "resume", args: [prev.workerId!, prompt, "--label", label, ...(requestedModel ? ["--model", requestedModel] : [])] };
  } else {
    const specFile = writePrompt(id, prompt);
    const isClaude = entry.engine === "claude";
    if (maxStep && !isClaude) ignored.add("max_step");
    spec = {
      verb: "run",
      args: [
        "--provider", entry.provider,
        "--class", entry.className,
        ...(requestedModel ? ["--model", requestedModel] : []),
        "--label", label,
        "--spec", specFile,
        "--cwd", d.cwd,
        ...(timeoutSeconds ? ["--max-minutes", String(Math.ceil(timeoutSeconds / 60))] : []),
        ...(maxStep && isClaude ? ["--", "--max-turns", String(maxStep)] : []),
      ],
    };
  }
  if (prev && (maxStep || timeoutSeconds)) {
    if (maxStep) ignored.add("max_step");
    if (timeoutSeconds) ignored.add("timeout_seconds");
  }

  const rec: ResponseRecord = {
    id,
    tokenId: p.tokenId,
    sessionId: prev?.sessionId ?? newSessionId(),
    harnessId: entry.harness.id,
    provider: entry.provider,
    className: entry.className,
    requestedModel,
    model: entry.harness.defaultModel,
    pid: 0,
    workerId: null,
    previousResponseId: prev?.id ?? null,
    rootWorkerId: prev?.rootWorkerId ?? null,
    input: body.input,
    prompt,
    store: body.store !== false,
    ignoredFields: [...ignored].sort(),
    metadata: clientMeta,
    requestHash,
    cancelRequested: false,
    createdAt: Date.now(),
    final: null,
  };
  rec.pid = launch(d, rec, spec);
  if (!rec.pid) throw uhpError(503, null, "harness_unavailable", "The worker could not be started");
  saveRecord(rec);
  if (key) rememberKey(p.tokenId, key, requestHash, rec.id);
  return serve(d, rec, mode(body), req, res, version);
}

export function getResponse(d: ResponsesDeps, p: Principal, id: string, res: ServerResponse, version: string): void {
  const rec = recordFor(p, id);
  sendJson(res, 200, currentResponse(d, rec), version);
}

export function inputItems(p: Principal, id: string, res: ServerResponse, version: string): void {
  const rec = recordFor(p, id);
  const items = typeof rec.input === "string" ? [{ role: "user", content: [{ type: "input_text", text: rec.input }] }] : Array.isArray(rec.input) ? rec.input : [];
  const data = items.map((it, i) => ({ id: `item_${rec.id.slice(5, 13)}_${i}`, type: "message", ...(isObj(it) ? it : { role: "user", content: String(it) }) }));
  sendJson(res, 200, { object: "list", data, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null, has_more: false }, version);
}

/** Deleting forgets the record; it does not cancel a running task. */
export function removeResponse(p: Principal, id: string, res: ServerResponse, version: string): void {
  const rec = recordFor(p, id);
  deleteRecord(rec.id);
  sendJson(res, 200, { id: rec.id, object: "response.deleted", deleted: true }, version);
}

/** Freeze the output so far as cancelled, answer at once, stop the worker tree in the background. */
export function cancelRecord(d: ResponsesDeps, rec: ResponseRecord, p: Principal): Obj {
  const cur = loadRecord(rec.id) ?? rec;
  if (cur.final) return responseOf(cur, cur.final.output, cur.final.status, cur.final);
  const obs = observe(d, cur);
  if (obs.phase === "ended") return currentResponse(d, cur); // finished first: terminal, nothing to cancel
  const asm: Assembler = snapshot(d, cur);
  const final: FinalState = {
    status: "cancelled",
    output: asm.items,
    usage: asm.result?.usage ?? null,
    model: cur.requestedModel ?? obs.status?.model ?? cur.model,
    error: null,
    incompleteDetails: null,
    completedAt: sec(Date.now()),
  };
  const saved = { ...cur, workerId: cur.workerId, cancelRequested: true, final };
  saveRecord(saved);
  stopWorker(d, saved, p);
  return responseOf(saved, final.output, "cancelled", final);
}

function stopWorker(d: ResponsesDeps, rec: ResponseRecord, p: Principal): void {
  const by = `uhp:${p.tokenId}`;
  const group = () => {
    try {
      process.kill(-rec.pid, "SIGTERM");
    } catch {
      // already gone
    }
  };
  if (!rec.workerId) return group();
  killWorker(d.logDir, rec.workerId, { by, reason: "cancelled through the UHP API" }).catch(group);
}

export function cancelResponse(d: ResponsesDeps, p: Principal, id: string, res: ServerResponse, version: string): void {
  sendJson(res, 200, cancelRecord(d, recordFor(p, id), p), version);
}

/** Cancel whatever runs in the session; a session with nothing running answers with its latest response. */
export function cancelSession(d: ResponsesDeps, p: Principal, sessionId: string, res: ServerResponse, version: string): void {
  const recs = listRecords().filter((r) => r.sessionId === sessionId && r.tokenId === p.tokenId).sort((a, b) => a.createdAt - b.createdAt);
  if (!recs.length) throw uhpError(404, null, "session_not_found", "No such session", "session_id");
  const running = recs.filter((r) => !TERMINAL.has(r.final?.status ?? "in_progress"));
  const target = running.length ? running : [recs[recs.length - 1]];
  const out = target.map((r) => cancelRecord(d, r, p));
  sendJson(res, 200, out[out.length - 1], version);
}


/**
 * The harness for a request that names none: the provider PAI's normal worker routing picks for a run without
 * --provider (session, active provider, auto), never a fixed one. Its first class entry; the first visible
 * harness only when routing names nothing this token may use.
 */
export function defaultEntry(d: Pick<ResponsesDeps, "workers" | "logDir">, visible: HarnessEntry[]): HarnessEntry | undefined {
  let name: string | undefined;
  try {
    name = resolveTarget(d.workers, d.logDir, {}).providerName;
  } catch {
    name = undefined;
  }
  return visible.find((e) => e.provider === name) ?? visible[0];
}
