/**
 * freeze.ts — `pai freeze` / `pai thaw`: SIGSTOP every running worker's process
 * tree and the local model server(s) to free the machine NOW, SIGCONT them
 * later. Nothing is killed.
 *
 * The marker ~/.pai/state/freeze.json {since, by, until?, pids:[…]} records what
 * was stopped. While a global one exists: the capacity gate admits no new run (freezeHold),
 * the daemon's supervision/reaper/pane sweeps stand down, and the time counts as
 * blocked time for deadlines (frozenMsFor) and for the wait verbs (activeNow).
 * On thaw the per-worker frozen minutes are added to ~/.pai/state/freeze-acct.json
 * and every thawed worker gets an orchestrator note.
 *
 * A partial freeze (--only/--except) records scope "workers": isFrozen()/freezeHold() ignore it, supervision skips just the frozen ids (frozenSince). `--only` ids that are not running write no marker.
 *
 * Order: workers deepest first (an L2 before its L1, so no L1 ever runs next to a
 * frozen child), then the model servers. Thaw: model server, then workers deepest
 * first again (the L1 last). `--only <id>` implies `--workers-only`: freezing one
 * worker must never stall every other worker's shared model server.
 *
 * By default every running model server is stopped EXCEPT a runtime explicitly
 * marked light: `models.runtimes.<name>.freeze: spare`. The shipped apple-fm
 * runtime carries that flag — the Neural Engine bridge costs near nothing idle
 * and SIGSTOPping it hangs every helper call routed to it (2026-11-24: 60 s
 * timeouts). Everything else (GPU servers, ollama, unconfigured runtimes) is
 * stopped, so a freeze really frees the machine. `--all` freezes every running
 * server including the spared ones. Thaw continues exactly what was frozen.
 *
 * Never stopped: this process and its ancestors, the daemon, router, AIBroker,
 * pool hosts, docker. Only worker pids, their descendants and model servers.
 *
 * TEST MODE — `pai freeze` proving itself must never touch the live machine. A
 * marker alone is not isolation: discovery still read the real config, the real
 * log dir and the real process table, and froze a live model server twice. So when
 * PAI_FREEZE_FILE points anywhere but the default location everything else must be
 * named too: PAI_FREEZE_LOGDIR (required — worker discovery reads only that dir)
 * and PAI_FREEZE_SERVERS (`pid[:label]`, comma list — with nothing listed, model
 * discovery returns nothing). No real-config fallback in test mode. The ancestry
 * check applies outside test mode; a PAI_WORKER=1 process is refused in every mode.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
// lazy inside freezeLogDir()/realPpidRows() only: building deps must stay free of config reads and `ps`
import { psTable } from "./ps-table.js";
import { readWorkersSection } from "./config.js";
import { workersLogDir } from "./paths.js";
import { isLive, loadStatuses, ownsPid, type OwnerFields, setWorkerNote, statusPids, type WorkerStatus } from "./status.js";
import { releaseFreezePauses } from "./preempt.js";
import { appendLedger as ledgerLine } from "./ledger.js";
import { ledgerPath } from "./paths.js";

/** The ledger line is a courtesy: a missing log dir never blocks a freeze or a thaw. */
const appendLedger: typeof ledgerLine = (...a) => {
  try {
    ledgerLine(...a);
  } catch {
    /* best effort */
  }
};

export interface FrozenEntry {
  pid: number;
  /** Process start (ps lstart) — a reused pid is never continued. */
  lstart: string;
  kind: "worker" | "model";
  /** Worker id (kind worker) or provider/port label (kind model). */
  id: string;
  /** l1 | l2 | worker | model */
  role: string;
  /** Tree depth, 0 = top level (worker only). */
  depth: number;
}

export interface FreezeMarker {
  since: number;
  by: string;
  until?: number;
  pids: FrozenEntry[];
  /** "workers" = a partial freeze (--only / --except): only the listed workers stand still, everyone else is gated and supervised normally. Absent or "all" = machine-wide. */
  scope?: "all" | "workers";
}

interface Acct {
  totalMs: number;
  workers: Record<string, number>;
}

/** PAI_FREEZE_FILE moves the marker (and its accounts beside it): isolated proofs and tests never touch the real one. */
export const freezePath = (): string => process.env.PAI_FREEZE_FILE ?? paiHomePath("state", "freeze.json");
const acctPath = (): string => (process.env.PAI_FREEZE_FILE ? `${process.env.PAI_FREEZE_FILE}.acct` : paiHomePath("state", "freeze-acct.json"));

/**
 * Test mode: PAI_FREEZE_FILE set to something other than the default marker.
 * Then nothing about the live machine is reachable — worker discovery reads only
 * PAI_FREEZE_LOGDIR (required), model discovery only PAI_FREEZE_SERVERS (an empty
 * list means no servers). Reading is always safe; a freeze in test mode stops at
 * most what these two names point at.
 */
export function freezeTestMode(): boolean {
  const f = process.env.PAI_FREEZE_FILE;
  return !!f && f !== paiHomePath("state", "freeze.json");
}

/** Test mode's log dir (PAI_FREEZE_LOGDIR), or undefined when unset/blank. */
export function freezeTestLogDir(): string | undefined {
  const d = process.env.PAI_FREEZE_LOGDIR?.trim();
  return d ? d : undefined;
}

/** PAI_FREEZE_SERVERS (`pid[:label]`, comma list) parsed; entries without a usable pid are dropped. */
export function parseFreezeServers(v: string | undefined): { pid: number; label: string }[] {
  if (!v?.trim()) return [];
  const out: { pid: number; label: string }[] = [];
  for (const part of v.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const i = t.indexOf(":");
    const head = i < 0 ? t : t.slice(0, i);
    const pid = Number(head);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({ pid, label: (i < 0 ? "" : t.slice(i + 1).trim()) || `test:${pid}` });
  }
  return out;
}

/** The worker log dir `pai freeze`/`pai thaw` operate on: PAI_FREEZE_LOGDIR in test mode (missing = refuse), the real config otherwise. */
export function freezeLogDir(): string {
  if (!freezeTestMode()) return workersLogDir(readWorkersSection().workers);
  const d = freezeTestLogDir();
  if (!d) throw new Error("test mode (PAI_FREEZE_FILE points away from the default marker): set PAI_FREEZE_LOGDIR to an isolated log dir — worker discovery must not read the real one");
  return d;
}

/** The processes whose ppid chain a freeze walks for its ancestry check. */
export interface PpidRow {
  pid: number;
  ppid: number;
}

/** Every live pid and its parent, from `ps`. */
export function realPpidRows(): PpidRow[] {
  const out: PpidRow[] = [];
  for (const line of psTable("pid=,ppid=").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return out;
}

/**
 * Defence in depth: a worker cannot freeze even when PAI_WORKER was stripped from its
 * env (`env -u PAI_WORKER`) — some ancestor is still the running worker process, per
 * the status files' own pids. Test mode is exempt: there nothing real is reachable.
 */
export function workerAncestryBlocked(
  rows: PpidRow[],
  statuses: WorkerStatus[],
  self: number,
  owns: (s: OwnerFields) => boolean = ownsPid
): { id: string; pid: number } | null {
  const by = new Map<number, number>();
  for (const r of rows) if (!by.has(r.pid)) by.set(r.pid, r.ppid);
  const workerPids = new Map<number, string>();
  // Only live workers, and only their own processes: a finished worker's pids are recycled, and parentPid is whatever spawned it (a terminal server).
  for (const s of statuses) {
    if (!isLive(s, owns)) continue;
    for (const p of statusPids({ ...s, parentPid: undefined })) if (!workerPids.has(p)) workerPids.set(p, s.id);
  }
  const seen = new Set<number>();
  for (let p = self; p > 1 && !seen.has(p); p = by.get(p) ?? 0) {
    seen.add(p);
    const id = workerPids.get(p);
    if (id) return { id, pid: p };
  }
  return null;
}

/** Why this process may not freeze, or undefined when it may. Test mode is exempt only for the ancestry (the real status dir and ps are not what isolation is about there); the env guard stands in every mode — a worker could still stop the machine its ancestor worker runs on. */
export function freezeWorkerGuard(statuses: WorkerStatus[], rows: PpidRow[] = realPpidRows(), self: number = process.pid): string | undefined {
  if (process.env.PAI_WORKER === "1") return "a worker cannot freeze its siblings (PAI_WORKER=1)";
  if (freezeTestMode()) return undefined;
  const hit = workerAncestryBlocked(rows, statuses, self);
  return hit ? `a worker cannot freeze its siblings: this process runs inside the running worker ${hit.id} (pid ${hit.pid})` : undefined;
}

function writeJson(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2));
  renameSync(tmp, path);
}

export function readFreeze(): FreezeMarker | null {
  try {
    const m = JSON.parse(readFileSync(freezePath(), "utf8")) as FreezeMarker;
    return m && typeof m.since === "number" && Array.isArray(m.pids) ? m : null;
  } catch {
    return null;
  }
}

/** A machine-wide freeze is in progress. A partial one (scope "workers") is not: the global consumers (gate, supervision sweeps, reaper) carry on and skip the frozen workers per id (frozenSince). */
export const isFrozen = (): boolean => {
  if (!existsSync(freezePath())) return false;
  const m = readFreeze();
  return m !== null && m.scope !== "workers";
};

function readAcct(): Acct {
  try {
    const a = JSON.parse(readFileSync(acctPath(), "utf8")) as Partial<Acct>;
    return { totalMs: Number(a.totalMs) || 0, workers: a.workers ?? {} };
  } catch {
    return { totalMs: 0, workers: {} };
  }
}

/** Machine-wide ms spent frozen, a freeze in progress included. */
export function frozenTotalMs(now: number = Date.now()): number {
  const m = readFreeze();
  return readAcct().totalMs + (m ? Math.max(0, now - m.since) : 0);
}

/** ms this worker spent frozen (closed freezes plus the open one when it is in the marker). */
export function frozenMsFor(id: string, now: number = Date.now()): number {
  const m = readFreeze();
  const open = m && m.pids.some((p) => p.kind === "worker" && p.id === id) ? Math.max(0, now - m.since) : 0;
  return (readAcct().workers[id] ?? 0) + open;
}

/** The freeze spans of this worker, merged and sorted: the closed spell(s) from the accounts plus the open one when the marker names it. `horizon` is `now` for a live tick; detection passes the tick's own time so a back-dated tick never charges future freezes (or pauses). */
function frozenSpans(id: string, horizon: number, openEnd: number = horizon): Array<[number, number]> {
  const m = readFreeze();
  const out: Array<[number, number]> = [];
  if (m && m.pids.some((p) => p.kind === "worker" && p.id === id)) out.push([m.since, Math.max(m.since, openEnd)]);
  // the accounts carry only totals; a single closed spell is the usual shape: [horizon - total, horizon] ending at the thaw
  const closed = readAcct().workers[id] ?? 0;
  if (closed > 0) out.push([horizon - closed, horizon]);
  // merge overlapping spells
  out.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push(s);
  }
  return merged;
}

/** ms of the wall interval [from, to] that ran inside this worker's freeze spans. */
export function frozenMsBetween(id: string, from: number, to: number): number {
  let ms = 0;
  for (const [s, e] of frozenSpans(id, to)) if (from < e) ms += Math.max(0, Math.min(to, e) - Math.max(from, s));
  return ms;
}

/** The moment this worker entered the freeze in progress, or undefined when it is not frozen right now. */
export function frozenSince(id: string): number | undefined {
  const m = readFreeze();
  return m && m.pids.some((p) => p.kind === "worker" && p.id === id) ? m.since : undefined;
}

/** ms of the quiet spell that started at `since` (wall epoch) which ran while this worker was frozen — closed spells included. */
export function frozenMsOf(id: string, since: number, now: number = Date.now()): number {
  return frozenMsBetween(id, since, now);
}

/** The pause spans of this worker from its status fields: the open window [pausedAt, horizon] while paused, plus one closed spell [horizon - pausedMs, horizon]. The horizon is `now` for a live tick; detection passes the tick's own time so a back-dated tick never charges future pauses. */
function pausedSpans(s: { paused?: boolean; pausedAt?: number; pausedMs?: number }, horizon: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (s.paused && typeof s.pausedAt === "number") out.push([s.pausedAt, Math.max(s.pausedAt, horizon)]);
  const closed = Number(s.pausedMs) || 0;
  if (closed > 0) out.push([horizon - closed, horizon]);
  out.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const sp of out) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push(sp);
  }
  return merged;
}

/** ms of the wall interval [from, to] that ran inside this worker's pause spans. */
export function pausedMsBetween(s: { paused?: boolean; pausedAt?: number; pausedMs?: number }, from: number, to: number): number {
  let ms = 0;
  for (const [a, b] of pausedSpans(s, to)) if (from < b) ms += Math.max(0, Math.min(to, b) - Math.max(from, a));
  return ms;
}

/** Wall ms since `since` minus everything this worker spent frozen AND paused — the one clock every quiet/stall/escalation notice runs on. A preemption or `pai worker pause` is not idleness any more than a freeze is; after either ends the spell restarts from its end. */
export function activeMsOf(
  id: string,
  since: number,
  now: number = Date.now(),
  pause: { paused?: boolean; pausedAt?: number; pausedMs?: number } = {}
): number {
  const frozen = frozenSpans(id, now, Math.max(now, Date.now())); // an open freeze never ends before real now: the live marker is current truth even for a back-dated tick
  const spans = [...frozen, ...pausedSpans(pause, now)].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push(sp);
  }
  let ms = 0;
  for (const [a, b] of merged) if (since < b) ms += Math.max(0, Math.min(now, b) - Math.max(since, a));
  return Math.max(0, now - since - ms);
}

/** The ms of the spell [since, now] spent in line at the engine: `lineNow` is the worker's cumulative in-line time (the router's accounting) at `now`, `lineAtSince` its value when the spell began — only waits that began inside the spell count. */
export function inLineMs(lineNow: number, lineAtSince: number): number {
  return Math.max(0, (Number(lineNow) || 0) - (Number(lineAtSince) || 0));
}

/** The worker's own quiet time since `since`: its active ms (freeze and pause never count) minus the ms it spent in line at the engine inside that spell — the ONE own-time clock every stall notice, escalation verdict and time-budget checkpoint runs on. A worker waiting for a model slot is starved, not stuck: in-line minutes are the wait alarm's, never a stall's. */
export function ownMsOf(id: string, since: number, now: number, lineNow = 0, lineAtSince = 0, pause: { paused?: boolean; pausedAt?: number; pausedMs?: number } = {}): number {
  const wall = activeMsOf(id, since, now, pause);
  return Math.max(0, wall - Math.min(wall, inLineMs(lineNow, lineAtSince)));
}

/** A clock that stands still while frozen: the wait verbs' --max budgets run on it. */
export const activeNow = (): number => Date.now() - frozenTotalMs();

/** The reason the capacity gate admits nothing right now, or undefined. */
export function freezeHold(urgent = false): string | undefined {
  // priority (--now, an urgency window) passes the freeze
  return !urgent && isFrozen() ? "frozen by the operator (pai freeze); `pai thaw` releases" : undefined;
}

/** "30m", "2h", "90s", "1h30m"; a bare number is minutes. Returns ms. */
export function parseDuration(s: string): number {
  const t = s.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60_000);
  const re = /(\d+(?:\.\d+)?)\s*([hms])/g;
  let ms = 0;
  let used = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    ms += Number(m[1]) * ({ h: 3_600_000, m: 60_000, s: 1000 }[m[2] as "h" | "m" | "s"]);
    used += m[0].length;
  }
  if (!ms || used !== t.replace(/\s+/g, "").length) throw new Error(`bad duration "${s}" (use 30m, 2h, 90s)`);
  return Math.round(ms);
}

export interface ProcRow {
  pid: number;
  ppid: number;
  lstart: string;
  command: string;
}

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

export function parseProcs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = PS_ROW.exec(line);
    if (m && !m[4].includes("<defunct>")) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), lstart: m[3].replace(/\s+/g, " "), command: m[4] });
  }
  return rows;
}

/** Processes that are never frozen, whoever their parent is. */
const PROTECTED = /(pai-daemon|daemon\/index|aibroker|AIBroker|pool-host|pool_host|dockerd|containerd|com\.docker|Docker\.app|\bdocker\b|launchd|WindowServer)/;

export interface FreezeDeps {
  procs: () => ProcRow[];
  statuses: (logDir: string) => WorkerStatus[];
  /** One entry per RUNNING model server: the listening pid and the name of what it serves (its port's /v1/models id). Async because naming a server is an HTTP probe. */
  servers: () => Promise<{ pid: number; label: string }[]>;
  /** The runtime names whose config declares `freeze: spare` (kept running by a default freeze). Default: read from the main config. */
  spareRuntimes?: () => string[];
  signal: (pid: number, sig: "SIGSTOP" | "SIGCONT") => void;
  owns: (s: WorkerStatus) => boolean;
  self: number;
  now: () => number;
  note: (logDir: string, id: string, text: string) => void;
}

/** The live deps. Nothing is read here: building them must cost nothing, so a caller that may not need them (the daemon tick's auto-thaw check) pays only for what it actually calls. `servers` loads the model-server lookup on first use — it lives in the CLI module. */
export function realFreezeDeps(): FreezeDeps {
  return {
    procs: () => parseProcs(psTable("pid=,ppid=,lstart=,command=")),
    statuses: (d) => loadStatuses(d),
    // one entry per running model server: its listening pid, named by what it serves.
    // Test mode: only PAI_FREEZE_SERVERS — the real config and lsof are never read.
    servers: async () => {
      if (freezeTestMode()) return parseFreezeServers(process.env.PAI_FREEZE_SERVERS);
      try {
        const { runningModelServers } = await import("./model-servers.js");
        return await runningModelServers();
      } catch {
        return [];
      }
    },
    signal: (pid, sig) => process.kill(pid, sig),
    owns: (s) => ownsPid(s),
    self: process.pid,
    now: () => Date.now(),
    note: (d, id, t) => void setWorkerNote(d, id, t),
    // lazy: building deps must stay free of config reads
    spareRuntimes: () => {
      try {
        const { readRuntimeCommands } = require("./model-runtimes.js") as typeof import("./model-runtimes.js");
        const cmds = readRuntimeCommands();
        return Object.keys(cmds).filter((n) => cmds[n]?.freeze === "spare");
      } catch {
        return [];
      }
    },
  };
}

function descendants(rows: ProcRow[], root: number): ProcRow[] {
  const kids = new Map<number, ProcRow[]>();
  for (const r of rows) (kids.get(r.ppid) ?? kids.set(r.ppid, []).get(r.ppid)!).push(r);
  const out: ProcRow[] = [];
  const stack = [root];
  while (stack.length) for (const k of kids.get(stack.pop()!) ?? []) (out.push(k), stack.push(k.pid));
  return out;
}

function ancestors(rows: ProcRow[], pid: number): Set<number> {
  const by = new Map(rows.map((r) => [r.pid, r]));
  const out = new Set<number>();
  for (let p = pid; p > 1 && !out.has(p); p = by.get(p)?.ppid ?? 0) out.add(p);
  return out;
}

export interface FreezeReport {
  lines: string[];
  total: number;
  marker: FreezeMarker | null;
}

/** What to stop: worker trees deepest first, then model servers. Pure given its inputs. */
export function planFreeze(statuses: WorkerStatus[], rows: ProcRow[], servers: { pid: number; label: string }[], self: number): FrozenEntry[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const safe = ancestors(rows, self);
  const protectedPid = (r: ProcRow): boolean => safe.has(r.pid) || PROTECTED.test(r.command);
  const roots = statuses
    .map((s) => ({
      s,
      // the status pid is the runner; the claude itself lives under the follow pane's `pai pane exec <id>`
      pids: [
        ...new Set([
          ...statusPids({ pid: s.pid, runPid: s.runPid, pool: s.pool }),
          ...rows.filter((r) => new RegExp(`\\bpane exec ${s.id}\\b`).test(r.command)).map((r) => r.pid),
        ]),
      ].filter((p) => byPid.has(p) && !protectedPid(byPid.get(p)!)),
    }))
    .filter((w) => w.pids.length > 0);
  const rootPids = new Map<number, string>();
  for (const w of roots) for (const p of w.pids) rootPids.set(p, w.s.id);
  // depth: how many other workers' roots sit above this one in the process tree (or its chain parent)
  const depthOf = (w: (typeof roots)[number]): number => {
    const above = new Set<string>();
    for (const p of w.pids) for (const a of ancestors(rows, byPid.get(p)!.ppid)) { const o = rootPids.get(a); if (o && o !== w.s.id) above.add(o); }
    if (w.s.parent && roots.some((x) => x.s.id === w.s.parent)) above.add(w.s.parent);
    return above.size;
  };
  const ordered = roots.map((w) => ({ w, depth: depthOf(w) })).sort((a, b) => b.depth - a.depth);
  const maxDepth = ordered.length ? ordered[0].depth : 0;
  const claimed = new Set<number>();
  const out: FrozenEntry[] = [];
  for (const { w, depth } of ordered) {
    const role = depth === 0 ? (maxDepth > 0 ? "l1" : "worker") : "l2";
    const members: ProcRow[] = [];
    for (const p of w.pids) members.push(byPid.get(p)!);
    for (const p of w.pids) members.push(...descendants(rows, p));
    for (const r of members) {
      if (claimed.has(r.pid) || protectedPid(r)) continue;
      claimed.add(r.pid);
      out.push({ pid: r.pid, lstart: r.lstart, kind: "worker", id: w.s.id, role, depth });
    }
  }
  // one entry per running model server (its listening pid): the listener's whole tree,
  // children before the listener itself, under the name of what it serves
  for (const m of servers) {
    const r = byPid.get(m.pid);
    if (!r || claimed.has(r.pid) || safe.has(r.pid)) continue;
    const tree = [r, ...descendants(rows, r.pid)].reverse(); // children before the listener
    for (const p of tree) {
      if (claimed.has(p.pid) || protectedPid(p)) continue;
      claimed.add(p.pid);
      out.push({ pid: p.pid, lstart: p.lstart, kind: "model", id: m.label, role: "model", depth: -1 });
    }
  }
  return out;
}

/** The session a worker belongs to: the AIBroker/PAI name recorded at launch. */
const sessionOf = (s: WorkerStatus): string[] => [s.session?.name, s.sessionKey].filter((x): x is string => !!x).map((x) => x.toLowerCase());

/**
 * Ids selected by worker id and/or session name, plus every worker whose chain
 * parent is selected (children follow their L1), transitively.
 */
export function familyIds(all: WorkerStatus[], sel: { ids?: string[]; session?: string }): Set<string> {
  const out = new Set<string>();
  const sess = sel.session?.toLowerCase();
  for (const s of all) if (sel.ids?.includes(s.id) || (sess && sessionOf(s).includes(sess))) out.add(s.id);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of all) if (s.parent && out.has(s.parent) && !out.has(s.id)) (out.add(s.id), (grew = true));
  }
  return out;
}

export interface Except {
  ids?: string[];
  session?: string;
}

/** A model-server label ("provider:port") belongs to a worker when it starts with the worker's provider. */
const serverOf = (label: string, s: WorkerStatus): boolean => !!s.provider && (label === s.provider || label.startsWith(`${s.provider}:`));

/**
 * A model-server label ("provider:port" or "provider:port serving X") names its runtime by the provider part.
 * A server is SPARED only when that runtime (or any provider sharing the port) declares `freeze: spare`;
 * everything else — including an unconfigured runtime — is stopped.
 */
export function sparedServer(label: string, spare: string[]): boolean {
  const port = /:(\d+)/.exec(label)?.[1];
  const providers = label.split(":")[0].split(/\s+/)[0];
  return spare.some((s) => s === providers || (port && `${s}:${port}` === providers));
}

export async function freezeAll(logDir: string, by: string, forMs: number | undefined, d: FreezeDeps, only?: string[], except?: Except, freezeAllServers = false): Promise<FreezeReport> {
  // defence in depth: the env var AND the process ancestry (a worker with PAI_WORKER cleared is still a worker).
  // Both reads are the guard's own, never d.statuses/d.procs — an injected deps must not be what decides.
  // The status read runs first (pure file reads) so the `ps` only happens outside test mode, where the ancestry matters.
  if (process.env.PAI_WORKER === "1") throw new Error("a worker cannot freeze its siblings (PAI_WORKER=1)");
  if (!freezeTestMode()) {
    const hit = workerAncestryBlocked(realPpidRows(), loadStatuses(freezeLogDir()), d.self);
    if (hit) throw new Error(`a worker cannot freeze its siblings: this process runs inside the running worker ${hit.id} (pid ${hit.pid})`);
  }
  const existing = readFreeze();
  if (existing) throw new Error(`already frozen since ${new Date(existing.since).toISOString()} by ${existing.by}; \`pai thaw\` first`);
  const statuses = d.statuses(logDir);
  const spared = except && (except.ids?.length || except.session) ? familyIds(statuses, except) : new Set<string>();
  const live = statuses.filter((s) => s.state === "running" && s.pid > 0 && (!only || only.includes(s.id)) && !spared.has(s.id) && d.owns(s));
  // a model server an excepted worker runs on keeps serving it
  const sparedLive = statuses.filter((s) => spared.has(s.id) && s.state === "running");
  const sigs = (e: FrozenEntry): boolean => {
    try {
      d.signal(e.pid, "SIGSTOP");
      return true;
    } catch {
      return false;
    }
  };
  if (only && live.length === 0) {
    return { lines: [`nothing to freeze: ${only.join(", ")} ${only.length === 1 ? "is" : "are"} not running`], total: 0, marker: null };
  }
  const since = d.now();
  const stopped: FrozenEntry[] = [];
  // the marker exists before the first signal: the gate and the daemon already stand down
  const partial = !!only || !!(except && (except.ids?.length || except.session));
  const marker: FreezeMarker = { since, by, ...(partial ? { scope: "workers" as const } : {}), ...(forMs ? { until: since + forMs } : {}), pids: stopped };
  writeJson(freezePath(), marker);
  const wanted = new Set<number>();
  const spare = freezeAllServers ? null : (d.spareRuntimes?.() ?? []);
  const sparedServers: string[] = [];
  const stopPass = async (): Promise<void> => {
    const rows = d.procs();
    // a model server an excepted worker runs on keeps serving it; a `freeze: spare` runtime keeps serving everyone unless --all
    const servers = (await d.servers()).filter((m) => {
      if (sparedLive.some((s) => serverOf(m.label, s))) return false;
      if (spare && sparedServer(m.label, spare)) {
        if (!sparedServers.includes(m.label)) sparedServers.push(m.label);
        return false;
      }
      return true;
    });
    const plan = planFreeze(live, rows, servers, d.self).filter((e) => !wanted.has(e.pid));
    // a worker's tree root first (no new children), model servers last
    for (const e of plan) {
      wanted.add(e.pid);
      if (sigs(e)) stopped.push(e);
    }
    writeJson(freezePath(), marker);
  };
  await stopPass();
  await stopPass(); // stragglers forked between the scan and the stop
  appendLedger(ledgerPath(logDir), "WORKERS-FREEZE", { by, pids: stopped.length, ...(forMs ? { forMin: Math.round(forMs / 60_000) } : {}) });
  const lines: string[] = [];
  const ids = [...new Set(stopped.filter((e) => e.kind === "worker").map((e) => e.id))];
  for (const id of ids) {
    const mine = stopped.filter((e) => e.id === id && e.kind === "worker");
    lines.push(`frozen ${mine[0].role} ${id}: ${mine.length} processes`);
  }
  // one line per server: the label is shared by its whole tree (the listener's pid leads)
  const modelEntries = new Map<string, FrozenEntry[]>();
  for (const e of stopped.filter((x) => x.kind === "model")) (modelEntries.get(e.id) ?? modelEntries.set(e.id, []).get(e.id)!).push(e);
  for (const [label, mine] of modelEntries) lines.push(`frozen model ${label} (pid ${mine[mine.length - 1].pid}, ${mine.length} processes)`);
  if (spared.size) lines.push(`spared ${[...spared].join(", ")} (and children)`);
  if (sparedServers.length) lines.push(`spared model ${sparedServers.join(", ")} (runtime marked freeze: spare; \`pai freeze --all\` stops it too)`);
  lines.push(`frozen ${ids.length} workers + ${modelEntries.size} model servers, ${stopped.length} processes${forMs ? `, auto-thaw in ${Math.round(forMs / 60_000)} min` : ""}`);
  return { lines, total: stopped.length, marker };
}

export interface ThawReport {
  lines: string[];
  continued: number;
  skipped: number;
  wasFrozen: boolean;
}

/**
 * Continue only the selected workers (by id, or by session with their children),
 * keep the rest frozen and rewrite the marker. A local worker's frozen model
 * server is continued with it. Everything selected-or-nothing-left falls
 * through to the full thaw.
 */
export function thawSome(logDir: string, d: FreezeDeps, sel: { ids?: string[]; session?: string }): ThawReport {
  const m = readFreeze();
  if (!m) return { lines: ["not frozen"], continued: 0, skipped: 0, wasFrozen: false };
  const all = d.statuses(logDir);
  const fam = familyIds(all, sel);
  // an id still frozen but unknown to the status files stays selectable by its exact id
  for (const id of sel.ids ?? []) fam.add(id);
  const frozenIds = new Set(m.pids.filter((e) => e.kind === "worker").map((e) => e.id));
  const pick = [...fam].filter((id) => frozenIds.has(id));
  if (!pick.length) return { lines: [`nothing frozen matches ${sel.session ? `session ${sel.session}` : (sel.ids ?? []).join(",")}`], continued: 0, skipped: 0, wasFrozen: true };
  const lines: string[] = [];
  const models = m.pids.filter((e) => e.kind === "model" && pick.some((id) => { const s = all.find((x) => x.id === id); return !!s && serverOf(e.id, s); }));
  const mine = [...models, ...m.pids.filter((e) => e.kind === "worker" && pick.includes(e.id)).sort((a, b) => b.depth - a.depth)];
  if (mine.length === m.pids.length) return thawAll(logDir, d);
  const now = d.now();
  const rows = new Map(d.procs().map((r) => [r.pid, r]));
  let continued = 0;
  let skipped = 0;
  for (const e of mine) {
    const r = rows.get(e.pid);
    try {
      if (!r || r.lstart !== e.lstart) throw new Error("gone");
      d.signal(e.pid, "SIGCONT");
      continued++;
    } catch {
      skipped++;
      lines.push(`skipped ${e.kind} ${e.id} pid ${e.pid}: gone`);
    }
  }
  if (models.length) lines.push(`model ${models.map((e) => e.id).join(", ")} thawed too: the other frozen workers stay stopped, so it serves only ${pick.join(", ")}`);
  const ms = Math.max(0, now - m.since);
  const acct = readAcct();
  for (const id of pick) acct.workers[id] = (acct.workers[id] ?? 0) + ms;
  writeJson(acctPath(), acct);
  const gone = new Set(mine);
  writeJson(freezePath(), { ...m, pids: m.pids.filter((e) => !gone.has(e)) });
  const mins = Math.max(1, Math.round(ms / 60_000));
  const text = `Paused by the operator for ${mins} min (pai freeze) and released by itself (pai thaw --only/--session) while others stay frozen; nothing failed, continue where you were. A cloud request that was cut by the pause is simply retried.`;
  for (const id of [...pick].sort((a, b) => (mine.find((e) => e.id === b)?.depth ?? 0) - (mine.find((e) => e.id === a)?.depth ?? 0))) {
    try {
      d.note(logDir, id, text);
    } catch {
      /* the worker ended meanwhile */
    }
  }
  // the pauses the freeze itself caused end with it
  try {
    releaseFreezePauses(logDir, now);
  } catch {
    /* best effort */
  }
  appendLedger(ledgerPath(logDir), "WORKERS-THAW", { continued, skipped, partial: pick.join(","), frozenMin: mins });
  const left = new Set(m.pids.filter((e) => !gone.has(e) && e.kind === "worker").map((e) => e.id)).size;
  lines.push(`thawed ${pick.length} workers (${pick.join(", ")}), ${continued} processes continued${skipped ? `, ${skipped} skipped` : ""}; ${left} workers stay frozen`);
  return { lines, continued, skipped, wasFrozen: true };
}

/** Continue only the frozen model server(s) (an urgent --local run needs it); returns the one-line report or null. */
export function thawModelServers(logDir: string, d: FreezeDeps): string | null {
  const m = readFreeze();
  const models = m?.pids.filter((e) => e.kind === "model") ?? [];
  if (!m || !models.length) return null;
  const rows = new Map(d.procs().map((r) => [r.pid, r]));
  for (const e of models) {
    const r = rows.get(e.pid);
    if (r && r.lstart === e.lstart) {
      try {
        d.signal(e.pid, "SIGCONT");
      } catch {
        /* gone */
      }
    }
  }
  writeJson(freezePath(), { ...m, pids: m.pids.filter((e) => e.kind !== "model") });
  appendLedger(ledgerPath(logDir), "WORKERS-THAW", { model: models.map((e) => e.id).join(",") });
  return `model server ${models.map((e) => e.id).join(", ")} thawed for an urgent --local run (the frozen workers stay stopped)`;
}

/** True when the freeze marker holds a stopped model server. */
export const modelFrozen = (): boolean => !!readFreeze()?.pids.some((e) => e.kind === "model");

export function thawAll(logDir: string, d: FreezeDeps): ThawReport {
  const m = readFreeze();
  if (!m) return { lines: ["not frozen"], continued: 0, skipped: 0, wasFrozen: false };
  const now = d.now();
  const rows = new Map(d.procs().map((r) => [r.pid, r]));
  const lines: string[] = [];
  let continued = 0;
  let skipped = 0;
  const cont = (e: FrozenEntry): void => {
    const r = rows.get(e.pid);
    if (!r || r.lstart !== e.lstart) {
      skipped++;
      lines.push(`skipped ${e.kind} ${e.id} pid ${e.pid}: gone`);
      return;
    }
    try {
      d.signal(e.pid, "SIGCONT");
      continued++;
    } catch {
      skipped++;
      lines.push(`skipped ${e.kind} ${e.id} pid ${e.pid}: gone`);
    }
  };
  // the model server first, then workers deepest first (an L1 after its children)
  for (const e of m.pids.filter((x) => x.kind === "model")) cont(e);
  const workers = m.pids.filter((x) => x.kind === "worker").sort((a, b) => b.depth - a.depth);
  for (const e of workers) cont(e);
  // frozen time joins the accounts, the marker goes, the gate opens
  const ms = Math.max(0, now - m.since);
  const acct = readAcct();
  acct.totalMs += ms;
  const ids = [...new Set(workers.map((e) => e.id))];
  for (const id of ids) acct.workers[id] = (acct.workers[id] ?? 0) + ms;
  writeJson(acctPath(), acct);
  rmSync(freezePath(), { force: true });
  const mins = Math.max(1, Math.round(ms / 60_000));
  const text = `Paused by the operator for ${mins} min (pai freeze) to free the machine; nothing failed, continue where you were. A cloud request that was cut by the pause is simply retried.`;
  // L2 before L1
  const roleOf = new Map(workers.map((e) => [e.id, e.depth]));
  for (const id of [...ids].sort((a, b) => (roleOf.get(b) ?? 0) - (roleOf.get(a) ?? 0))) {
    try {
      d.note(logDir, id, text);
    } catch {
      /* the worker ended meanwhile */
    }
  }
  // the pauses the freeze itself caused end with it
  try {
    releaseFreezePauses(logDir, now);
  } catch {
    /* best effort */
  }
  appendLedger(ledgerPath(logDir), "WORKERS-THAW", { continued, skipped, frozenMin: mins });
  lines.push(`thawed ${ids.length} workers, ${continued} processes continued${skipped ? `, ${skipped} skipped` : ""} (frozen ${mins} min)`);
  return { lines, continued, skipped, wasFrozen: true };
}

/** Daemon tick: thaw when the marker's `until` has passed. Returns the report when it thawed. Cheap when nothing is due: one read of the marker, no deps touched — the heavy ones (the process table, the model-server probes) are only called once a thaw actually runs. */
export function autoThawDue(logDir: string, d: FreezeDeps): ThawReport | null {
  const m = readFreeze();
  if (!m || m.until === undefined || d.now() < m.until) return null;
  return thawAll(logDir, d);
}

export function freezeStatusLines(now: number = Date.now()): string[] {
  const m = readFreeze();
  if (!m) return ["not frozen"];
  const min = Math.round((now - m.since) / 60_000);
  const lines = [`frozen since ${new Date(m.since).toISOString()} (${min} min) by ${m.by}${m.until ? `, auto-thaw ${new Date(m.until).toISOString()}` : ""}`];
  const ids = [...new Set(m.pids.filter((e) => e.kind === "worker").map((e) => e.id))];
  for (const id of ids) {
    const mine = m.pids.filter((e) => e.kind === "worker" && e.id === id);
    lines.push(`  ${mine[0].role} ${id}: ${mine.length} processes`);
  }
  const modelEntries = new Map<string, FrozenEntry[]>();
  for (const e of m.pids.filter((x) => x.kind === "model")) (modelEntries.get(e.id) ?? modelEntries.set(e.id, []).get(e.id)!).push(e);
  for (const [label, mine] of modelEntries) lines.push(`  model ${label}: pid ${mine[mine.length - 1].pid}, ${mine.length} processes`);
  return lines;
}
