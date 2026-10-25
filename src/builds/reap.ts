/**
 * reap.ts — kill the Xcode compilers a build left behind.
 *
 * xcodebuild hands the compiling to Xcode's build service (a long-lived XPC service),
 * so swift-frontend / clang / ld processes are not in the gate's process group and
 * survive a killed gate, reparented to launchd (ppid 1). They are found by their
 * command line: it names the job's derived data path or worktree. `reapJob` runs when
 * a job ends; `sweepOrphans` (daemon, every 60 s) catches the ones nothing owns.
 * The table comes from the shared reader (the command lines are huge).
 */

import { psTableOrNull } from "../workers/ps-table.js";
import { parseEtime } from "../workers/proc-start.js";

export interface ProcRow {
  pid: number;
  ppid: number;
  /** Seconds since the process started. */
  age: number;
  command: string;
}

export const REAP_FORMAT = "pid=,ppid=,etime=,command=";
/** Compiler lines are cut here; the derived data path is among the first arguments. */
export const REAP_MAX_LINE = 32 * 1024;
export const REAP_GRACE_MS = 5000;
export const ORPHAN_MIN_AGE_S = 120;

const COMPILERS = new Set(["swift-frontend", "swift-driver", "swiftc", "clang", "clang++", "ld", "ld64", "XCBBuildService"]);
const SERVICES = new Set(["SWBBuildService", "XCBBuildService"]);

const procName = (command: string): string => {
  const first = command.trimStart().split(/\s/, 1)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
};

export function parseTable(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), age: parseEtime(m[3]), command: m[4] });
  }
  return rows;
}

export const readTable = (run?: Parameters<typeof psTableOrNull>[1]): ProcRow[] => {
  const t = psTableOrNull(REAP_FORMAT, run, 3, REAP_MAX_LINE);
  return t ? parseTable(t) : [];
};

/** Paths that identify a job: its cwd, -derivedDataPath, absolute arguments and build-dir env values. */
export function jobPaths(command: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string[] {
  const out = new Set<string>();
  const add = (p: string | undefined): void => {
    if (p && p.startsWith("/") && p.split("/").filter(Boolean).length >= 3) out.add(p.replace(/\/+$/, ""));
  };
  add(cwd);
  command.forEach((a, i) => {
    if (a === "-derivedDataPath") add(command[i + 1]);
    else add(a.replace(/^-[A-Za-z]+=/, ""));
  });
  for (const k of ["DERIVED_DATA_PATH", "PAI_DERIVED_DATA_PATH", "BUILD_DIR", "SYMROOT"]) add(env[k]);
  return [...out];
}

const refs = (command: string, paths: string[]): boolean => paths.some((p) => command.includes(p));

export interface ReapOptions {
  table?: ProcRow[];
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const defKill = (pid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(pid, sig);
  } catch {
    /* gone */
  }
};
const defAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const defWait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SIGTERM the pids, SIGKILL the survivors after the grace period. Returns [termed, killed]. */
async function terminate(pids: number[], o: ReapOptions): Promise<[number, number]> {
  if (!pids.length) return [0, 0];
  const kill = o.kill ?? defKill;
  const alive = o.isAlive ?? defAlive;
  for (const p of pids) kill(p, "SIGTERM");
  await (o.wait ?? defWait)(REAP_GRACE_MS);
  const left = pids.filter((p) => alive(p));
  for (const p of left) kill(p, "SIGKILL");
  return [pids.length, left.length];
}

/**
 * Reap the compilers a finished job caused: processes whose command line names one of the
 * job's paths and none of another running job's paths. Orphans (ppid 1) must also have started
 * inside the job's window (`jobAgeS` seconds, plus slack). Returns the pids found.
 */
export async function reapJob(paths: string[], otherPaths: string[], jobAgeS: number, o: ReapOptions = {}): Promise<number[]> {
  if (!paths.length) return [];
  const table = o.table ?? readTable();
  const pids = table
    .filter((r) => r.pid !== process.pid && (COMPILERS.has(procName(r.command)) || SERVICES.has(procName(r.command))))
    .filter((r) => refs(r.command, paths) && !refs(r.command, otherPaths))
    .filter((r) => r.ppid !== 1 || r.age <= jobAgeS + 10)
    .map((r) => r.pid);
  if (!pids.length) return [];
  const [termed, killed] = await terminate(pids, o);
  (o.log ?? ((l) => process.stderr.write(l + "\n")))(`BUILD-REAP job: ${termed} compiler process(es) terminated, ${killed} needed SIGKILL`);
  return pids;
}

/** Daemon sweep: ppid-1 compilers older than 2 min that match no running job's paths. */
export async function sweepOrphans(runningPaths: string[], o: ReapOptions & { minAgeS?: number } = {}): Promise<number[]> {
  const table = o.table ?? readTable();
  const pids = table
    .filter((r) => r.ppid === 1 && r.age > (o.minAgeS ?? ORPHAN_MIN_AGE_S) && COMPILERS.has(procName(r.command)) && procName(r.command) !== "XCBBuildService")
    .filter((r) => !refs(r.command, runningPaths))
    .map((r) => r.pid);
  if (!pids.length) return [];
  const [termed, killed] = await terminate(pids, o);
  (o.log ?? ((l) => process.stderr.write(l + "\n")))(`BUILD-REAP sweep: ${termed} orphaned compiler process(es) terminated, ${killed} needed SIGKILL`);
  return pids;
}
