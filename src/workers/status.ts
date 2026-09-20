/**
 * status.ts — the live per-worker status file.
 *
 * One JSON file per run, rewritten atomically on every turn, read by `ps`,
 * `follow`, the status line and the pane logic. Same field set the Python
 * runner wrote, plus `provider` (routing is multi-provider now) and `session`
 * (the AIBroker identity of the launching session, see scope.ts).
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  /** Path the prompt was read from via --spec ("-" for stdin), when it was. */
  spec?: string | null;
  /**
   * Caller's --output-format, when the run was headless. A json/stream-json
   * caller reads its own result and is notified on process exit by the
   * harness — supervision.ts uses this to skip the duplicate relay send.
   */
  outputFormat?: "text" | "json" | "stream-json";
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
  /** Which contract/parser this run used for its final report (see report.ts). */
  reportFormat?: "json" | "ag2";
  /** Whether the final AG2 report passed `aibroker agentish check`; unset for json reports or when no validator ran. */
  reportValid?: boolean;
  /** Validation error messages, when reportValid is false. */
  reportErrors?: string[];
  /** Whether the headless prompt got the end-of-turn "final message must be…" trailer line. */
  promptTrailer?: boolean;
  /** Whether an invalid AG2 final message triggered the one bounded re-ask (see run.ts). */
  reportRetried?: boolean;
}

/** Label a worker gets when launched with neither --label nor a prompt. */
export const UNLABELED = "unlabeled";

/**
 * Whether a status is the terminal's interactive chat pane, not a spawned
 * task worker. `origin` is the real discriminator; the fallback catches
 * running entries from before the flag existed (unlabeled, no turns yet).
 * Removable once every pane runs code that writes `origin`.
 */
export function isChatPane(s: Pick<WorkerStatus, "origin" | "label" | "turns">): boolean {
  return (
    s.origin === "chat" ||
    (!s.origin && (s.label === UNLABELED || s.label === "(no prompt)") && s.turns === 0)
  );
}

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

// Temp names must be unique per writer, not just per worker: two processes
// legitimately write the same id at the same moment (`pai worker kill` marking
// a run killed while the run's own SIGTERM handler writes its terminal state).
// With one shared `<id>.status.tmp` they clobber each other's temp file and the
// loser's rename fails with ENOENT — observed live on 2026-09-19.
let tmpSeq = 0;

/** A temp path only this call owns — never the same string twice. */
export function statusTmpPath(logDir: string, id: string): string {
  return `${statusPath(logDir, id)}.${process.pid}.${tmpSeq++}.tmp`;
}

// The label this process first wrote for a given worker id: run.ts holds one
// unchanging label in memory for the whole run and passes it to every
// periodic saveStatus call, so a later call whose label still equals this
// baseline is that unmodified write, never an intentional change — on-disk
// then wins, so an external `pai worker goal` relabel between two of a
// worker's own writes survives instead of being reverted by the next one. A
// call whose label differs from the baseline (or the first call for an id in
// this process, which has no baseline yet) IS the intentional change and
// always wins — exactly the one-shot `pai worker goal` process itself.
const firstWrittenLabel = new Map<string, string>();

/** Write status atomically (temp + rename) and stamp `updated`. */
export function saveStatus(logDir: string, status: WorkerStatus, d: Date = new Date()): void {
  status.updated = nowStamp(d);
  const path = statusPath(logDir, status.id);
  const baseline = firstWrittenLabel.get(status.id);
  if (baseline === undefined) {
    firstWrittenLabel.set(status.id, status.label);
  } else if (status.label === baseline) {
    const onDisk = loadStatus(logDir, status.id);
    if (onDisk && onDisk.label !== status.label) status.label = onDisk.label;
  }
  const tmp = statusTmpPath(logDir, status.id);
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify(status), "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
    throw e;
  }
}

/**
 * Set a worker's goal (the operator's `--label`), atomically, through the
 * same saveStatus path everything else writes with. Used by `pai worker
 * goal` and the `--goal` option of `say`: a fresh call in a fresh process, so
 * it always carries no baseline yet and always wins over the worker's own
 * next periodic write (see saveStatus above).
 */
export function setWorkerLabel(logDir: string, id: string, label: string): WorkerStatus {
  const status = loadStatus(logDir, id);
  if (!status) throw new Error(`no worker named "${id}"`);
  status.label = label;
  saveStatus(logDir, status);
  return status;
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

/**
 * Wait for a worker to record its own terminal state (the run's signal
 * handler writes killed/rc/secs). Returns that status, or null when it is
 * still "running" after `timeoutMs` — the caller then writes the state itself.
 */
export async function waitForTerminalStatus(
  logDir: string,
  id: string,
  timeoutMs = 2000,
  stepMs = 50
): Promise<WorkerStatus | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = loadStatus(logDir, id);
    if (s && s.state !== "running") return s;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
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

/**
 * Whether `status.pid` still names the process that was started as this
 * worker, not a later, unrelated process the OS handed the same pid to after
 * the worker exited. `alive()` alone can't tell these apart — a pid observed
 * live on 2026-09-19 (worker 20260919-083549-90913) had been reused, and
 * `pai worker kill` signalled the wrong, unrelated process. `ps -o lstart=`
 * reads the running process's actual start time and compares it against the
 * status file's own `started` stamp; a reused pid almost never starts within
 * 120s of the original, so a wider drift means "different process".
 */
export function ownsPid(status: Pick<WorkerStatus, "pid" | "started">): boolean {
  if (status.pid <= 0 || !alive(status.pid)) return false;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(status.pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    const psStart = Date.parse(out);
    const started = Date.parse(status.started.replace(" ", "T"));
    if (Number.isNaN(psStart) || Number.isNaN(started)) return alive(status.pid);
    return Math.abs(psStart - started) <= 120_000;
  } catch {
    // pid exited between the alive() check and the ps call, or ps failed for
    // another reason — the pid-existence check is still better than nothing.
    return alive(status.pid);
  }
}

/** Whether a status is both marked "running" and still owns its recorded pid. */
export function isLive(status: Pick<WorkerStatus, "pid" | "started" | "state">): boolean {
  return status.state === "running" && ownsPid(status);
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
