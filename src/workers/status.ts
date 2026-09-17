/**
 * status.ts — the live per-worker status file.
 *
 * One JSON file per run, rewritten atomically on every turn, read by `ps`,
 * `follow`, the status line and the pane logic. Same field set the Python
 * runner wrote, plus `provider` (routing is multi-provider now) and `session`
 * (the AIBroker identity of the launching session, see scope.ts).
 */

import { existsSync, readFileSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { shortText } from "./args.js";
import { statusPath } from "./paths.js";

export interface WorkerSessionRef {
  /** AIBroker/iTerm session id (the iTerm UUID). */
  id: string;
  /** AIBroker name of that session, when it has one. */
  name: string;
}

export interface WorkerStatus {
  id: string;
  pid: number;
  label: string;
  cwd: string;
  /** iTerm session id of the launching terminal ("" outside iTerm). */
  term: string;
  provider: string;
  model: string;
  state: "running" | "done" | "failed" | "killed" | "lost";
  started: string;
  updated: string;
  turns: number;
  tools: number;
  last: string;
  rc: number | null;
  secs: number | null;
  /** Launching session resolved through AIBroker, when it was. */
  session?: WorkerSessionRef | null;
  /** Claude Code session id (system/init) — what `resume` continues. */
  claudeSession?: string | null;
  /**
   * Claude Code session id of the orchestrator whose Bash launched this run,
   * when the status line's session map knew it (see scope.ts). Distinct from
   * claudeSession, which is the run's own session.
   */
  spawnerSession?: string | null;
  /** Context meter: tokens of the last assistant turn (input+cache+output). */
  contextTokens?: number | null;
  /** Context meter: window size (init model info or provider default). */
  contextWindow?: number | null;
  /** Chain this stage belongs to (the chain id), when it is a chain stage. */
  parent?: string;
  /** Class name of the chain stage ("draft", "implement", …). */
  stage?: string;
  /** Worktree this run executed in, when it got one (see worktree.ts). */
  worktreeDir?: string | null;
  /** Branch the worker committed on (worker/<id>), set on worktree runs. */
  branch?: string | null;
  /** Commit the branch started from (worktree base) for the commits count. */
  worktreeBase?: string | null;
  /** Commits the worker made on its branch; set with `branch` on success. */
  commits?: number | null;
  /** Set by `pai worker merge` once the branch landed in the original checkout. */
  merged?: boolean;
  /**
   * How the run came to be: "spawn" (a `pai worker run` subagent) or "chat"
   * (the terminal's interactive pane itself, tracked like a worker). Absent
   * on statuses written before the flag existed — read as a spawn.
   */
  origin?: "spawn" | "chat";
}

/** Label a worker gets when launched with neither --label nor a prompt. */
export const UNLABELED = "unlabeled";

/** Context-meter percentage 0–100, null when the numbers are missing. */
export function contextPercent(s: Pick<WorkerStatus, "contextTokens" | "contextWindow">): number | null {
  if (!s.contextTokens || !s.contextWindow) return null;
  return Math.round((s.contextTokens / s.contextWindow) * 100);
}

/** Compact token count: 84k, 200k, 900. */
export function fmtContextK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * The one context-meter label, shared by every renderer so identical
 * numbers always render identically: `ctx 84k/200k (42%)` — used-style
 * percent. Empty when the numbers are missing (callers drop the part).
 */
export function contextLabel(
  s: Pick<WorkerStatus, "contextTokens" | "contextWindow">
): string {
  const pct = contextPercent(s);
  if (pct === null) return "";
  return `ctx ${fmtContextK(s.contextTokens ?? 0)}/${fmtContextK(s.contextWindow ?? 0)} (${pct}%)`;
}

/** Timestamp format shared by status files and the ledger. */
export function nowStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// second-resolution ids repeat when two workers/chains start together in one
// process; a repeat gets a monotonic suffix so files never collide
let lastId = "";
let idSeq = 0;

export function newWorkerId(d: Date = new Date(), pid = process.pid): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${pid}`;
  if (base === lastId) {
    idSeq += 1;
    return `${base}-${String(idSeq).padStart(2, "0")}`;
  }
  lastId = base;
  idSeq = 0;
  return base;
}

/** Write status atomically (temp + rename) and stamp `updated`. */
export function saveStatus(logDir: string, status: WorkerStatus, d: Date = new Date()): void {
  status.updated = nowStamp(d);
  const path = statusPath(logDir, status.id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(status), "utf8");
  renameSync(tmp, path);
}

/** Load every status file in the logDir, oldest id first, skipping damage. */
export function loadStatuses(logDir: string): WorkerStatus[] {
  if (!existsSync(logDir)) return [];
  const out: WorkerStatus[] = [];
  for (const name of readdirSync(logDir).sort()) {
    if (!name.endsWith(".status")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(logDir, name), "utf8")) as WorkerStatus);
    } catch {
      // a half-written or damaged status file is not worth a crash
    }
  }
  return out;
}

export function loadStatus(logDir: string, id: string): WorkerStatus | null {
  const path = statusPath(logDir, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkerStatus;
  } catch {
    return null;
  }
}

export function alive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** "42s" under 90s, "7m" above — the coarse age the table and bar show. */
export function ageOf(ts: string, now: Date = new Date()): string {
  const t = Date.parse(ts.replace(" ", "T"));
  if (Number.isNaN(t)) return "?";
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m`;
}

/** One-line description of a tool call, e.g. "Bash: npm test". */
export function describeTool(name: string, inp: unknown): string {
  if (typeof inp !== "object" || inp === null) return name;
  const i = inp as Record<string, unknown>;
  const get = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  if (name === "Bash") return `Bash: ${shortText(get("command"), 70)}`;
  if (name === "Read" || name === "Edit" || name === "Write" || name === "MultiEdit") {
    const file = get("file_path").split("/").pop() ?? "";
    return `${name}: ${file}`;
  }
  if (name === "Grep" || name === "Glob") return `${name}: ${shortText(get("pattern"), 50)}`;
  if (name === "WebSearch") return `${name}: ${shortText(get("query"), 50)}`;
  if (name === "WebFetch") return `${name}: ${shortText(get("url"), 60)}`;
  return name;
}
