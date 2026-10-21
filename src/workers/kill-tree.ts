/**
 * kill-tree.ts — end a worker together with every live descendant.
 *
 * The tree is the one `pai worker ps` draws: status files linked by `parent`.
 * Leaves are stopped first, then their parents, each with SIGTERM, a wait for
 * the run's own terminal status, and SIGKILL when the process is still there.
 * `pai worker kill`, the deadline and the loop watch all go through here.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendLedger } from "./ledger.js";
import { callerIdentity } from "./caller-identity.js";
import { itermUuid } from "./scope.js";
import { appendStopEvent, callerDescription, requestKill } from "./endreason.js";
import {
  loadStatus,
  loadStatuses,
  ownsPid,
  pidAlive,
  saveStatus,
  waitForTerminalStatus,
  type WorkerStatus,
} from "./status.js";
import { ledgerPath } from "./paths.js";
import { buildsDir, releaseBuildsOf } from "../builds/queue.js";

export interface KillTreeDeps {
  signal: (pid: number, sig: NodeJS.Signals) => void;
  owns: (s: WorkerStatus) => boolean;
  isAlive: (pid: number) => boolean;
  waitTerminal: (logDir: string, id: string) => Promise<WorkerStatus | null>;
  request: (logDir: string, ledger: string, id: string, forced?: boolean, by?: string, reason?: string) => void;
  /** Tell the owning session one of its workers was stopped by someone else. */
  notifyOwner: (ownerSession: string, text: string) => Promise<void>;
  /** Wait after SIGKILL is not needed; this is the grace between SIGTERM and SIGKILL. */
  graceMs: number;
}

const defaultDeps = (): KillTreeDeps => ({
  signal: (pid, sig) => void process.kill(pid, sig),
  owns: ownsPid,
  isAlive: (pid) => pidAlive(pid),
  waitTerminal: (dir, id) => waitForTerminalStatus(dir, id),
  request: (dir, ledger, id, forced, by, reason) => requestKill(dir, ledger, id, by ?? callerDescription(), forced === true, reason),
  notifyOwner: async (session, text) => {
    const { sendToSession } = await import("../cli/lib/aibroker-client.js");
    await sendToSession(session, text, undefined, { noReply: true });
  },
  graceMs: 1000,
});

/** Identities under which a worker's owner session can appear: launching session name/key, spawner Claude session. */
function ownerIdentities(s: WorkerStatus): string[] {
  const ids = [s.session?.name, s.sessionKey, itermUuid(s.term ?? ""), s.spawnerSession, s.spawnerSession ? `claude-session:${s.spawnerSession}` : undefined];
  return ids.filter((x): x is string => !!x);
}

/**
 * Caller process facts for the chain check: `processTree` maps a pid to its
 * [ppid, tty], `commands` its command line. Injected by tests; the real one
 * reads `ps`. Only consulted when env-based identity does not match.
 */
export interface CallerProcessInfo {
  processTree?: (start: number) => Map<number, [number, string]>;
  commands?: (pids: number[]) => Map<number, string>;
  pid?: number;
  home?: string;
}

/** pid -> [ppid, tty] for the ancestor chain of `start`, via one `ps` call. */
function realProcessTree(start: number): Map<number, [number, string]> {
  const out = new Map<number, [number, string]>();
  let pid = start;
  for (let hops = 0; hops < 40 && pid > 0; hops++) {
    try {
      const row = execFileSync("ps", ["-o", "ppid=,tty=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/);
      if (row.length < 2) break; // pid gone
      const ppid = Number(row[0]);
      out.set(pid, [ppid, row[1] ?? ""]);
      pid = ppid;
    } catch {
      break;
    }
  }
  return out;
}

function realCommands(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  try {
    const outStr = execFileSync("ps", ["-o", "pid=,command=", "-p", pids.join(",")], { encoding: "utf8" });
    for (const line of outStr.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m) out.set(Number(m[1]), m[2]);
    }
  } catch {
    /* ps failed: no command lines */
  }
  return out;
}

/**
 * Claude session ids the calling process chain carries: CLAUDE_PID's session
 * file, plus every ancestor command line's `--session-id <uuid>` or
 * `--bg-pty-host …/pty/<short>.sock` (the short id matches a recorded id that
 * starts with it). A background-job session has no TTY, no ITERM_SESSION_ID
 * and no session id in its Bash env — the chain is the only identity left.
 */
function callerChainSessionIds(
  info: CallerProcessInfo,
  env: NodeJS.ProcessEnv,
  owners: string[],
  start: number = info.pid ?? process.pid
): { full: Set<string>; short: Set<string> } {
  const full = new Set<string>();
  const short = new Set<string>();
  if (env.CLAUDE_CODE_SESSION_ID) full.add(env.CLAUDE_CODE_SESSION_ID);
  // an explicit tree skips the real ps walk; commands still default to the real ps
  const tree = info.processTree?.(start) ?? realProcessTree(start);
  const pids = [...tree.keys()];
  // command lines cost a ps: fetch them only when a recorded spawner identity could match
  const needCmds = owners.some((o) => /^[0-9a-f]{8}-/i.test(o)) || info.commands !== undefined;
  const cmds = needCmds ? (info.commands?.(pids) ?? realCommands(pids)) : new Map<number, string>();
  const claudePid = Number(env.CLAUDE_PID);
  if (claudePid > 0) {
    try {
      const rec = JSON.parse(readFileSync(join(info.home ?? homedir(), ".claude", "sessions", `${claudePid}.json`), "utf8")) as {
        sessionId?: string;
      };
      if (rec.sessionId) full.add(rec.sessionId);
    } catch {
      /* no session file for that pid */
    }
  }
  for (const pid of pids) {
    // tolerate a map keyed by pid strings (injected test data)
    const cmd = cmds.get(pid) ?? (cmds as Map<unknown, string>).get(String(pid)) ?? "";
    const m = /--session-id\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(cmd);
    if (m) full.add(m[1]);
    const s = /--bg-pty-host\s+\S*\/pty\/([0-9a-f]{8})\.sock/i.exec(cmd);
    if (s) short.add(s[1]);
  }
  return { full, short };
}

/** True when the calling session is one of the worker's owner identities. */
export function isOwner(
  s: WorkerStatus,
  env: NodeJS.ProcessEnv,
  proc: CallerProcessInfo = {}
): boolean {
  const owners = ownerIdentities(s);
  if (owners.includes(callerDescription(env))) return true;
  // same resolver spawn uses to record sessionKey/term
  const me = callerIdentity(env, { claudeDir: proc.home ? join(proc.home, ".claude") : undefined });
  if (me.term && owners.includes(me.term)) return true;
  if (me.jobName && owners.includes(me.jobName)) return true;
  if (env.CLAUDE_CODE_SESSION_ID && owners.includes(env.CLAUDE_CODE_SESSION_ID)) return true;
  // background-job sessions carry no env identity: match the spawning process
  // chain against what the status recorded at spawn (parentPid, spawnerSession).
  if (s.parentPid && Number(env.CLAUDE_PID) === s.parentPid) return true;
  const ids = callerChainSessionIds(proc, env, owners);
  for (const o of owners) {
    if (ids.full.has(o)) return true;
    for (const sh of ids.short) if (o.startsWith(`${sh}-`)) return true;
  }
  return false;
}

/**
 * Refusal text when a session-originated kill targets another session's worker, else null.
 * No recorded owner keeps the old behaviour; the owner session always passes.
 */
export function killRefusal(
  s: WorkerStatus,
  env: NodeJS.ProcessEnv,
  force: boolean,
  reason?: string,
  proc: CallerProcessInfo = {}
): string | null {
  const owners = ownerIdentities(s);
  if (force) {
    if (env.PAI_WORKER) return `worker ${s.id}: --force is only for the operator's terminal, not from a worker process`;
    if (owners.length && !isOwner(s, env, proc) && !reason?.trim())
      return `worker ${s.id}: --force on another session's worker needs --reason "<text>"`;
    return null;
  }
  if (!owners.length) return null;
  if (isOwner(s, env, proc)) return null;
  const owner = s.session?.name || s.sessionKey || owners[0];
  return `worker ${s.id} belongs to session ${owner}; refused (use --force from the operator's terminal or that session)`;
}

/** Live descendants of `id`, deepest first (leaves before their parents). */
export function descendantsLeavesFirst(statuses: WorkerStatus[], id: string): WorkerStatus[] {
  const out: { s: WorkerStatus; depth: number }[] = [];
  const seen = new Set<string>([id]);
  let level = [id];
  for (let depth = 1; level.length; depth++) {
    const next: string[] = [];
    for (const s of statuses) {
      if (!s.parent || !level.includes(s.parent) || seen.has(s.id)) continue;
      seen.add(s.id);
      next.push(s.id);
      if (s.state === "running" || s.state === "queued") out.push({ s, depth });
    }
    level = next;
  }
  return out.sort((a, b) => b.depth - a.depth).map((x) => x.s);
}

interface Stop {
  by: string;
  forced: boolean;
  reason: string;
  /** The killer is not the worker's owner: the owner session is told. */
  foreign: boolean;
}

async function killOne(logDir: string, recorded: WorkerStatus, d: KillTreeDeps, stop: Stop): Promise<string> {
  const id = recorded.id;
  // A pooled task's `pid` is the shared slot process; the process to end is its `pai worker run` client,
  // whose disconnect makes the pool host cancel the task and write the terminal status.
  const clientPid = recorded.pool?.clientPid;
  const status: WorkerStatus = clientPid ? { ...recorded, pid: clientPid } : recorded;
  if (!status.pid || status.pid <= 0) return `skipped worker ${id}: no pid recorded`;
  if (!d.owns(status)) {
    recorded.state = "lost";
    recorded.last = `pid ${status.pid} no longer belongs to this worker (reused); marked lost`;
    recorded.rc = null;
    saveStatus(logDir, recorded);
    return `worker ${id}: pid ${status.pid} is not this worker any more (started ${status.started}); marked lost, nothing signalled`;
  }
  d.request(logDir, ledgerPath(logDir), id, stop.forced, stop.by, stop.reason);
  appendStopEvent(logDir, id, { killed_by: stop.by, forced: stop.forced, reason: stop.reason });
  if (stop.foreign) {
    const owner = recorded.session?.id || recorded.session?.name || recorded.sessionKey;
    if (owner) {
      await d
        .notifyOwner(owner, `worker ${id} (${recorded.label}) stopped by ${stop.by}: ${stop.reason}`)
        .catch(() => undefined);
    }
  }
  // a worker holding the machine-wide build lock frees it and its build tree dies with it
  await releaseBuildsOf(buildsDir(), id).catch(() => []);
  try {
    d.signal(status.pid, "SIGTERM");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH" || String(e).includes("ESRCH")) {
      return `worker ${id}: process ${status.pid} not found (already exited?)`;
    }
    throw e;
  }
  // The run's own SIGTERM handler writes the terminal status; only write ours if it never did.
  const selfReported = await d.waitTerminal(logDir, id);
  let how = "SIGTERM";
  if (!selfReported && d.isAlive(status.pid)) {
    await new Promise((r) => setTimeout(r, d.graceMs));
    if (d.isAlive(status.pid)) {
      try {
        d.signal(status.pid, "SIGKILL");
        how = "SIGKILL";
      } catch {
        /* gone between the probe and the signal */
      }
    }
  }
  if (!selfReported) {
    const latest = loadStatus(logDir, id) ?? recorded;
    if (latest.state === "running" || latest.state === "queued") {
      latest.state = "killed";
      latest.rc = latest.rc ?? (how === "SIGKILL" ? 137 : 143);
      latest.last = latest.last || `killed by signal ${how}`;
      latest.endReason = "pai-worker-kill";
      latest.endBy = stop.by;
      latest.endKillReason = stop.reason;
      if (stop.forced) latest.endForced = true;
      saveStatus(logDir, latest);
    }
  }
  return `sent ${how} to worker ${id} (pid ${status.pid})`;
}

/**
 * Kill `id` and every live descendant, leaves first. `only` keeps the single
 * worker; `skipRoot` ends just the descendants (the deadline path, where the
 * runner stops itself). Returns one line per worker handled, in kill order.
 */
export async function killTree(
  logDir: string,
  id: string,
  opts: {
    only?: boolean;
    skipRoot?: boolean;
    deps?: Partial<KillTreeDeps>;
    /** Set by session-originated kills (the CLI): checks ownership. Internal callers (plans, loop guard, gc, daemon) omit it. */
    caller?: { env: NodeJS.ProcessEnv; force: boolean };
    /** Who is stopping it when not a session (guard, deadline, plan, gc); default: the calling session. */
    by?: string;
    /** Why; required of a forced kill on another session's worker. */
    reason?: string;
    /** Caller process facts for the ownership chain check (tests inject these). */
    proc?: CallerProcessInfo;
  } = {}
): Promise<string[]> {
  const d = { ...defaultDeps(), ...opts.deps };
  const root = loadStatus(logDir, id);
  if (!root) throw new Error(`no worker named "${id}"`);
  const proc = opts.proc ?? {};
  if (opts.caller) {
    const refusal = killRefusal(root, opts.caller.env, opts.caller.force, opts.reason, proc);
    if (refusal) throw new Error(refusal);
  }
  const by = opts.by ?? callerDescription(opts.caller?.env);
  const stop = (s: WorkerStatus): Stop => ({
    by,
    forced: opts.caller?.force === true,
    reason: opts.reason?.trim() || (opts.by ? `stopped by ${opts.by}` : "no reason given"),
    // a session killing someone else's worker, or an internal killer (guard, deadline) stopping a worker its owner did not ask to stop
    foreign: opts.caller ? !isOwner(s, opts.caller.env, proc) : opts.by !== "plan",
  });
  const order = opts.only ? [] : descendantsLeavesFirst(loadStatuses(logDir), id);
  if (!opts.skipRoot) order.push(root);
  const lines: string[] = [];
  for (const s of order) {
    try {
      lines.push(await killOne(logDir, s, d, stop(s)));
    } catch (e) {
      if (s.id === id) throw e;
      lines.push(`worker ${s.id}: kill failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (order.length > 1) appendLedger(ledgerPath(logDir), "WORKER-KILL-TREE", { id, killed: order.map((s) => s.id).join(",") });
  return lines;
}
