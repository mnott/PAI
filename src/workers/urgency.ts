/**
 * urgency.ts — "now, but local" from the operator's words. The UserPromptSubmit
 * hook (hooks/ts/user-prompt/urgency.ts) records an urgency window for the
 * session when the prompt asks for urgency; every worker start path reads it
 * (applyUrgency) and runs the worker with now=front, plus where=local when the
 * prompt said local, even when the model left the flag out. Explicit flags win.
 *
 * State: <pai home>/state/urgency-<session>.json {until, where?}. The session
 * is the Claude session id (hook input / CLAUDE_CODE_SESSION_ID) and, when
 * known, the session name (PAI_SESSION_NAME); a reader matches either.
 * A leaf: the hook bundle imports it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { paiHomePath } from "../config/pai-home.js";
import { currentSessionName } from "./session-profile-store.js";

export const DEFAULT_URGENCY_WINDOW_MIN = 30;

export interface UrgencyState {
  /** Epoch ms the window closes. */
  until: number;
  where?: "local";
}

const URGENT = /(?<![\p{L}\p{N}_-])(now|immediately|right away|first|asap|jetzt|sofort|gleich)(?![\p{L}\p{N}_-])/iu;
const LOCAL = /(?<![\p{L}\p{N}_-])(local|locally|lokal|lokale[nrs]?)(?![\p{L}\p{N}_-])/iu;

/** Drop fenced and inline code and quoted text: a quoted "now" is not the operator asking. */
function stripQuoted(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/“[^”\n]*”/g, " ")
    .replace(/(^|\s)'[^'\n]*'(?=\s|$|[.,;:!?])/g, " ");
}

/** Whether the operator's prompt asks for urgency, and for local. */
export function urgencyOf(prompt: string): { urgent: boolean; local: boolean } {
  const t = stripQuoted(prompt);
  return { urgent: URGENT.test(t), local: LOCAL.test(t) };
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
    try {
      const j = JSON.parse(readFileSync(stateFile(k), "utf8")) as Partial<UrgencyState>;
      if (typeof j.until === "number" && j.until > now) return { until: j.until, ...(j.where === "local" ? { where: "local" as const } : {}) };
    } catch {
      /* no window for this key */
    }
  }
  return undefined;
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
