/**
 * freeze.ts — `pai freeze` / `pai thaw`: SIGSTOP every running worker's process
 * tree and the local model server(s) to free the machine NOW, SIGCONT them
 * later. Nothing is killed.
 *
 * The marker ~/.pai/state/freeze.json {since, by, until?, pids:[…]} records what
 * was stopped. While it exists: the capacity gate admits no new run (freezeHold),
 * the daemon's supervision/reaper/pane sweeps stand down, and the time counts as
 * blocked time for deadlines (frozenMsFor) and for the wait verbs (activeNow).
 * On thaw the per-worker frozen minutes are added to ~/.pai/state/freeze-acct.json
 * and every thawed worker gets an orchestrator note.
 *
 * Order: workers deepest first (an L2 before its L1, so no L1 ever runs next to a
 * frozen child), then the model server. Thaw: model server, then workers deepest
 * first again (the L1 last).
 *
 * Never stopped: this process and its ancestors, the daemon, router, AIBroker,
 * pool hosts, docker. Only worker pids, their descendants and model servers.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { psTable } from "./ps-table.js";
import { loadStatuses, ownsPid, setWorkerNote, statusPids, type WorkerStatus } from "./status.js";
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
}

interface Acct {
  totalMs: number;
  workers: Record<string, number>;
}

/** PAI_FREEZE_FILE moves the marker (and its accounts beside it): isolated proofs and tests never touch the real one. */
export const freezePath = (): string => process.env.PAI_FREEZE_FILE ?? paiHomePath("state", "freeze.json");
const acctPath = (): string => (process.env.PAI_FREEZE_FILE ? `${process.env.PAI_FREEZE_FILE}.acct` : paiHomePath("state", "freeze-acct.json"));

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

export const isFrozen = (): boolean => existsSync(freezePath()) && readFreeze() !== null;

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

/** A clock that stands still while frozen: the wait verbs' --max budgets run on it. */
export const activeNow = (): number => Date.now() - frozenTotalMs();

/** The reason the capacity gate admits nothing right now, or undefined. */
export function freezeHold(): string | undefined {
  return isFrozen() ? "frozen by the operator (pai freeze); `pai thaw` releases" : undefined;
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
  /** Listening model-server pids, with a label. */
  servers: () => { pid: number; label: string }[];
  signal: (pid: number, sig: "SIGSTOP" | "SIGCONT") => void;
  owns: (s: WorkerStatus) => boolean;
  self: number;
  now: () => number;
  note: (logDir: string, id: string, text: string) => void;
}

/** The live deps; async because the model-server lookup lives in the CLI module (loaded on demand). */
export async function realFreezeDeps(): Promise<FreezeDeps> {
  const { listServers } = await import("../cli/commands/worker-config.js");
  const { readLocalConfig } = await import("./local-tiers.js");
  const { workersYamlPath } = await import("./workers-config.js");
  return {
    procs: () => parseProcs(psTable("pid=,ppid=,lstart=,command=")),
    statuses: (d) => loadStatuses(d),
    // the listening pid of every running local model, found the way `pai models` finds it
    servers: () => {
      try {
        return listServers(readLocalConfig(workersYamlPath())).map((s) => ({ pid: s.pid, label: `${s.provider ?? s.tier ?? "model"}${s.port ? `:${s.port}` : ""}` }));
      } catch {
        return [];
      }
    },
    signal: (pid, sig) => process.kill(pid, sig),
    owns: (s) => ownsPid(s),
    self: process.pid,
    now: () => Date.now(),
    note: (d, id, t) => void setWorkerNote(d, id, t),
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
  marker: FreezeMarker;
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
  for (const m of servers) {
    const r = byPid.get(m.pid);
    if (!r || claimed.has(r.pid) || safe.has(r.pid)) continue;
    claimed.add(r.pid);
    out.push({ pid: r.pid, lstart: r.lstart, kind: "model", id: m.label, role: "model", depth: -1 });
  }
  return out;
}

export function freezeAll(logDir: string, by: string, forMs: number | undefined, d: FreezeDeps, only?: string[]): FreezeReport {
  if (process.env.PAI_WORKER === "1") throw new Error("a worker cannot freeze its siblings (PAI_WORKER=1)");
  const existing = readFreeze();
  if (existing) throw new Error(`already frozen since ${new Date(existing.since).toISOString()} by ${existing.by}; \`pai thaw\` first`);
  const live = d.statuses(logDir).filter((s) => s.state === "running" && s.pid > 0 && (!only || only.includes(s.id)) && d.owns(s));
  const sigs = (e: FrozenEntry): boolean => {
    try {
      d.signal(e.pid, "SIGSTOP");
      return true;
    } catch {
      return false;
    }
  };
  const since = d.now();
  const stopped: FrozenEntry[] = [];
  // the marker exists before the first signal: the gate and the daemon already stand down
  const marker: FreezeMarker = { since, by, ...(forMs ? { until: since + forMs } : {}), pids: stopped };
  writeJson(freezePath(), marker);
  const wanted = new Set<number>();
  const stopPass = (): void => {
    const rows = d.procs();
    const servers = d.servers();
    const plan = planFreeze(live, rows, servers, d.self).filter((e) => !wanted.has(e.pid));
    // a worker's tree root first (no new children), model servers last
    for (const e of plan) {
      wanted.add(e.pid);
      if (sigs(e)) stopped.push(e);
    }
    writeJson(freezePath(), marker);
  };
  stopPass();
  stopPass(); // stragglers forked between the scan and the stop
  appendLedger(ledgerPath(logDir), "WORKERS-FREEZE", { by, pids: stopped.length, ...(forMs ? { forMin: Math.round(forMs / 60_000) } : {}) });
  const lines: string[] = [];
  const ids = [...new Set(stopped.filter((e) => e.kind === "worker").map((e) => e.id))];
  for (const id of ids) {
    const mine = stopped.filter((e) => e.id === id && e.kind === "worker");
    lines.push(`frozen ${mine[0].role} ${id}: ${mine.length} processes`);
  }
  for (const e of stopped.filter((x) => x.kind === "model")) lines.push(`frozen model ${e.id} (pid ${e.pid})`);
  lines.push(`frozen ${ids.length} workers + ${stopped.filter((e) => e.kind === "model").length} model servers, ${stopped.length} processes${forMs ? `, auto-thaw in ${Math.round(forMs / 60_000)} min` : ""}`);
  return { lines, total: stopped.length, marker };
}

export interface ThawReport {
  lines: string[];
  continued: number;
  skipped: number;
  wasFrozen: boolean;
}

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
  appendLedger(ledgerPath(logDir), "WORKERS-THAW", { continued, skipped, frozenMin: mins });
  lines.push(`thawed ${ids.length} workers, ${continued} processes continued${skipped ? `, ${skipped} skipped` : ""} (frozen ${mins} min)`);
  return { lines, continued, skipped, wasFrozen: true };
}

/** Daemon tick: thaw when the marker's `until` has passed. Returns the report when it thawed. */
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
  for (const e of m.pids.filter((x) => x.kind === "model")) lines.push(`  model ${e.id}: pid ${e.pid}`);
  return lines;
}
