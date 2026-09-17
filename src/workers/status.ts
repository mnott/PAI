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
  /** Context meter: tokens of the last assistant turn (input+cache+output). */
  contextTokens?: number | null;
  /** Context meter: window size (init model info or provider default). */
  contextWindow?: number | null;
}

/** Context-meter percentage 0–100, null when the numbers are missing. */
export function contextPercent(s: Pick<WorkerStatus, "contextTokens" | "contextWindow">): number | null {
  if (!s.contextTokens || !s.contextWindow) return null;
  return Math.round((s.contextTokens / s.contextWindow) * 100);
}

/** Timestamp format shared by status files and the ledger. */
export function nowStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export function newWorkerId(d: Date = new Date(), pid = process.pid): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${pid}`;
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
