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
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { shortText } from "./args.js";
import { statusPath } from "./paths.js";
import { releaseClaims, type ClaimRecord } from "../session/forge-sink.js";
import type { WaitingOn } from "./waiting.js";
import type { Denial } from "./denials.js";

export interface WorkerSessionRef {
  /** AIBroker/iTerm session id (the iTerm UUID). */
  id: string;
  /** AIBroker name of that session, when it has one. */
  name: string;
}

export interface WorkerStatus {
  id: string;
  pid: number;
  /** pid of the `pai worker run` client process; `pid` may differ (host/child pid). */
  runPid?: number;
  label: string;
  /** Latest `pai worker goal` / `say --goal` note to the worker; never replaces the label. */
  note?: string;
  /** Notes not yet handed to the worker; the PostToolUse hook drains them (note-delivery.ts). */
  notePending?: string[];
  /** When the last pending notes reached the worker (nowStamp). */
  noteDeliveredAt?: string;
  cwd: string;
  /** iTerm session id of the launching terminal ("" outside iTerm). */
  term: string;
  provider: string;
  model: string;
  state: "queued" | "running" | "done" | "failed" | "killed" | "lost";
  started: string;
  updated: string;
  turns: number;
  tools: number;
  last: string;
  rc: number | null;
  secs: number | null;
  /** Launching session resolved through AIBroker, when it was. */
  session?: WorkerSessionRef | null;
  /** Session-profile name of the launching session: the key of its `max_parallel` gate. */
  sessionKey?: string;
  /** Claude Code session id (system/init) — what `resume` continues. */
  claudeSession?: string | null;
  /**
   * Claude Code session id of the orchestrator whose Bash launched this run,
   * when the status line's session map knew it (see scope.ts). Distinct from
   * claudeSession, which is the run's own session.
   */
  spawnerSession?: string | null;
  /** Follow-pane outcome of the run start: opened, or why not. */
  pane?: { opened: boolean; reason?: string; failed?: boolean; session?: string; placement?: "split"; exec?: boolean } | null;
  /** Context meter: tokens of the last assistant turn (input+cache+output). */
  contextTokens?: number | null;
  /** Current context fill: input+cache_read+cache_creation of the latest assistant turn. */
  contextUsed?: number | null;
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
  /** Set on a resumed worker: the id whose worktree it took over (see worktree.ts adoptTree). */
  resumedFrom?: string;
  /** Set on the old id when a resume took its worktree: that id owns the tree now. */
  resumedBy?: string;
  /** Commit the branch started from (worktree base) for the commits count. */
  worktreeBase?: string | null;
  /** Whether `worktreeBase` is a snapshot of uncommitted checkout state, not HEAD. */
  worktreeSnapshot?: boolean | null;
  /** Commits the worker made on its branch; set with `branch` on success. */
  commits?: number | null;
  /** Set by `pai worker merge` once the branch landed in the original checkout. */
  merged?: boolean;
  /** Set by `pai worker gc`: the hidden ref (refs/pai-archive/<id>) holding the leftover worktree's state. */
  archived?: string | null;
  /**
   * How the run came to be: "spawn" (a `pai worker run` subagent) or "chat"
   * (the terminal's interactive pane itself, tracked like a worker). Absent
   * on statuses written before the flag existed — read as a spawn.
   */
  origin?: "spawn" | "chat";
  /**
   * Set while the start gate holds this run for the previous run on its
   * provider to warm the prompt cache (stagger.ts); state stays "running" so
   * wait/kill/pane logic still sees a live run, `last` carries the line.
   */
  warmup?: { for: string; provider: string; elapsedSec: number; limitSec: number };
  /** Set while the capacity gate queues this run behind the provider cap (capacity.ts); `last` carries the line. */
  capacity?: { provider: string; cap: number; total: number; position: number; elapsedSec: number; queued?: number; behind?: string; sinceMs?: number };
  /** Where the routing policy sent this run and why (policy.ts); absent without a policy. */
  route?: { policy: string; reason: string; local: boolean };
  /** "provider/model (session: launched on glm)" — how the provider was chosen; set at spawn. */
  routeWhy?: string;
  /**
   * Why budget routing put this run on its provider instead of a fuller one
   * ahead of it ("glm: anthropic 96% until 08:02"); absent when no switch
   * happened. Resolved once at spawn — a running worker is never switched.
   */
  switchReason?: string;
  /** Fall-through link: the local run this cloud run repeats, and (on the local run) its repeat. */
  fallThroughOf?: string;
  fallThroughTo?: string;
  /** Which contract/parser this run used for its final report (see report.ts). */
  reportFormat?: "json" | "ag2";
  /** Whether the final AG2 report passed `aibroker agentish check`; unset for json reports or when no validator ran. */
  reportValid?: boolean;
  /** Validation error messages, when reportValid is false. */
  reportErrors?: string[];
  /** Whether the headless prompt got the end-of-turn "final message must be…" trailer line. */
  promptTrailer?: boolean;
  /** The project preamble (.pai/worker.md) appended to this run's prompt: path + short content hash. */
  preamble?: { path: string; hash: string };
  /** The provider contract addendum appended to this run's prompt: path + sha256 prefix. */
  contractAddendum?: { path: string; sha: string };
  /** Whether an invalid AG2 final message triggered the one bounded re-ask (see run.ts). */
  reportRetried?: boolean;
  /**
   * Consecutive failed tool executions in this run, maintained by the runner's
   * stream loop (0 after any success). Absent on old status files — every
   * reader must treat that as "no signal".
   */
  consecFails?: number | null;
  /** Hook/permission denials the run hit (capped list, see denials.ts) and their true total. */
  denials?: Denial[];
  denialCount?: number;
  /**
   * Seconds of the most recent single long sleep observed in a Bash tool_use
   * (see parseSleepSecs), cleared when the command completes. Absent on old
   * status files.
   */
  sleepSec?: number | null;
  /** Epoch ms the run is stopped at (deadline.ts); absent = no limit. */
  deadlineAt?: number | null;
  /** Limit in minutes the deadline was derived from. */
  maxMinutes?: number | null;
  /** ms spent queued for a slot before the run started (active-time.ts); not counted against the limit. */
  queueWaitedMs?: number | null;
  /** ms blocked in build-gate waits so far; not counted against the limit. */
  blockedMs?: number | null;
  /** The loop guard stopped this run (state failed, `last` says why). */
  loopStopped?: boolean;
  /** The deadline stopped this run (state failed, `last` says why). */
  timedOut?: boolean;
  /** Launching process (the parent of `pai worker run`) at start, and its command name. */
  parentPid?: number;
  parentComm?: string;
  parentBackground?: boolean;
  /** Why the run ended (endreason.ts): exit, deadline, pai-worker-kill, parent-gone, external-signal. */
  endReason?: string;
  /** Who asked for the stop, when known (kill caller, daemon:<reason>). */
  endBy?: string;
  /** Detail for the reason (signal, sender note). */
  endNote?: string;
  /** Stated reason and force flag of a `pai worker kill` (endReason pai-worker-kill). */
  endKillReason?: string;
  endForced?: boolean;
  /**
   * What the worker is blocked on right now: written by `pai worker wait-on`
   * while it waits (null once it returns), rendered by waiting.ts.
   */
  waitingOn?: WaitingOn | null;
  /** Forge issues this worker claimed (`pai issue claim` inside it); released when it ends unless claimsContinue. */
  claims?: ClaimRecord[];
  /** The final report said the work continues (r=~): claims stay. Set by finaliseRun before the end write. */
  claimsContinue?: boolean;
  /** Per-issue errors from the best-effort release at worker end. */
  claimReleaseErrors?: string[];
  /** Ever granted clickr desktop controls (see controls.ts) — the runner returns them best-effort on exit. */
  controlsHeld?: boolean;
  /**
   * Set when the task ran through the worker session pool (pool.ts) instead
   * of a fresh claude spawn: task index within its slot, the slot's claude
   * session id (shared across tasks), and the host pid. `pid` names the slot
   * process — killing it kills the whole slot, not just this task.
   */
  pool?: { spare?: boolean; task: number; slotSession: string | null; hostPid: number; clientPid?: number; slot?: string; warm?: "warm" | "cold"; firstShare?: number };
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

/** Footer token count: 48k, 1M, 1.5M. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  return fmtContextK(n);
}

/** `<used> / <window>`, or just `<used>` when the window is unknown; "" with no reading. */
export function contextFooter(s: Pick<WorkerStatus, "contextUsed" | "contextWindow">): string {
  if (!s.contextUsed) return "";
  return s.contextWindow ? `${fmtTokens(s.contextUsed)} / ${fmtTokens(s.contextWindow)}` : fmtTokens(s.contextUsed);
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
export function saveStatus(logDir: string, status: WorkerStatus, d: Date = new Date(), external = false): void {
  status.updated = nowStamp(d);
  const path = statusPath(logDir, status.id);
  const baseline = firstWrittenLabel.get(status.id);
  if (baseline === undefined) {
    firstWrittenLabel.set(status.id, status.label);
  }
  // `external`: a one-shot writer of another process (goal, the note hook) whose copy is the fresh load, so nothing on disk may override it.
  const onDisk = baseline === undefined || external ? undefined : loadStatus(logDir, status.id);
  if (onDisk) {
    if (status.label === baseline && onDisk.label !== status.label) status.label = onDisk.label;
    // Set by another process (`pai worker controls`); a true flag is never dropped by a stale in-memory copy.
    if (onDisk.controlsHeld) status.controlsHeld = true;
    // Written by `pai worker goal` (another process); the runner's copy never sets it.
    if (onDisk.note !== undefined) status.note = onDisk.note;
    if (onDisk.notePending !== undefined) status.notePending = onDisk.notePending;
    if (onDisk.noteDeliveredAt !== undefined) status.noteDeliveredAt = onDisk.noteDeliveredAt;
    // Written by `pai worker wait-on` (another process); the runner's in-memory copy never knows it.
    if (status.waitingOn === undefined && onDisk.waitingOn) status.waitingOn = onDisk.waitingOn;
    // Recorded by `pai issue claim` (another process).
    if (status.claims === undefined && onDisk.claims) status.claims = onDisk.claims;
  }
  // The one owner of "an ended worker holds no claims" (like its pane, below): every end path saves through here.
  // "queued" is not ended: a run parked at the capacity gate keeps its claims.
  if (status.state !== "running" && status.state !== "queued" && status.claims?.length && !status.claimsContinue) {
    const errors = releaseClaims(status.cwd, status.claims);
    status.claims = [];
    if (errors.length) {
      status.claimReleaseErrors = errors;
      process.stderr.write(`claim release failed: ${errors.join("; ")}\n`);
    }
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

/**
 * Record a note to a running worker (`pai worker goal`, `say --goal`). The
 * label stays the worker's task; the note is shown beside it, never instead.
 */
export function setWorkerNote(logDir: string, id: string, note: string): WorkerStatus {
  const status = loadStatus(logDir, id);
  if (!status) throw new Error(`no worker named "${id}"`);
  status.note = note;
  status.notePending = [...(status.notePending ?? []), note];
  saveStatus(logDir, status, new Date(), true);
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

const statusCache = new Map<string, { mtimeMs: number; size: number; status: WorkerStatus | null; checked: number }>();
/** A cached terminal status is trusted this long without a stat: a finished worker's file no longer changes. */
export const TERMINAL_RECHECK_MS = 5 * 60_000;

/**
 * loadStatuses for the daemon's periodic tasks: a status file is parsed again only when its mtime or size
 * changed, so a tick over thousands of historical workers costs one readdir and one stat each, not a parse.
 * The returned objects are shared with the cache: read-only.
 */
export function loadStatusesCached(logDir: string, now = Date.now()): WorkerStatus[] {
  if (!existsSync(logDir)) return [];
  const out: WorkerStatus[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(logDir).sort()) {
    if (!name.endsWith(".status")) continue;
    const path = join(logDir, name);
    seen.add(path);
    try {
      let hit = statusCache.get(path);
      if (hit?.status && isTerminal(hit.status.state) && now - hit.checked < TERMINAL_RECHECK_MS) {
        out.push(hit.status);
        continue;
      }
      const st = statSync(path);
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
        let status: WorkerStatus | null = null;
        try {
          status = JSON.parse(readFileSync(path, "utf8")) as WorkerStatus;
        } catch {
          // a half-written or damaged status file is not worth a crash
        }
        hit = { mtimeMs: st.mtimeMs, size: st.size, status, checked: now };
        statusCache.set(path, hit);
      }
      hit.checked = now;
      if (hit.status) out.push(hit.status);
    } catch {
      statusCache.delete(path);
    }
  }
  for (const k of statusCache.keys()) if (k.startsWith(logDir) && !seen.has(k)) statusCache.delete(k);
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
 * still live ("running" or "queued") after `timeoutMs` — the caller then
 * writes the state itself.
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
    if (s && s.state !== "running" && s.state !== "queued") return s;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Signal-0 liveness probe. EPERM means the pid exists but belongs to another
 * user: `epermAlive` picks whether that counts as alive.
 */
export function pidAlive(pid: number, opts: { epermAlive?: boolean } = {}): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!opts.epermAlive && (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function alive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  return pidAlive(pid);
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
export type OwnerFields = Pick<WorkerStatus, "pid" | "started"> & { id?: string; pool?: Pick<NonNullable<WorkerStatus["pool"]>, "hostPid"> };

/**
 * Process creation time encoded in a worker id (`YYYYMMDD-HHMMSS-<pid>`), only
 * when the id's pid is the recorded pid. `started` is rewritten when a queued
 * worker acquires its provider slot, so it can be minutes after the process
 * began; the id is minted at spawn and never changes.
 */
export function spawnTimeOf(status: OwnerFields): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d+)(?:-\d+)?$/.exec(status.id ?? "");
  if (!m || Number(m[7]) !== status.pid) return undefined;
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime();
}

function parentPidOf(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return out ? Number(out) : undefined;
  } catch {
    return undefined;
  }
}

export function ownsPid(status: OwnerFields): boolean {
  // A worker served by a pool spare: its claude was started before the worker had an id or a
  // `started` stamp, so the start-time check cannot apply. It lives only while the slot's claude
  // does, verified as a child of the pool host that spawned it; the host alone never keeps it alive.
  if (status.pool) return status.pid > 0 && alive(status.pid) && parentPidOf(status.pid) === status.pool.hostPid;
  if (status.pid <= 0 || !alive(status.pid)) return false;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(status.pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    const psStart = Date.parse(out);
    const started = spawnTimeOf(status) ?? Date.parse(status.started.replace(" ", "T"));
    if (Number.isNaN(psStart) || Number.isNaN(started)) return alive(status.pid);
    return Math.abs(psStart - started) <= 120_000;
  } catch {
    // pid exited between the alive() check and the ps call, or ps failed for
    // another reason — the pid-existence check is still better than nothing.
    return alive(status.pid);
  }
}

const ownsCache = new Map<string, number>();
/** How long a verified pid ownership is trusted by the daemon's periodic tasks. */
export const OWNS_TTL_MS = 60_000;

/**
 * ownsPid for periodic daemon tasks: a pid that was verified (one blocking `ps`) is trusted for a minute while
 * it still exists, so a tick does not spawn a `ps` per running worker. Kill paths keep using ownsPid.
 */
export function ownsPidCached(status: OwnerFields, now = Date.now()): boolean {
  if (status.pid <= 0 || !alive(status.pid)) return false;
  const key = `${status.pid}:${status.started}`;
  const at = ownsCache.get(key);
  if (at !== undefined && now - at < OWNS_TTL_MS) return true;
  const ok = ownsPid(status);
  if (ok) ownsCache.set(key, now);
  else ownsCache.delete(key);
  if (ownsCache.size > 512) for (const [k, t] of ownsCache) if (now - t >= OWNS_TTL_MS) ownsCache.delete(k);
  return ok;
}

/** Any state a worker never leaves on its own: everything but "running" and "queued". */
export function isTerminal(state: WorkerStatus["state"] | undefined): boolean {
  return state !== undefined && state !== "running" && state !== "queued";
}

/** Whether a status is both marked live ("running", or "queued" at the capacity gate) and still owns its recorded pid. */
export function isLive(
  status: OwnerFields & Pick<WorkerStatus, "state">,
  owns: (s: OwnerFields) => boolean = ownsPid
): boolean {
  return (status.state === "running" || status.state === "queued") && owns(status);
}

/** How long a "running" status may sit with a dead pid before it is declared lost. */
export const LOST_GRACE_MS = 2 * 60_000;

/**
 * Rewrite every status that is "running" or "queued" with a dead pid and has
 * not been updated for `graceMs` to the terminal state "lost" (crashed or
 * killed runs that never wrote a final state), so no reader counts it.
 * Returns the ids rewritten. The one place that does this; ps, the status
 * line and the daemon call it before reading.
 */
export function reconcileStatuses(
  logDir: string,
  now: Date = new Date(),
  graceMs: number = LOST_GRACE_MS,
  owns: (s: OwnerFields) => boolean = ownsPid
): string[] {
  const lost: string[] = [];
  for (const s of loadStatuses(logDir)) {
    if ((s.state !== "running" && s.state !== "queued") || owns(s)) continue;
    const upd = Date.parse((s.updated ?? "").replace(" ", "T"));
    if (Number.isNaN(upd) || now.getTime() - upd < graceMs) continue;
    saveStatus(logDir, { ...s, state: "lost", rc: null, last: "process ended without a final status" }, now);
    lost.push(s.id);
  }
  return lost;
}

/** Record a start that died before the claude process ran: failed, with the error in `last`. */
export function markStartFailed(logDir: string, status: WorkerStatus, err: unknown): void {
  status.state = "failed";
  status.rc = status.rc ?? 1;
  status.last = "failed to start: " + (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 200);
  saveStatus(logDir, status);
}

/** "42s" under 90s, "7m" above — the coarse age the table and bar show. */
export function ageOf(ts: string, now: Date = new Date()): string {
  const t = Date.parse(ts.replace(" ", "T"));
  if (Number.isNaN(t)) return "?";
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m`;
}

/** Precise elapsed time: "45s", "1m 23s", "12m 05s", "1h 02m 05s" — seconds zero-padded after a larger unit. */
export function elapsedOf(ts: string, now: Date = new Date()): string {
  const t = Date.parse(ts.replace(" ", "T"));
  if (Number.isNaN(t)) return "?";
  const secs = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const sec = secs % 60;
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  if (mins > 0) return `${mins}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Shorter sleeps are legitimate polling — not worth a supervision event. */
export const SLEEP_FLOOR_SECS = 60;

const SLEEP_RE = /^\s*sleep\s+([0-9]+(?:\.[0-9]+)?)([smhd]?)\s*(?:$|[;&|])/;

/** s/m/h/d suffix to seconds multiplier, shared by every `sleep N<unit>` parse below. */
function sleepUnitMultiplier(unit: string): number {
  return unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86_400 : 1;
}

/**
 * Seconds of a `sleep N` (N plain or with an s/m/h/d suffix) that stands alone
 * or leads a compound command (`sleep 150; cat f`, `sleep 2m && tail f`,
 * `sleep 90 || true`, `sleep 60 &`), or null when no long sleep leads: anchored
 * to the start of the command, so a filename containing "sleep" or an
 * `echo sleep 500` never trips it, and floored at SLEEP_FLOOR_SECS so ordinary
 * polling stays invisible.
 */
export function parseSleepSecs(command: string): number | null {
  const m = command.match(SLEEP_RE);
  if (!m) return null;
  const secs = Number(m[1]) * sleepUnitMultiplier(m[2]);
  return Number.isFinite(secs) && secs >= SLEEP_FLOOR_SECS ? secs : null;
}

/**
 * Every command-segment boundary a shell recognises before a new simple
 * command can start: the very start of the string, `;`, `&`/`&&`, `|`/`||`,
 * a newline, an opening `(` or `{` (also covers `$(...)`, which ends in `(`),
 * or the keywords `do`/`then`. Segment end is the mirror image plus a closing
 * `)`, so `sleep 90` inside `$(sleep 90)` or `(sleep 90)` still counts.
 */
// The terminator is a lookahead, not a consumed match: two sleeps sharing one
// separator (`sleep 65; sleep 590`) both need that `;` available as their own
// boundary — matchAll never revisits a character a previous match consumed.
const SLEEP_SEGMENT_RE =
  /(?:^|[;&|\n(){]|\bdo\b|\bthen\b)\s*sleep\s+([0-9]+(?:\.[0-9]+)?)([smhd]?)(?=\s*(?:$|[;&|)\n]))/g;

/**
 * The longest `sleep N` found as its OWN command segment anywhere in
 * `command` — not just leading it, unlike {@link parseSleepSecs} — or null
 * when none reaches SLEEP_FLOOR_SECS. Used by the PreToolUse Bash gate
 * (block-sleep-poll.ts), which must catch a sleep buried after `&&`, inside a
 * `do ... done` loop, or in a subshell, not only one that leads the command.
 */
export function longestSleepSecs(command: string): number | null {
  let longest: number | null = null;
  for (const m of command.matchAll(SLEEP_SEGMENT_RE)) {
    const secs = Number(m[1]) * sleepUnitMultiplier(m[2]);
    if (!Number.isFinite(secs) || secs < SLEEP_FLOOR_SECS) continue;
    if (longest === null || secs > longest) longest = secs;
  }
  return longest;
}

const LOOP_RE = /\b(for|while|until)\b([^;\n]*)[;\n]\s*do\b([\s\S]*?)\bdone\b/g;

function sleepSum(text: string): number {
  let sum = 0;
  for (const m of text.matchAll(SLEEP_SEGMENT_RE)) {
    const secs = Number(m[1]) * sleepUnitMultiplier(m[2]);
    if (Number.isFinite(secs)) sum += secs;
  }
  return sum;
}

/**
 * `while ... read ...; do ...; done < file`: a bounded loop over the file's lines. Its length is
 * unknown here, so the per-step sleep stands alone (the gate's intent is "no single wait > 60s").
 */
function readsFromFile(header: string, afterDone: string): boolean {
  return /\bread\b/.test(header) && /^\s*<(?!<)/.test(afterDone);
}

/** Iterations of a `for x in <words>` header, or null when not provably small. */
function forIterations(header: string): number | null {
  const words = header.replace(/^\s*\w+\s+in\s+/, "").trim();
  if (words === header.trim() || /[$`*?]/.test(words)) return null;
  const range = /^\{(-?\d+)\.\.(-?\d+)\}$/.exec(words);
  if (range) return Math.abs(Number(range[2]) - Number(range[1])) + 1;
  return words ? words.split(/\s+/).length : 0;
}

/**
 * Total sleep of one Bash command: every `sleep N` segment counted once, plus
 * loop repetition — `for x in a b c` multiplies its body by the word count;
 * `while`/`until` and any unbounded `for` count as at least SLEEP_FLOOR_SECS,
 * except a `kill -0` job-wait (the sanctioned wait-for-a-job loop). Used by
 * the PreToolUse gate so `sleep 58; sleep 58` is caught as the 116 s it is.
 */
// ponytail: loops are not nested-aware (body ends at the first `done`); upgrade to a real shell parse if that bites.
export function totalSleepSecs(command: string): number {
  let total = sleepSum(command);
  for (const m of command.matchAll(LOOP_RE)) {
    const body = sleepSum(m[3]);
    if (body === 0) continue;
    if (m[1] === "for") {
      const n = forIterations(m[2]);
      total += n === null ? Math.max(SLEEP_FLOOR_SECS, body) : body * (n - 1);
    } else if (!/\bkill\s+-0\b/.test(m[2]) && !readsFromFile(m[2], command.slice(m.index + m[0].length))) {
      total += SLEEP_FLOOR_SECS;
    }
  }
  return total;
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
