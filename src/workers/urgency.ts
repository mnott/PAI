/**
 * urgency.ts — the operator's urgency window, by explicit instrumentation only.
 *
 * The window opens ONLY on the literal token `/now` (never on the word "now":
 * prose, pasted reports and worker specs must not arm it — observed 2026-10-26:
 * word matching armed 59 live windows from worker specs and pasted manager
 * reports). Paths that open it:
 *   - the UserPromptSubmit hook (hooks/ts/user-prompt/urgency.ts): any operator
 *     prompt carrying `/now` — typed, or a channel/Todoist delivery whose text
 *     carries the token (channel prefixes are allowed when they carry it);
 *   - `pai now [--session] [--local] [--minutes] [--clear]`;
 *   - the MCP tools urgency_set / urgency_clear (cockpit, PAILot).
 * Workers never open a window (PAI_WORKER=1 -> no-op).
 *
 * Effect: the session's WORKERS. Every worker start path reads the window
 * (applyUrgency) and runs the worker with now=front, plus where=local when the
 * token said local, even when the model left the flag out. Explicit flags win.
 * Workers already running when the window opens are made urgent by the hook
 * (preempt.ts, like `pai worker priority <id> now`).
 *
 * State: <pai home>/state/urgency-<session>.json {until, where?}. The session
 * is the Claude session id (hook input / CLAUDE_CODE_SESSION_ID) and, when
 * known, the session name (PAI_SESSION_NAME); a reader matches either.
 * A leaf: the hook bundle imports it.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { currentSessionName } from "./session-profile-store.js";

export const DEFAULT_URGENCY_WINDOW_MIN = 30;

export interface UrgencyState {
  /** Epoch ms the window closes. */
  until: number;
  where?: "local";
}

/** The explicit marker: the literal token `/now`, anywhere in a line. `/now local` forces where=local. */
const NOW_TOKEN = /(^|[^\w/])\/now(?![\w/])/;
const LOCAL_AFTER = /\/now(?:\s+|-)local\b/i;

/** Whether a delivered prompt carries the explicit `/now` marker, and asked for local. */
export function urgencyOf(prompt: string): { urgent: boolean; local: boolean } {
  return { urgent: NOW_TOKEN.test(prompt), local: LOCAL_AFTER.test(prompt) };
}

const stateFile = (key: string): string => paiHomePath("state", `urgency-${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

/** Keys that identify the calling session: the session id (given or from the env), then its name. */
export function urgencyKeys(env: NodeJS.ProcessEnv = process.env, sessionId?: string): string[] {
  return [...new Set([sessionId?.trim(), env.CLAUDE_CODE_SESSION_ID?.trim(), currentSessionName(env)].filter((k): k is string => !!k))];
}

/** Open (or extend) the session's urgency window. */
export function recordUrgency(keys: string[], windowMin: number, local: boolean, now = Date.now()): void {
  const state: UrgencyState = { until: now + windowMin * 60_000, ...(local ? { where: "local" as const } : {}) };
  for (const k of keys) {
    const f = stateFile(k);
    mkdirSync(paiHomePath("state"), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, f);
  }
}

/** The calling session's open urgency window, if any. */
export function readUrgency(env: NodeJS.ProcessEnv = process.env, now = Date.now()): UrgencyState | undefined {
  for (const k of urgencyKeys(env)) {
    const u = readUrgencyFor(k, now);
    if (u) return u;
  }
  return undefined;
}

/** One session's open window, by its exact key (a session id or name). */
export function readUrgencyFor(key: string, now = Date.now()): UrgencyState | undefined {
  try {
    const j = JSON.parse(readFileSync(stateFile(key), "utf8")) as Partial<UrgencyState>;
    if (typeof j.until === "number" && j.until > now) return { until: j.until, ...(j.where === "local" ? { where: "local" as const } : {}) };
  } catch {
    /* no window for this key */
  }
  return undefined;
}

/** Close the session's window (the keys it may be stored under). Returns how many files were removed. */
export function clearUrgency(env: NodeJS.ProcessEnv = process.env, sessionId?: string): number {
  let removed = 0;
  for (const k of urgencyKeys(env, sessionId)) {
    try {
      unlinkSync(stateFile(k));
      removed++;
    } catch {
      /* nothing stored under this key */
    }
  }
  return removed;
}

/** Every open window on this machine, one row per stored key (expired files are dropped). For `pai now` with no session and the status line. */
export function listUrgency(now = Date.now()): Array<{ key: string; until: number; where?: "local" }> {
  const dir = paiHomePath("state");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const rows: Array<{ key: string; until: number; where?: "local" }> = [];
  for (const name of names) {
    if (!name.startsWith("urgency-") || !name.endsWith(".json")) continue;
    const key = name.slice("urgency-".length, -".json".length);
    const u = readUrgencyFor(key, now);
    if (u) rows.push({ key, ...u });
    else {
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* gone meanwhile */
      }
    }
  }
  return rows.sort((a, b) => a.until - b.until);
}

/**
 * Fill now/where from the session's urgency window. `explicitWhere` is whatever
 * the caller named (a --where, --local or provider flag): it is never replaced.
 */
export function applyUrgency<T extends { where?: string; now?: boolean }>(args: T, explicitWhere: boolean, env: NodeJS.ProcessEnv = process.env): T {
  const u = readUrgency(env);
  if (!u) return args;
  return { ...args, now: args.now ?? true, ...(u.where && !args.where && !explicitWhere ? { where: u.where } : {}) };
}
