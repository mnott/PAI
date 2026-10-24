/**
 * session-provider.ts — which provider the spawning interactive session runs
 * on, so a run with no --provider follows it (routing.ts resolveTarget is the
 * only caller). Two sources, in order:
 *
 *   1. PAI_SESSION_PROVIDER, exported by `pai launch` into the session it
 *      starts ("anthropic" for the native login) and inherited by every
 *      worker that followed it.
 *   2. For sessions launched by older code: the model of the last assistant
 *      turn in the spawning Claude session's transcript. claude-* is
 *      anthropic; any other id belongs to the provider whose models list it.
 *
 * Every failure reads as "unknown" (null): routing then falls back to the
 * configured `active` provider.
 */

import { currentWorkerId } from "./worker-id.js";
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_NATIVE, getProviderOrNative, type WorkersConfig } from "./config.js";
import { loadStatus } from "./status.js";
import { claudeSessionTranscript } from "./scan.js";
import { isLocalCandidate, tierProviderNames } from "./local-candidate.js";

export const SESSION_PROVIDER_ENV = "PAI_SESSION_PROVIDER";
/** The worker side of a setup launch ("anthropic + kimi workers"): class and unflagged runs follow it; "cloud" never reads it. */
export const SESSION_WORKER_PROVIDER_ENV = "PAI_SESSION_WORKER_PROVIDER";

/** How much of the transcript's tail is searched for the last assistant turn. */
const TAIL_BYTES = 512 * 1024;

export interface SessionProvider {
  name: string;
  /** Short clause for the route line: "launched on glm", "parent model glm-5.3". */
  why: string;
}

type ProviderTable = Pick<WorkersConfig, "providers" | "nativeModels">;

function canonical(id: string): string {
  return id.trim().replace(/\[[^\]]*\]$/, "");
}

/** Provider that serves `model`; claude-* is the built-in one. */
export function providerForModel(config: ProviderTable, model: string): string | null {
  const m = canonical(model);
  if (!m || m.startsWith("<")) return null;
  if (m.startsWith("claude-")) return ANTHROPIC_NATIVE;
  const tiers = tierProviderNames();
  for (const [name, p] of Object.entries(config.providers)) {
    if (!p.enabled && !isLocalCandidate(p, name, tiers)) continue;
    if (Object.values(p.models).some((id) => typeof id === "string" && canonical(id) === m)) return name;
  }
  return null;
}

/** Model of the last assistant turn in a transcript, null when none. */
export function lastAssistantModel(transcript: string): string | null {
  let fd: number | null = null;
  let text: string;
  try {
    fd = openSync(transcript, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    text = buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"assistant"')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; message?: { model?: unknown } };
      const m = e.message?.model;
      if (e.type === "assistant" && typeof m === "string" && m && !m.startsWith("<")) return m;
    } catch {
      // first line of the tail may be cut mid-record
    }
  }
  return null;
}

/** The spawning Claude session's id: env, a worker parent's status, or CLAUDE_PID's session file. */
function spawnerClaudeSession(env: NodeJS.ProcessEnv, home: string, logDir?: string): string | null {
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
  const wid = logDir ? currentWorkerId(env, logDir) : undefined;
  if (logDir && wid) {
    const s = loadStatus(logDir, wid)?.claudeSession;
    if (s) return s;
  }
  const pid = Number(env.CLAUDE_PID);
  if (pid > 0) {
    try {
      const rec = JSON.parse(readFileSync(join(home, ".claude", "sessions", `${pid}.json`), "utf8")) as {
        sessionId?: string;
      };
      if (rec.sessionId) return rec.sessionId;
    } catch {
      // no session file for that pid
    }
  }
  return null;
}

export function detectSessionProvider(
  config: ProviderTable,
  opts: { env?: NodeJS.ProcessEnv; home?: string; cwd?: string; logDir?: string; side?: "workers" | "orchestrator" } = {}
): SessionProvider | null {
  const env = opts.env ?? process.env;
  if (opts.side === "workers") {
    const worker = env[SESSION_WORKER_PROVIDER_ENV]?.trim();
    if (worker) return { name: worker, why: `session workers on ${worker}` };
  }
  const named = env[SESSION_PROVIDER_ENV]?.trim();
  if (named) return { name: named, why: `launched on ${named}` };
  try {
    const home = opts.home ?? homedir();
    const id = spawnerClaudeSession(env, home, opts.logDir);
    if (!id) return null;
    const file = claudeSessionTranscript(id, opts.cwd ?? process.cwd(), home);
    const model = file && lastAssistantModel(file);
    if (!model) return null;
    const name = providerForModel(config, model);
    return name && getProviderOrNative(config, name) ? { name, why: `parent model ${canonical(model)}` } : null;
  } catch {
    return null;
  }
}

/**
 * Apply the child-env rule: a run that followed its session exports the
 * provider so its own sub-workers follow it too; a run given an explicit
 * --provider drops it, so its children follow that run's own flags instead.
 */
export function applySessionProviderEnv(
  env: NodeJS.ProcessEnv,
  target: { via: string; providerName: string }
): void {
  if (target.via === "flag") {
    delete env[SESSION_PROVIDER_ENV];
    delete env[SESSION_WORKER_PROVIDER_ENV];
  } else if (target.via === "session") {
    if (env[SESSION_WORKER_PROVIDER_ENV]) env[SESSION_WORKER_PROVIDER_ENV] = target.providerName;
    else env[SESSION_PROVIDER_ENV] = target.providerName;
  }
}
