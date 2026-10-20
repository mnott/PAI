/**
 * run-report-wiring.ts — the CLI side of run reporting: who reports to whom,
 * and the argv a detached run is restarted with.
 */

import { aibrokerMessenger, detachRun, markRunDone, originFromEnv, type DetachDeps, type Messenger, type RunOrigin, type RunRecord } from "./run-events.js";
import { pai } from "./plan-deps.js";
import { resolveHostSession } from "./pane.js";
import { itermUuid } from "./scope.js";

/** The origin worth reporting to: none when the caller is a bare shell with no session. */
export function reportOrigin(env: NodeJS.ProcessEnv = process.env): RunOrigin | null {
  const o = originFromEnv(env);
  return o.claudeSession || o.iterm || o.name ? o : null;
}

/**
 * The origin plus the host resolveHostSession found for this process: a
 * background Claude session has no ITERM_SESSION_ID, and its run must report
 * to the tab the resolver names (the daemon client's session). Best effort —
 * an origin with its own iterm or name needs no lookup.
 */
export async function reportOriginWithHost(env: NodeJS.ProcessEnv = process.env): Promise<RunOrigin | null> {
  const o = reportOrigin(env);
  if (!o) return null;
  if (!o.iterm && !o.host) {
    try {
      const h = await resolveHostSession(env);
      if (h.uid) o.host = h.uid;
    } catch {
      /* delivery falls back to the resolver at send time */
    }
  }
  return o;
}

export function runMessenger(logDir: string): Messenger {
  return aibrokerMessenger(logDir, undefined, async (cid) => itermUuid((await resolveHostSession({ CLAUDE_CODE_SESSION_ID: cid })).uid));
}

/** A clean end of a detached run, so the daemon sweep does not call it dead. */
export function finishDetached(logDir: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.PAI_RUN_ID) markRunDone(logDir, env.PAI_RUN_ID);
}

/** argv (after the binary) that re-runs a plan/queue run in the detached child. */
export function detachedArgv(group: "plan" | "queue", positional: string[], opts: Record<string, unknown>, skip: string[] = ["detach", "dry-run"]): string[] {
  const argv: string[] = [group, "run", ...positional];
  for (const [k, v] of Object.entries(opts)) {
    if (skip.includes(k) || v === undefined || v === false) continue;
    argv.push(`--${k}`);
    if (v !== true) argv.push(String(v));
  }
  return argv;
}

export interface DetachRequest {
  kind: "plan" | "queue";
  label: string;
  /** Positional args of the `run` command (the plan path for a plan). */
  positional: string[];
  opts: Record<string, unknown>;
  cwd: string;
  origin: RunOrigin | null;
}

/** The one place a plan/queue run is handed to a detached process; the CLI --detach and the MCP tools both call it. */
export function startDetached(logDir: string, req: DetachRequest, deps?: DetachDeps): RunRecord {
  return detachRun(logDir, req.kind, req.label, pai(), detachedArgv(req.kind, req.positional, req.opts), req.cwd, req.origin ?? {}, deps);
}
