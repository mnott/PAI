/**
 * handoff.ts — upward messages between workers.
 *
 * Coordination in the worker tree is upward only: a child appends a handoff
 * to `<logDir>/<parent>.inbox.jsonl` and (when the parent is a running
 * worker) the same text is said to it, so it lands in the parent's
 * conversation as `[handoff from <child>] …`. The parent's pane renders the
 * inbox as `◆` lines, `ps`/`worker_status` show an inbox count, and a child
 * that finishes delivers its structured report automatically as a
 * `kind: "result"` handoff. There is no downward or sideways path — telling
 * a worker something is the operator's job (`pai worker say`).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLive, loadStatus } from "./status.js";
import { sayToWorker } from "./operator.js";

export const HANDOFF_KINDS = ["proposal", "result", "question", "blocker"] as const;

export type HandoffKind = (typeof HANDOFF_KINDS)[number];

export interface Handoff {
  /** Sending worker id. */
  from: string;
  /** Receiving worker id (the parent). */
  to: string;
  kind: HandoffKind;
  text: string;
  /** Structured payload (a report, a proposal's fields, …). */
  data?: Record<string, unknown>;
  /** ISO stamp, attached on append. */
  _ts?: string;
}

/** Where a worker's handoffs land: <logDir>/<id>.inbox.jsonl. */
export function inboxPath(logDir: string, id: string): string {
  return join(logDir, `${id}.inbox.jsonl`);
}

export function isHandoffKind(v: unknown): v is HandoffKind {
  return typeof v === "string" && (HANDOFF_KINDS as readonly string[]).includes(v);
}

/**
 * Normalize a raw parsed value into a Handoff, or explain what is missing.
 * `from`/`to` may be preset by the caller (the CLI fills them from the
 * environment); everything else must be present and well-formed.
 */
export function parseHandoff(
  v: unknown,
  preset: Partial<Pick<Handoff, "from" | "to">> = {}
): Handoff {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("handoff payload must be a JSON object");
  }
  const o = v as Record<string, unknown>;
  const from = typeof o.from === "string" && o.from ? o.from : preset.from;
  const to = typeof o.to === "string" && o.to ? o.to : preset.to;
  if (!from) throw new Error(`handoff needs "from" (the sending worker id)`);
  if (!to) throw new Error(`handoff needs "to" (the parent worker id)`);
  if (!isHandoffKind(o.kind)) {
    throw new Error(`handoff "kind" must be one of: ${HANDOFF_KINDS.join(", ")}`);
  }
  const text = typeof o.text === "string" ? o.text : "";
  if (!text.trim()) throw new Error(`handoff needs a non-empty "text"`);
  const data =
    typeof o.data === "object" && o.data !== null && !Array.isArray(o.data)
      ? (o.data as Record<string, unknown>)
      : undefined;
  return { from, to, kind: o.kind, text, ...(data ? { data } : {}) };
}

/** Append one handoff to its recipient's inbox, stamped now. */
export function appendHandoff(logDir: string, h: Handoff, now: Date = new Date()): void {
  const path = inboxPath(logDir, h.to);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify({ ...h, _ts: now.toISOString() }) + "\n", "utf8");
}

/** Every handoff in a worker's inbox, oldest first; damaged lines skip. */
export function readInbox(logDir: string, id: string): Handoff[] {
  const path = inboxPath(logDir, id);
  if (!existsSync(path)) return [];
  const out: Handoff[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Handoff);
    } catch {
      // a half-written line is not worth a crash; the rest still reads
    }
  }
  return out;
}

/** How the say path prefixes a handoff so the parent model knows its source. */
export function handoffMessage(h: Pick<Handoff, "from" | "kind" | "text">): string {
  return `[handoff from ${h.from}] (${h.kind}) ${h.text.replace(/\s+/g, " ").trim()}`;
}

/** True for the exact shape of handoffMessage() — the runner marks the mirror. */
export function isHandoffMessage(text: string): boolean {
  return new RegExp(`^\\[handoff from \\S+\\] \\((${HANDOFF_KINDS.join("|")})\\) `).test(text);
}

/** Test seam for deliverHandoff: the say path, overridable with a mock. */
export interface HandoffDeps {
  say?: (id: string, text: string) => Promise<string>;
}

/**
 * Deliver one handoff: append it to the parent's inbox, then — when the
 * parent is a running worker with a live operator socket — say it so it
 * enters the parent's conversation. The say is best effort: a parent that is
 * busy, finished or gone still has the inbox line, and nothing here may make
 * a finishing child's exit path fail.
 */
export async function deliverHandoff(
  logDir: string,
  h: Handoff,
  deps: HandoffDeps = {},
  now: Date = new Date()
): Promise<Handoff> {
  appendHandoff(logDir, h, now);
  const say = deps.say ?? ((id: string, text: string) => sayToWorker(logDir, id, text));
  const parent = loadStatus(logDir, h.to);
  if (parent && isLive(parent)) {
    try {
      await say(h.to, handoffMessage(h));
    } catch {
      // the inbox line is the durable record; a failed say is not an error
    }
  }
  return h;
}

/**
 * Send a handoff from inside a worker (the `pai worker handoff` CLI and the
 * MCP tool both land here): the sender comes from PAI_WORKER_ID, the
 * recipient from its status file's `parent`. Rejects with a clear message
 * outside a worker or under a parentless worker.
 */
export async function handoffFromInside(
  logDir: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
  deps: HandoffDeps = {}
): Promise<Handoff> {
  const mine = env.PAI_WORKER_ID;
  if (!mine) {
    throw new Error(
      "not inside a worker — handoffs are sent by workers (PAI_WORKER_ID unset). " +
        "Talk to a running worker with: pai worker say <id> \"<text>\""
    );
  }
  const st = loadStatus(logDir, mine);
  if (!st) throw new Error(`no status for this worker (${mine}) — cannot find its parent`);
  if (!st.parent || !loadStatus(logDir, st.parent)) {
    throw new Error(
      `worker ${mine} has no worker parent to hand off to ` +
        `(parent: ${st.parent ?? "(none)"}) — handoffs go up the worker tree only`
    );
  }
  const h = parseHandoff(payload, { from: mine, to: st.parent });
  return deliverHandoff(logDir, h, deps);
}
