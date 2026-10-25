/**
 * leftovers.ts — inventory of processes PAI started and may have left behind (listing only, no
 * killing). 2026-10-25: after iTerm restarts a detached pool host with its spares, timed-out
 * daemon `claude -p` helper calls and a stale tsx from a deleted worktree blocked the daemon
 * restart, and nothing in PAI showed them as a set or said who owned them.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { psTableOrNull } from "../workers/ps-table.js";
import { parseEtime } from "../workers/proc-start.js";
import { alive, isTerminal, loadStatuses, ownsPid, type WorkerStatus } from "../workers/status.js";
import { poolPidPath, readPoolState, type PoolState } from "../workers/pool.js";
import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { readFileSync } from "node:fs";

export type LeftoverKind = "pool-host" | "pool-spare" | "llm-helper" | "finished-worker" | "dead-worktree";

export interface Leftover {
  kind: LeftoverKind;
  pid: number;
  ppid: number;
  ageSecs: number;
  /** who owns it, in words: "host 11274 (alive)", "daemon 812", "worker <id> (done)" ... */
  owner: string;
  detail: string;
}

export interface PsRow {
  pid: number;
  ppid: number;
  ageSecs: number;
  command: string;
}

/** `ps -axww -o pid=,ppid=,etime=,command=` output to rows; the etime goes through the shared parseEtime. */
export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const ageSecs = parseEtime(m[3]!);
    if (Number.isNaN(ageSecs)) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), ageSecs, command: m[4]! });
  }
  return rows;
}

export interface LeftoverInput {
  ps: string;
  poolState: PoolState | null;
  /** pid recorded in the pool host pid file, when there is one */
  poolPidFile?: number | null;
  statuses: WorkerStatus[];
  daemonPid: number | null;
  /** cwd of a process, "" when unknown */
  cwdOf: (pid: number) => string;
  dirExists: (path: string) => boolean;
  pidAlive: (pid: number) => boolean;
  /** the process still is the one the worker record started (not a reused pid) */
  owns: (s: WorkerStatus) => boolean;
}

const HELPER_RE = /\bclaude\b.*\s-p(\s|$).*--no-session-persistence|\bclaude\b.*--no-session-persistence.*\s-p(\s|$)/;
const NODE_RE = /(^|[\s/])(node|tsx)(\s|$)|\/\.bin\/tsx|\/tsx\//;

export function collectLeftovers(i: LeftoverInput): Leftover[] {
  const rows = parsePs(i.ps);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const out: Leftover[] = [];
  const seen = new Set<number>();
  const add = (r: PsRow, kind: LeftoverKind, owner: string, detail: string): void => {
    if (seen.has(r.pid)) return;
    seen.add(r.pid);
    out.push({ kind, pid: r.pid, ppid: r.ppid, ageSecs: r.ageSecs, owner, detail });
  };

  // pool host and its spares
  const hostPid = i.poolState?.hostPid ?? i.poolPidFile ?? null;
  const hostAlive = hostPid ? i.pidAlive(hostPid) && byPid.has(hostPid) : false;
  const hostRow = hostPid ? byPid.get(hostPid) : undefined;
  if (hostRow && i.poolState) add(hostRow, "pool-host", `ppid ${hostRow.ppid}`, `port ${i.poolState.port}`);
  for (const sp of i.poolState?.spares ?? []) {
    const r = byPid.get(sp.pid);
    if (r) add(r, "pool-spare", `host ${hostPid ?? "?"} (${hostAlive ? "alive" : "dead"})`, `${sp.state} ${sp.provider}/${sp.model} ${sp.dir}`);
  }

  // daemon-spawned `claude -p` helper calls
  for (const r of rows) {
    if (!HELPER_RE.test(r.command)) continue;
    if (i.daemonPid !== null && r.ppid === i.daemonPid) add(r, "llm-helper", `daemon ${i.daemonPid}`, r.command.slice(0, 120));
    else if (r.ppid === 1) add(r, "llm-helper", "orphan (ppid 1)", r.command.slice(0, 120));
  }

  // processes of workers whose record is finished
  for (const s of i.statuses) {
    if (!isTerminal(s.state)) continue;
    if (!i.owns(s)) continue;
    for (const pid of [s.pid, s.runPid]) {
      const r = pid ? byPid.get(pid) : undefined;
      if (r && pid && i.pidAlive(pid)) add(r, "finished-worker", `worker ${s.id} (${s.state})`, s.label);
    }
  }

  // node/tsx processes whose cwd is a deleted worktree
  for (const r of rows) {
    if (seen.has(r.pid) || !NODE_RE.test(r.command)) continue;
    const cwd = i.cwdOf(r.pid);
    if (cwd && /[\\/]worktrees[\\/]/.test(cwd) && !i.dirExists(cwd)) add(r, "dead-worktree", `cwd ${cwd}`, r.command.slice(0, 120));
  }

  return out;
}

function cwdViaLsof(pid: number): string {
  try {
    const o = execFileSync("lsof", ["-a", "-d", "cwd", "-Fn", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /^n(.*)$/m.exec(o)?.[1] ?? "";
  } catch {
    return "";
  }
}

/** The live inventory: real ps, real pool state and worker records. */
export function listLeftovers(daemonPid: number | null): Leftover[] {
  try {
    const logDir = workersLogDir(readWorkersSection().workers);
    let poolPidFile: number | null = null;
    try {
      poolPidFile = Number(readFileSync(poolPidPath(logDir), "utf8").trim()) || null;
    } catch {
      /* no pid file */
    }
    const ps = psTableOrNull("pid=,ppid=,etime=,command=") ?? "";
    return collectLeftovers({
      ps,
      poolState: readPoolState(logDir),
      poolPidFile,
      statuses: loadStatuses(logDir),
      daemonPid,
      cwdOf: cwdViaLsof,
      dirExists: existsSync,
      pidAlive: alive,
      owns: ownsPid,
    });
  } catch {
    return [];
  }
}

function fmtAge(s: number): string {
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

/** One line per leftover; empty list gives no lines. */
export function formatLeftovers(l: Leftover[]): string[] {
  return l.map((x) => `${x.kind.padEnd(15)} pid ${x.pid} ppid ${x.ppid} age ${fmtAge(x.ageSecs)} owner ${x.owner} ${x.detail}`.trimEnd());
}
