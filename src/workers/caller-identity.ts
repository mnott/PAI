/**
 * caller-identity.ts — the one resolver for "who is calling", read from a
 * process env. Spawn records its output as the worker's owner (sessionKey,
 * term); the kill check derives the caller's identity with this same function
 * and compares, so the two cannot drift.
 *
 * A background-job session has no ITERM_SESSION_ID: its terminal is the suffix
 * of TERM_SESSION_ID, its name is the job's state.json "name"
 * (CLAUDE_JOB_DIR, else jobs/<first 8 of CLAUDE_CODE_SESSION_ID>).
 *
 * A daemon-hosted session (under `--bg-pty-host`) has no ITERM_SESSION_ID and
 * its TERM_SESSION_ID is inherited from whichever window started the daemon:
 * its term comes from resolveHostSession (possibly "", never the inherited one).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { itermUuid } from "./scope.js";
import { claudeHomeDir } from "../config/pai-home.js";

export interface CallerIdentity {
  /** iTerm session uuid (no "w0t0p0:" prefix), "" when none. */
  term: string;
  /** Persistent session name of a background job, when readable. */
  jobName?: string;
}

export interface CallerIdentityDeps {
  /** Claude config dir holding jobs/ (default ~/.claude). */
  claudeDir?: string;
  /** True when the calling process runs under the Claude background daemon (default: process-chain check). */
  daemonHosted?: () => boolean;
  /** Host iTerm uuid of a daemon-hosted caller (default: resolveHostSession(env)). */
  resolveHost?: () => Promise<{ uid: string }>;
}

function jobNameOf(env: NodeJS.ProcessEnv, claudeDir: string): string | undefined {
  const sid = env.CLAUDE_CODE_SESSION_ID?.trim();
  const dirs = [env.CLAUDE_JOB_DIR, sid ? join(claudeDir, "jobs", sid.slice(0, 8)) : undefined];
  for (const d of dirs) {
    if (!d) continue;
    try {
      const name = (JSON.parse(readFileSync(join(d, "state.json"), "utf8")) as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch {
      /* no readable job state here */
    }
  }
  return undefined;
}

export async function callerIdentity(env: NodeJS.ProcessEnv = process.env, deps: CallerIdentityDeps = {}): Promise<CallerIdentity> {
  let term = itermUuid(env.ITERM_SESSION_ID ?? "");
  if (!term) {
    // pane.js loads lazily: it pulls in the workers config graph, which imports this module's callers
    const pane = deps.daemonHosted && deps.resolveHost ? undefined : await import("./pane.js");
    if ((deps.daemonHosted ?? (() => pane!.underBackgroundDaemon()))()) {
      try {
        term = itermUuid((await (deps.resolveHost ?? (() => pane!.resolveHostSession(env)))()).uid);
      } catch {
        term = "";
      }
    } else {
      term = itermUuid(env.TERM_SESSION_ID ?? "");
    }
  }
  const jobName = jobNameOf(env, deps.claudeDir ?? claudeHomeDir());
  return { term, ...(jobName ? { jobName } : {}) };
}
