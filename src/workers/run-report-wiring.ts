/**
 * run-report-wiring.ts — the CLI side of run reporting: who reports to whom,
 * and the argv a detached run is restarted with.
 */

import { aibrokerMessenger, detachRun, markRunDone, originFromEnv, type DetachDeps, type Messenger, type RunOrigin, type RunRecord } from "./run-events.js";
import { pai } from "./plan-deps.js";

/** The origin worth reporting to: none when the caller is a bare shell with no session. */
export function reportOrigin(env: NodeJS.ProcessEnv = process.env): RunOrigin | null {
  const o = originFromEnv(env);
  return o.claudeSession || o.iterm || o.name ? o : null;
}

export function runMessenger(logDir: string): Messenger {
  return aibrokerMessenger(logDir);
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
