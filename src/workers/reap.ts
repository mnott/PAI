/**
 * reap.ts — no process a worker started outlives it.
 *
 * A worker's leftovers are (a) its live descendants and (b) detached processes
 * (nohup / setsid / disowned) that escaped the tree but keep their cwd inside
 * the worker's worktree. Both sets are ended: SIGTERM, a grace, SIGKILL.
 * Nothing outside that set is touched; the live router is always protected.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isLive, loadStatuses } from "./status.js";
import { scratchDir } from "./scratch.js";
import { ownedTree, worktreesDir } from "./worktree.js";
import { processTree } from "./wait-on.js";

export const REAP_GRACE_MS = 3_000;

export interface OrphanProc {
  pid: number;
  cmd: string;
}

function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** The live router (`router run` without a `--port` scratch flag) is never reaped. */
export function isLiveRouter(cmd: string): boolean {
  return /\brouter run\b/.test(cmd) && !/--port\b/.test(cmd);
}

/** Pids whose cwd is `dir` or below, one `lsof -d cwd` listing (limited to `among` when given: far cheaper); `process.pid` excluded. */
export function pidsWithCwdInside(dir: string, among?: number[]): number[] {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return [];
  }
  if (among && !among.length) return [];
  let raw = "";
  try {
    raw = execFileSync("lsof", among ? ["-a", "-d", "cwd", "-p", among.join(","), "-Fpn"] : ["-d", "cwd", "-Fpn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  } catch (e) {
    raw = String((e as { stdout?: string }).stdout ?? "");
  }
  const out: number[] = [];
  let pid = 0;
  for (const line of raw.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid !== process.pid) {
      const name = line.slice(1);
      if ((name === real || name.startsWith(real + sep)) && !out.includes(pid)) out.push(pid);
    }
  }
  return out;
}

/** Live pids sharing the process GROUP of `pid` (`ps -o pgid=`), `rootPid` itself excluded. A worker's run leads its own group (spawned detached); a backgrounded Bash child shares it, so killing the group ends them too. */
export function pidsInGroupOf(pid: number, rootPid?: number): number[] {
  if (!(pid > 1)) return [];
  try {
    // a group id is the pid of the process that created it: members of group `pid` exist only when `pid` led it
    // (even once the leader is gone), so a run inside its launcher's shared group signals nothing
    const rows = execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 })
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number));
    return rows.filter(([p, g]) => g === pid && p !== pid && p !== rootPid && p !== process.pid).map(([p]) => p);
  } catch {
    return [];
  }
}

/** Live pids whose command line carries PAI_WORKER_ID=<id> (a wrapper env assignment survives exec; `ps eww` shows it when the process keeps its argv). The reliable identity is the scratch dir in cwd or argv — see pidsWithScratchDir. */
export function pidsWithWorkerEnv(id: string): number[] {
  const out: number[] = [];
  try {
    const text = execFileSync("ps", ["eww", "-ax"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20 });
    for (const line of text.split("\n")) {
      if (!line.includes(`PAI_WORKER_ID=${id}`)) continue;
      const m = /^\s*(\d+)\b/.exec(line);
      if (m && Number(m[1]) !== process.pid) out.push(Number(m[1]));
    }
  } catch {
    /* ps failed */
  }
  return out;
}

/** Live pids whose cwd or argv contains `dir`: the escapees that left the tree and the group via setsid/nohup/disown but still carry their worker's scratch dir. */
export function pidsWithScratchDir(dir: string): number[] {
  const out = new Set<number>();
  try {
    for (const p of pidsWithCwdInside(dir)) out.add(p);
  } catch {
    /* lsof failed */
  }
  try {
    // the argv half: `ps eww` lines carry pid + command + environment, so a child that inherited
    // TMPDIR=<dir> is found even when its own argv does not mention it
    const text = execFileSync("ps", ["eww", "-ax"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20 });
    for (const line of text.split("\n")) {
      if (!line.includes(dir)) continue;
      const m = /^\s*(\d+)\b/.exec(line);
      if (m && Number(m[1]) !== process.pid) out.add(Number(m[1]));
    }
  } catch {
    /* ps failed */
  }
  return [...out];
}

/** Processes belonging to a worker: descendants of `rootPid`, its process group (the backgrounded Bash children), anything with cwd inside `dir` or the worker's scratch dir, and anything whose argv names worker `id` — minus protected ones. */
export function findOrphans(opts: { rootPid?: number; dir?: string; id?: string }): OrphanProc[] {
  const pids = new Set<number>();
  if (opts.rootPid) {
    for (const p of processTree(opts.rootPid).slice(1)) pids.add(p);
    // the run leads its own group: a `while :; do :; done &` child shares it even after the runner dies
    for (const p of pidsInGroupOf(opts.rootPid, opts.rootPid)) pids.add(p);
  }
  if (opts.dir) for (const p of pidsWithCwdInside(opts.dir)) pids.add(p);
  // escapees that left the group via setsid/nohup but still carry their identity: the scratch dir in
  // cwd/argv (TMPDIR is under it), or PAI_WORKER_ID visible in `ps eww`
  if (opts.id) {
    for (const p of pidsWithScratchDir(scratchDir(opts.id))) pids.add(p);
    for (const p of pidsWithWorkerEnv(opts.id)) pids.add(p);
  }
  pids.delete(process.pid);
  const out: OrphanProc[] = [];
  for (const pid of pids) {
    const cmd = commandOf(pid);
    if (!cmd || isLiveRouter(cmd)) continue; // gone already, or protected
    out.push({ pid, cmd });
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().startsWith("Z");
  } catch {
    return false;
  }
}

/** SIGTERM, wait `graceMs`, SIGKILL the rest; one log line per ended pid. Returns the pids signalled. */
export async function endProcesses(procs: OrphanProc[], log: (line: string) => void = (l) => process.stderr.write(l + "\n"), graceMs = REAP_GRACE_MS): Promise<number[]> {
  const send = (sig: NodeJS.Signals, pids: number[]) => {
    for (const p of pids) {
      try {
        process.kill(p, sig);
      } catch {
        /* gone between the listing and the signal */
      }
    }
  };
  const pids = procs.map((p) => p.pid);
  send("SIGTERM", pids);
  const until = Date.now() + graceMs;
  while (Date.now() < until && pids.some(alive)) await new Promise((r) => setTimeout(r, 100));
  send("SIGKILL", pids.filter(alive));
  for (const p of procs) log(`pai worker: ended leftover pid ${p.pid}: ${p.cmd.slice(0, 200)}`);
  return pids;
}

/** Teardown of a worker: end everything it left running. Never throws. */
export async function reapWorkerProcesses(opts: { rootPid?: number; dir?: string; id?: string }, log?: (line: string) => void, graceMs?: number): Promise<OrphanProc[]> {
  try {
    const procs = findOrphans(opts);
    if (procs.length) await endProcesses(procs, log, graceMs);
    return procs;
  } catch {
    return [];
  }
}

/** Every live pid right now (one `ps`); the baseline for reapNewSince. */
export function snapshotWorkerPids(_opts?: { rootPid?: number; dir?: string }): Set<number> {
  try {
    const raw = execFileSync("ps", ["-axo", "pid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 });
    return new Set(raw.split("\n").map((l) => Number(l.trim())).filter((n) => n > 0));
  } catch {
    return new Set();
  }
}

/**
 * End what a pooled task left: processes that did not exist at the snapshot and are descendants of `rootPid` or have their cwd in `dir`.
 * The cwd listing only looks at the new pids, so it stays cheap. `rootPid` itself, the live router and anything older are never touched;
 * a spare the host starts meanwhile has its own dir and is no descendant of the slot process, so it is no candidate.
 */
export async function reapNewSince(opts: { rootPid?: number; dir?: string; id?: string }, before: Set<number>, log?: (line: string) => void, graceMs?: number): Promise<OrphanProc[]> {
  try {
    const fresh = [...snapshotWorkerPids()].filter((p) => !before.has(p) && p !== process.pid && p !== opts.rootPid);
    const pids = new Set<number>();
    if (opts.rootPid) {
      for (const p of processTree(opts.rootPid).slice(1)) if (!before.has(p)) pids.add(p);
      for (const p of pidsInGroupOf(opts.rootPid, opts.rootPid)) if (!before.has(p)) pids.add(p);
    }
    if (opts.dir) for (const p of pidsWithCwdInside(opts.dir, fresh)) pids.add(p);
    if (opts.id) {
      for (const p of pidsWithScratchDir(scratchDir(opts.id))) if (!before.has(p)) pids.add(p);
      for (const p of pidsWithWorkerEnv(opts.id)) if (!before.has(p)) pids.add(p);
    }
    pids.delete(process.pid);
    if (opts.rootPid) pids.delete(opts.rootPid);
    const procs: OrphanProc[] = [];
    for (const pid of pids) {
      const cmd = commandOf(pid);
      if (cmd && !isLiveRouter(cmd)) procs.push({ pid, cmd });
    }
    if (procs.length) await endProcesses(procs, log, graceMs);
    return procs;
  } catch {
    return [];
  }
}

/** Processes parked in the worktree of a worker that is no longer live (or has no status), with the worktree they sit in. */
export function findWorktreeOrphans(logDir: string): (OrphanProc & { dir: string })[] {
  const root = worktreesDir(logDir);
  if (!existsSync(root)) return [];
  const liveDirs = new Set(
    loadStatuses(logDir)
      .filter((s) => isLive(s))
      .map((s) => ownedTree(s)?.dir)
      .filter((d): d is string => !!d)
      .map((d) => resolve(d))
  );
  const out: (OrphanProc & { dir: string })[] = [];
  const seen = new Set<number>();
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const dir = join(root, ent.name);
    if (!ent.isDirectory() || liveDirs.has(resolve(dir))) continue;
    for (const o of findOrphans({ dir })) if (!seen.has(o.pid)) (seen.add(o.pid), out.push({ ...o, dir }));
  }
  return out;
}
