/**
 * reap.ts — no process a worker started outlives it.
 *
 * A worker's leftovers are (a) its live descendants and (b) detached processes
 * (nohup / setsid / disowned) that escaped the tree but keep their cwd inside
 * the worker's worktree. Both sets are ended: SIGTERM, a grace, SIGKILL.
 * Only what is provably the worker's is touched (see selectReapable); ancestors, foreign claude sessions and the live router are protected.
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

/** Never reaped, whatever matched: the live router, the PAI daemon, MCP servers, terminals, login shells, tmux. */
export function isProtectedCmd(cmd: string): boolean {
  if (isLiveRouter(cmd)) return true;
  if (/\bpai\b.*\b(daemon|router)\b.*\brun\b|\bpai-daemon\b|\bpai daemon\b/.test(cmd)) return true;
  if (/\bmcp\b|mcp-server|modelcontextprotocol/i.test(cmd)) return true;
  if (/iTerm|\btmux\b/i.test(cmd)) return true;
  if (/^-\w+/.test(cmd.trim()) || /(^|\/)login(\s|$)/.test(cmd.trim())) return true; // login shells: argv0 "-zsh", /usr/bin/login
  return false;
}

/** An interactive Claude Code CLI (not a `pai worker` runner). */
function isClaudeCli(cmd: string): boolean {
  return /(^|[\s/])claude(\s|$)/.test(cmd) && !/\bpai worker\b/.test(cmd);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ProcTable {
  ppid: Map<number, number>;
  pgid: Map<number, number>;
}

function procTable(): ProcTable {
  const t: ProcTable = { ppid: new Map(), pgid: new Map() };
  try {
    const raw = execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 });
    for (const l of raw.split("\n")) {
      const [p, pp, g] = l.trim().split(/\s+/).map(Number);
      if (Number.isInteger(p) && Number.isInteger(pp)) (t.ppid.set(p, pp), t.pgid.set(p, g));
    }
  } catch {
    /* ps failed */
  }
  return t;
}

/** Pids whose `ps eww` line (argv + environment) has `needle` followed by whitespace, "/" (when `slash`) or end. Exact token, no prefix collisions. */
function pidsMentioning(needle: string, slash: boolean): number[] {
  const out: number[] = [];
  const re = new RegExp(escapeRe(needle) + (slash ? "(?:[\\s/]|$)" : "(?:\\s|$)"));
  try {
    const text = execFileSync("ps", ["eww", "-ax"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20 });
    for (const line of text.split("\n")) {
      if (!line.includes(needle) || !re.test(line)) continue;
      const m = /^\s*(\d+)\b/.exec(line);
      if (m && Number(m[1]) !== process.pid) out.push(Number(m[1]));
    }
  } catch {
    /* ps failed */
  }
  return out;
}

export interface PsRow {
  pid: number;
  ppid: number;
  args: string;
}

/** One `ps` listing: pid, ppid and the full command line of every process. */
export function listPsRows(): PsRow[] {
  try {
    const raw = execFileSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20 });
    const rows: PsRow[] = [];
    for (const l of raw.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] });
    }
    return rows;
  } catch {
    return [];
  }
}

/** Orphans (ppid 1) whose command line names `dir` as a whole path token (the `--require <dir>/node_modules/...` of a test-runner fork). Never `self`, never a path that merely shares the prefix. */
export function argvOrphansOf(rows: PsRow[], dir: string, self = process.pid): PsRow[] {
  const d = resolve(dir);
  const re = new RegExp(escapeRe(d) + "(?:[\\s/]|$)");
  return rows.filter((r) => r.pid !== self && r.ppid === 1 && re.test(r.args) && !isProtectedCmd(r.args));
}

type Reason = "descendant" | "group" | "orphan+scratch" | "orphan+worktree" | "orphan+env";
export interface Reaped extends OrphanProc {
  reason: string;
}

/**
 * Decide what of a worker is provably its own. Candidates: (a) descendants of rootPid, (b) members of the group rootPid led,
 * (c) orphans (ppid 1) matching the scratch dir / worktree by cwd or argv/env, or PAI_WORKER_ID=<id> exactly.
 * A look-alike with a live non-init parent is skipped (REAP-SKIP). Ancestors of this process, foreign claude CLIs and the protected set are never candidates.
 */
export function selectReapable(opts: { rootPid?: number; dir?: string; id?: string }, before?: Set<number>, among?: number[], log?: (line: string) => void): Reaped[] {
  const table = procTable();
  const ancestors = new Set<number>();
  for (let p = process.pid; p > 1 && !ancestors.has(p); p = table.ppid.get(p) ?? 0) ancestors.add(p);
  const fresh = (p: number) => !before || !before.has(p);
  const reasons = new Map<number, Reason>();
  const looks = new Map<number, string>();
  const descendants = new Set<number>();
  if (opts.rootPid) {
    for (const p of processTree(opts.rootPid).slice(1)) if (fresh(p)) (reasons.set(p, "descendant"), descendants.add(p));
    for (const p of pidsInGroupOf(opts.rootPid, opts.rootPid)) if (fresh(p) && !reasons.has(p)) reasons.set(p, "group");
  }
  const look = (p: number, why: Reason) => {
    if (!fresh(p) || reasons.has(p) || p === opts.rootPid) return;
    if (table.ppid.get(p) === 1) reasons.set(p, why);
    else if (!looks.has(p)) looks.set(p, `${why.replace("orphan+", "")} match but parent ${table.ppid.get(p) ?? "?"} is live`);
  };
  if (opts.dir) {
    for (const p of pidsWithCwdInside(opts.dir, among)) look(p, "orphan+worktree");
    for (const r of argvOrphansOf(listPsRows(), opts.dir)) if (!among || among.includes(r.pid)) look(r.pid, "orphan+worktree");
  }
  if (opts.id) {
    const sd = scratchDir(opts.id);
    for (const p of pidsWithCwdInside(sd)) look(p, "orphan+scratch");
    for (const p of pidsMentioning(sd, true)) look(p, "orphan+scratch");
    for (const p of pidsMentioning(`PAI_WORKER_ID=${opts.id}`, false)) look(p, "orphan+env");
  }
  const out: Reaped[] = [];
  const skip = (pid: number, cmd: string, why: string) => log?.(`REAP-SKIP pid ${pid}: ${why}: ${cmd.slice(0, 200)}`);
  for (const [pid, why] of looks) if (!reasons.has(pid)) skip(pid, commandOf(pid), why);
  for (const [pid, reason] of reasons) {
    if (pid === process.pid || pid === opts.rootPid) continue;
    const cmd = commandOf(pid);
    if (!cmd) continue; // gone already
    if (ancestors.has(pid)) skip(pid, cmd, "ancestor of the reaper");
    else if (isProtectedCmd(cmd)) skip(pid, cmd, "protected process");
    else if (isClaudeCli(cmd) && !descendants.has(pid)) skip(pid, cmd, "claude CLI not started by this worker");
    else out.push({ pid, cmd, reason });
  }
  return out;
}

/** Processes provably belonging to a worker — see selectReapable. */
export function findOrphans(opts: { rootPid?: number; dir?: string; id?: string }, log?: (line: string) => void): Reaped[] {
  return selectReapable(opts, undefined, undefined, log);
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
export async function endProcesses(procs: (OrphanProc & { reason?: string })[], log: (line: string) => void = (l) => process.stderr.write(l + "\n"), graceMs = REAP_GRACE_MS): Promise<number[]> {
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
  for (const p of procs) log(`pai worker: ended leftover pid ${p.pid} (${p.reason ?? "?"}): ${p.cmd.slice(0, 200)}`);
  return pids;
}

/** Teardown of a worker: end everything it left running. Never throws. */
export async function reapWorkerProcesses(opts: { rootPid?: number; dir?: string; id?: string }, log?: (line: string) => void, graceMs?: number): Promise<OrphanProc[]> {
  try {
    const procs = findOrphans(opts, log ?? ((l) => process.stderr.write(l + "\n")));
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
    const procs = selectReapable(opts, before, fresh, log ?? ((l) => process.stderr.write(l + "\n")));
    if (procs.length) await endProcesses(procs, log, graceMs);
    return procs;
  } catch {
    return [];
  }
}

/** Processes parked in the worktree of a worker that is no longer live (or has no status), with the worktree they sit in. */
export function findWorktreeOrphans(logDir: string): (Reaped & { dir: string })[] {
  const root = worktreesDir(logDir);
  if (!existsSync(root)) return [];
  const liveDirs = new Set(
    loadStatuses(logDir)
      .filter((s) => isLive(s))
      .map((s) => ownedTree(s)?.dir)
      .filter((d): d is string => !!d)
      .map((d) => resolve(d))
  );
  const out: (Reaped & { dir: string })[] = [];
  const seen = new Set<number>();
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const dir = join(root, ent.name);
    if (!ent.isDirectory() || liveDirs.has(resolve(dir))) continue;
    for (const o of findOrphans({ dir })) if (!seen.has(o.pid)) (seen.add(o.pid), out.push({ ...o, dir }));
  }
  return out;
}

/** Orphan processes whose command line names a finished worker's worktree: worktree dir -> count. One ps listing, no lsof. */
export function argvOrphanCounts(logDir: string, rows: PsRow[] = listPsRows()): Map<string, number> {
  const out = new Map<string, number>();
  const root = worktreesDir(logDir);
  if (!existsSync(root) || !rows.length) return out;
  const liveDirs = new Set(
    loadStatuses(logDir)
      .filter((s) => isLive(s))
      .map((s) => ownedTree(s)?.dir)
      .filter((d): d is string => !!d)
      .map((d) => resolve(d))
  );
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const dir = join(root, ent.name);
    if (!ent.isDirectory() || liveDirs.has(resolve(dir))) continue;
    const n = argvOrphansOf(rows, dir).length;
    if (n) out.set(dir, n);
  }
  return out;
}
