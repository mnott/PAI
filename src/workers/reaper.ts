/**
 * reaper.ts — kill processes a headless worker left behind.
 *
 * A foreground `npx vitest run` that the Bash tool times out kills the shell
 * but not the forked test worker: it is reparented to launchd (ppid 1) and
 * spins at 100% CPU inside the worker's slot or worktree. The daemon calls
 * reapOrphansOnce every 30 s. A process is reaped when it has ppid 1, is older
 * than 2 minutes, lives under the workers log dir (command line or cwd), is
 * not a pool slot's claude / a pai daemon or pool host, and was over 50% CPU in
 * two samples at least 30 s apart. SIGTERM, SIGKILL after 5 s (killProcessTree).
 * A deliberately detached job (`nohup sh -c 'CMD; echo $? > rc' &`) hangs off
 * a live `sh` until it is done, so it is not a ppid 1 candidate while it runs.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { slotCurrentPath } from "./paths.js";
import { slotsDir } from "./slots.js";
import { loadStatus, saveStatus } from "./status.js";
import { killProcessTree } from "./wait-on.js";
import { worktreesDir } from "./worktree.js";

export const REAP_TICK_MS = 30_000;
export const REAP_MIN_AGE_SECS = 120;
export const REAP_CPU_PCT = 50;

export interface ProcRow {
  pid: number;
  ppid: number;
  /** Percent CPU as `ps` reports it. */
  cpu: number;
  /** Seconds since the process started. */
  ageSecs: number;
  command: string;
  /** Working directory, "" when unknown. */
  cwd: string;
}

export interface ReaperDeps {
  /** Snapshot of ppid-1 processes (cwd filled in for those). */
  snapshot: () => ProcRow[];
  now: () => number;
  kill: (pid: number) => Promise<void>;
  log: (line: string) => void;
  /** Job id a path belongs to (slot current file or worktree name), if any. */
  owner: (logDir: string, path: string) => string | undefined;
  /** Append a line to the owning worker's status note. */
  annotate: (logDir: string, id: string, text: string) => void;
}

/** Candidates seen busy: pid -> start (ms epoch) and first busy sample time. */
export type ReaperState = Map<number, { startMs: number; firstBusy: number }>;

const PROTECTED = /(^|\/)claude(\s|$)|pai-daemon|pai(\s+\S+)*\s+(daemon|pool)\b|pool-host/;
const START_SLACK_MS = 5000;

export function parseEtime(s: string): number {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return 0;
  const [d, h, mi, se] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0));
  return ((d * 24 + h) * 60 + mi) * 60 + se;
}

function under(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Is the row inside the workers log dir (slots/, worktrees/) by cwd or command line? */
export function inWorkerTree(row: ProcRow, logDir: string): boolean {
  const roots = [slotsDir(logDir), worktreesDir(logDir)];
  return roots.some((r) => (row.cwd !== "" && under(row.cwd, r)) || row.command.includes(r + sep));
}

/** Runs a command and returns stdout whatever the exit code (lsof exits 1 when any pid is unreadable). */
export type Runner = (cmd: string, args: string[]) => string;

const spawnRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  return r.stdout ?? "";
};

export function realSnapshot(run: Runner = spawnRunner, uid: number = process.getuid?.() ?? -1): ProcRow[] {
  let out: string;
  try {
    out = run("ps", ["-axo", "pid=,ppid=,uid=,pcpu=,etime=,command="]);
  } catch {
    return [];
  }
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || m[2] !== "1" || Number(m[3]) !== uid) continue;
    rows.push({ pid: Number(m[1]), ppid: 1, cpu: Number(m[4]), ageSecs: parseEtime(m[5]), command: m[6], cwd: "" });
  }
  if (rows.length === 0) return rows;
  try {
    const l = run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", rows.map((r) => r.pid).join(",")]);
    let cur: ProcRow | undefined;
    for (const f of l.split("\n")) {
      if (f.startsWith("p")) cur = rows.find((r) => r.pid === Number(f.slice(1)));
      else if (f.startsWith("n") && cur) cur.cwd = f.slice(1);
    }
  } catch {
    /* lsof absent: fall back to the command line */
  }
  return rows;
}

export function realOwner(logDir: string, path: string): string | undefined {
  const wt = worktreesDir(logDir);
  if (under(path, wt)) return path.slice(wt.length + 1).split(sep)[0] || undefined;
  const sl = slotsDir(logDir);
  if (!under(path, sl)) return undefined;
  const slot = path.slice(sl.length + 1).split(sep)[0];
  const cur = slotCurrentPath(logDir, slot);
  if (!slot || !existsSync(cur)) return undefined;
  return readFileSync(cur, "utf8").trim() || undefined;
}

export function realAnnotate(logDir: string, id: string, text: string): void {
  const st = loadStatus(logDir, id);
  if (!st) return;
  st.note = st.note ? `${st.note} | ${text}` : text;
  saveStatus(logDir, st);
}

export function realReaperDeps(log: (line: string) => void): ReaperDeps {
  return {
    snapshot: realSnapshot,
    now: Date.now,
    kill: (pid) => killProcessTree(pid),
    log,
    owner: realOwner,
    annotate: realAnnotate,
  };
}

/** One reaper pass; returns the pids it killed. `state` carries samples between passes. */
export async function reapOrphansOnce(logDir: string, state: ReaperState, deps: ReaperDeps): Promise<number[]> {
  const now = deps.now();
  const killed: number[] = [];
  const seen = new Set<number>();
  for (const row of deps.snapshot()) {
    if (row.ppid !== 1 || row.ageSecs < REAP_MIN_AGE_SECS || row.cpu <= REAP_CPU_PCT) continue;
    if (PROTECTED.test(row.command) || !inWorkerTree(row, logDir)) continue;
    seen.add(row.pid);
    const startMs = now - row.ageSecs * 1000;
    const prev = state.get(row.pid);
    if (!prev || Math.abs(prev.startMs - startMs) > START_SLACK_MS) {
      state.set(row.pid, { startMs, firstBusy: now });
      continue;
    }
    if (now - prev.firstBusy < REAP_TICK_MS) continue;
    state.delete(row.pid);
    await deps.kill(row.pid);
    killed.push(row.pid);
    const where = row.cwd || row.command;
    const id = deps.owner(logDir, row.cwd) ?? deps.owner(logDir, where);
    const text = `reaped orphan pid ${row.pid} (${Math.round(row.ageSecs / 60)} min old, ${row.cpu}% CPU): ${row.command.slice(0, 120)}`;
    deps.log(`Reaper: ${text}${id ? ` [${id}]` : ""}`);
    if (id) {
      try {
        deps.annotate(logDir, id, text);
      } catch {
        /* the status file is best effort */
      }
    }
  }
  for (const pid of [...state.keys()]) if (!seen.has(pid)) state.delete(pid);
  return killed;
}
