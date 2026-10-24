/**
 * pane-audit.ts — the pane auditor, a BUG DETECTOR now that the pane owns the process (pane-exec.ts: every
 * process PAI starts in a session runs as the child of the wrapper in its pane, so a process without a pane
 * or a pane without a process cannot arise by construction).
 *
 * Two checks, both recorded in the ledger only (never a session notice, never PAILot): the launcher audit
 * (auditLaunches: a pane-exec whose child is gone while the pane lives, or the reverse, has its orphan side
 * killed / closed; a running worker that bypassed the launcher is noted) and the pane marks (judged from the
 * pane registry and the iTerm listing: ok, NO PANE, WRONG TAB, HOST UNKNOWN, STILL OPEN, plus the shown-only
 * NOT SELECTED / MINIMISED). The daemon runs it every 30 s and writes <logDir>/pane-audit.json for
 * `ps` and the cockpit.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closePaneForWorker, dropPaneEntry, loadRegistry, openPaneForWorker, osascriptJxa, saveEntry, type PaneEntry } from "./pane.js";
import { readWorkersSection } from "./config.js";
import { exitFilePath, listRecords, pidAlive, readExit, readRecord, recordPath, type ExitRecord, type LaunchRecord } from "./pane-exec.js";
import { itermUuid, scopeKey } from "./scope.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { killTree } from "./kill-tree.js";
import { appendStopEvent, requestKill } from "./endreason.js";
import { loadStatusesCached, loadStatus, isLive, isChatPane, ownsPid, ownsPidCached, spawnTimeOf } from "./status.js";
import { loadPlanStatuses } from "./plan-status.js";
import { isPaneRunId, loadPaneRunStatuses } from "./pane-run.js";
import type { Messenger } from "./run-events.js";
import { panePolicy } from "./pane-policy.js";
import { readPaneClosedBy } from "./pane-bar.js";

export type PaneMark = "ok" | "NO PANE" | "WRONG TAB" | "HOST UNKNOWN" | "STILL OPEN" | "NOT SELECTED" | "MINIMISED";
/** Marks that are shown, never alarmed: the pane runs, only its visibility falls short. */
export const SHOWN_ONLY: readonly PaneMark[] = ["NOT SELECTED", "MINIMISED"];

export interface AuditProc {
  id: string;
  kind: "worker" | "plan" | "pane";
  /** The starting session's iTerm id (status.term), when known. */
  host?: string;
  /** When the process started (ms); a young process gets the start grace. */
  startedMs?: number;
  /** Why the start could not open a pane (status.pane.reason), shown with NO PANE. */
  noPaneReason?: string;
  /** The run already ended (a pane-run run): its pane must have closed itself. */
  ended?: boolean;
  /** False when the process has ended: an ended worker is never reopened. */
  live?: boolean;
  /** When the process ended (ms), for an ended worker: it gets the end grace. */
  endedMs?: number;
}

/** A worker that ended, or whose pane closed, within this window is not judged: the pane closes itself before the final status lands. */

/** A process younger than this (since start or pane registration) is not judged: its pane is still being opened. */

export interface PaneVerdict {
  id: string;
  kind: AuditProc["kind"];
  mark: PaneMark;
  session?: string;
  host?: string;
  tab?: string;
  hostTab?: string;
  why?: string;
}

/** iTerm session id -> "window:tab" key. */
export type TabMap = Map<string, string>;
/** iTerm session id -> its size in cells. */
export type SizeMap = Map<string, { cols: number; rows: number; mark?: "NOT SELECTED" | "MINIMISED" }>;

const norm = (id: string): string => itermUuid(id) || id;

const stampMs = (t: string | undefined, utc: boolean): number => (t ? Date.parse(t.replace(" ", "T") + (utc ? "Z" : "")) : NaN);

export function auditPanes(procs: AuditProc[], registry: PaneEntry[], tabs: TabMap, nowMs?: number, sizes?: SizeMap): PaneVerdict[] {
  const tabOf = (id: string | undefined): string | undefined => (id ? tabs.get(norm(id)) : undefined);
  return procs.map((p) => {
    const e = registry.find((x) => x.worker === p.id);
    const host = e?.host ?? p.host;
    const v: PaneVerdict = { id: p.id, kind: p.kind, mark: "ok", session: e?.session, host };
    // an ended worker runs nothing: it owns no pane, whatever the registry says
    if (p.kind === "worker" && p.live === false) return { ...v, why: "ended" };
    if (nowMs !== undefined) {
      // registry stamps are UTC (toISOString); a recent start or a recent registration opens the grace
      const young = [p.startedMs, stampMs(e?.opened, true)].some((t) => t !== undefined && Math.abs(nowMs - t) < panePolicy().startGraceMs);
      if (young) return { ...v, why: "within the start grace" };
    }
    // an ended pane-run closed its pane itself: no registry entry is the expected end state, never NO PANE
    if (!e && p.ended && isPaneRunId(p.id)) return { ...v, why: "ended, pane closed" };
    if (!e) return { ...v, mark: "NO PANE", why: p.noPaneReason ? `started without a pane: ${p.noPaneReason}` : "no pane recorded for a running process" };
    const tab = tabOf(e.session);
    if (!tab && p.ended && isPaneRunId(p.id)) return { ...v, why: "ended, pane closed" };
    if (!tab) return { ...v, mark: "NO PANE", why: `pane ${e.session} is gone while the process runs` };
    // a pane-run pane closes itself when its command ends: one still open past the linger is a fault
    if (p.ended && isPaneRunId(p.id) && nowMs !== undefined && nowMs - (p.startedMs ?? 0) > panePolicy().startGraceMs) {
      return { ...v, mark: "STILL OPEN", tab, why: `pane ${e.session} of the ended run ${p.id} is still open` };
    }
    const hostTab = tabOf(host);
    if (!hostTab) return { ...v, mark: "HOST UNKNOWN", tab, why: host ? `starting session ${host} is not in the iTerm listing` : `pane ${e.session} has no recorded starting session` };
    if (hostTab !== tab) return { ...v, mark: "WRONG TAB", tab, hostTab, why: `pane ${e.session} sits in ${tab}, the starting session in ${hostTab}` };
    // pane size is never a violation: only the visibility mark of the listing counts
    const size = sizes?.get(norm(e.session));
    if (size?.mark) return { ...v, mark: size.mark, tab, hostTab, why: `pane ${e.session} runs, but ${size.mark === "MINIMISED" ? "its window is minimised" : "its tab is not the selected one"}` };
    return { ...v, tab, hostTab };
  });
}

/** Everything running now that must own a pane. A run that was refused/allowed hidden (pane.opened false) is exempt. */
export function runningProcs(logDir: string): AuditProc[] {
  const procs: AuditProc[] = [];
  for (const s of loadStatusesCached(logDir)) {
    if (isChatPane(s) || s.state === "queued" || (s.pane?.opened === false && !s.pane.failed)) continue;
    procs.push({ id: s.id, kind: "worker", host: s.term || undefined, startedMs: spawnTimeOf(s) ?? stampMs(s.started, false), live: isLive(s, ownsPidCached), ...(s.state !== "running" ? { endedMs: stampMs(s.updated, false) } : {}), ...(s.pane?.failed && s.pane.reason ? { noPaneReason: s.pane.reason } : {}) });
  }
  for (const p of loadPlanStatuses(logDir)) if (p.state === "running" && p.hasPane) procs.push({ id: p.id, kind: "plan", startedMs: stampMs(p.started, false) });
  // ended pane runs too: their pane must have closed itself, and one still open is a fault
  for (const p of loadPaneRunStatuses(logDir)) procs.push({ id: p.id, kind: "pane", startedMs: p.startedMs, ended: p.state !== "running" });
  return procs;
}

const TABS_SCRIPT = `function run(argv) {
    var app = Application("iTerm2");
    if (!app.running()) return "";
    function arr(f) { try { return f() || []; } catch (e) { return []; } }
    var out = "";
    arr(function () { return app.windows(); }).forEach(function (w) {
        if (!w) return;
        var wid = ""; try { wid = String(w.id()); } catch (e) {}
        arr(function () { return w.tabs(); }).forEach(function (t, ti) {
            if (!t) return;
            var tid = ""; try { tid = String(t.id()); } catch (e) { tid = "i" + ti; }
            var sel = ""; try { sel = String(w.currentTab().id()) === tid ? "1" : "0"; } catch (e) {}
            var mini = ""; try { mini = w.miniaturized() ? "1" : "0"; } catch (e) {}
            arr(function () { return t.sessions(); }).forEach(function (s) {
                try { out += s.id() + "\\t" + wid + ":" + tid + "\\t" + s.columns() + "\\t" + s.rows() + "\\t" + sel + "\\t" + mini + "\\n"; } catch (e) {}
            });
        });
    });
    return out;
}`;

/** Every iTerm session with its window:tab. Rejects when iTerm cannot be listed (no verdict is then given). */
export async function listItermTabs(run: (script: string, args: string[]) => Promise<{ stdout: string }> = osascriptJxa, sizes?: SizeMap): Promise<TabMap> {
  const p = await run(TABS_SCRIPT, []);
  const m: TabMap = new Map();
  for (const l of p.stdout.split("\n")) {
    const [id, tab, cols, rows, sel, mini] = l.split("\t");
    if (id && tab) m.set(norm(id), tab);
    if (id && cols && rows) sizes?.set(norm(id), { cols: Number(cols), rows: Number(rows), ...(mini === "1" ? { mark: "MINIMISED" as const } : sel === "0" ? { mark: "NOT SELECTED" as const } : {}) });
  }
  return m;
}

export interface AuditFile {
  at: string;
  verdicts: PaneVerdict[];
}

const auditFile = (logDir: string): string => join(logDir, "pane-audit.json");
const pendingFile = (logDir: string): string => join(logDir, "pane-audit-pending.json");
const toldFile = (logDir: string): string => join(logDir, "pane-audit-told.json");

export function readAudit(logDir: string): PaneVerdict[] {
  try {
    return (JSON.parse(readFileSync(auditFile(logDir), "utf8")) as AuditFile).verdicts;
  } catch {
    return [];
  }
}

/** The mark of one process from the last daemon audit, "" when ok or unaudited. */
export function markOf(verdicts: PaneVerdict[], id: string): string {
  const v = verdicts.find((x) => x.id === id);
  return v && v.mark !== "ok" ? v.mark : "";
}

function readJson(file: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

const readTold = (logDir: string): Record<string, string> => readJson(toldFile(logDir));
/**
 * One audit round: judge, persist, and record each new violation once, in the ledger only (PANE-VIOLATION).
 * Since the pane owns the process (pane-exec.ts) a missing pane cannot happen by construction; what is left
 * is a bug detector: the launcher audit (auditLaunches) and the visibility marks. A small pane is never a
 * violation: the operator does not care about pane size. Nothing is sent to a session
 * or to PAILot, nothing is reopened.
 */
export async function auditTick(
  logDir: string,
  _msg: Messenger,
  deps: {
    tabs?: (sizes: SizeMap) => Promise<TabMap>;
    procs?: () => AuditProc[];
    registry?: () => PaneEntry[];
    now?: () => Date;
    /** Fresh liveness at the moment of the check: false when the worker's status is terminal or its process is gone. */
    running?: (wid: string) => boolean;
    /** Launcher audit seam (default: the real pane-exec records and processes). */
    launches?: () => Promise<unknown>;
    /** The pane session a worker itself recorded (status.pane.session, else its pane-exec launch record), "" when none. */
    ownSession?: (wid: string) => string;
    /** Stops a worker through the normal end path (kill-tree: SIGTERM, the runner salvages and ends). */
    stop?: (wid: string, why: string) => Promise<unknown>;
    /** Opens a new follow pane for a running worker whose pane vanished; rejects when it cannot (default: split in a live host tab). */
    reopen?: (wid: string, v: PaneVerdict, tabs: TabMap) => Promise<unknown>;
  } = {}
): Promise<PaneVerdict[]> {
  const now = deps.now?.() ?? new Date();
  const nowMs = now.getTime();
  await (deps.launches ?? (() => auditLaunches(logDir, undefined, now)))().catch(() => undefined);
  let tabs: TabMap;
  const sizes: SizeMap = new Map();
  try {
    tabs = await (deps.tabs ?? ((z) => listItermTabs(undefined, z)))(sizes);
  } catch {
    return []; // iTerm unreadable: no verdict, no false alarm
  }
  if (tabs.size === 0) return []; // no iTerm (tmux, other platform): nothing to compare against
  const procs = (deps.procs ?? (() => runningProcs(logDir)))();
  const verdicts = auditPanes(procs, (deps.registry ?? (() => loadRegistry(logDir)))(), tabs, nowMs, sizes);
  // a pane the operator closed itself (pane-bar's /quit, the same way a worker's own end closes its pane):
  // the deliberate close is the expected end state — the audit leaves it closed, never reopens or kills
  const closedBy = readPaneClosedBy(logDir);
  for (const v of verdicts) if (v.kind === "worker" && closedBy[v.id]) Object.assign(v, { mark: "ok", tab: undefined, hostTab: undefined, why: "pane closed by the operator" });
  // re-read the status right before judging: a worker that ended since the listing was taken (its pane closes first) is no violation
  const running =
    deps.running ??
    ((wid: string) => {
      const s = loadStatus(logDir, wid);
      return !s || isLive(s, ownsPid);
    });
  // NO PANE for want of a registry entry, yet the worker's own recorded pane is in the listing: the entry was lost, the pane is not. Re-register, never kill.
  for (const v of verdicts) {
    if (v.kind !== "worker" || v.mark !== "NO PANE" || v.session) continue;
    const own = (deps.ownSession ?? ((wid) => ownPaneSession(logDir, wid)))(v.id);
    if (!own || !tabs.has(norm(own))) continue;
    const host = v.host ?? own;
    saveEntry(logDir, { session: norm(own), worker: v.id, opened: now.toISOString().replace("T", " ").slice(0, 19), scope: scopeKey(host), host: v.host });
    appendLedger(ledgerPath(logDir), "PANE-REREGISTERED", { id: v.id, session: norm(own) }, now);
    Object.assign(v, { mark: "ok", session: norm(own), tab: tabs.get(norm(own)), why: "entry lost, pane alive: re-registered" });
  }
  for (const v of verdicts) {
    if (v.kind !== "worker" || v.mark === "ok" || SHOWN_ONLY.includes(v.mark)) continue;
    const proc = procs.find((p) => p.id === v.id);
    const recent = proc?.endedMs !== undefined && nowMs - proc.endedMs < panePolicy().endGraceMs;
    if (recent || !running(v.id)) Object.assign(v, { mark: "ok", tab: undefined, hostTab: undefined, why: "ended, pane closed" });
  }
  // a violation counts only when the previous check failed the same way: one bad listing is not a verdict
  const seen = readJson(pendingFile(logDir));
  const failing: Record<string, string> = {};
  for (const v of verdicts) {
    if (v.mark === "ok" || SHOWN_ONLY.includes(v.mark)) continue;
    failing[v.id] = v.mark;
    if (seen[v.id] !== v.mark) Object.assign(v, { mark: "ok", tab: undefined, hostTab: undefined, why: "first failed check, confirming" });
  }
  writeFileSync(pendingFile(logDir), JSON.stringify(failing), "utf8");
  writeFileSync(auditFile(logDir), JSON.stringify({ at: now.toISOString(), verdicts } satisfies AuditFile), "utf8");
  const told = readTold(logDir);
  const next: Record<string, string> = {};
  for (const v of verdicts) {
    if (v.mark === "ok" || SHOWN_ONLY.includes(v.mark)) continue; // shown, never alarmed
    next[v.id] = v.mark;
    // a running worker whose registered pane vanished (a terminal crash) is not lost work: reopen its pane
    if (v.kind === "worker" && v.mark === "NO PANE" && v.session) {
      if (await reopenOrFall(logDir, v, tabs, deps.reopen, deps.stop, now)) {
        delete next[v.id];
        continue;
      }
    }
    if (told[v.id] === v.mark) continue;
    appendLedger(ledgerPath(logDir), "PANE-VIOLATION", { id: v.id, kind: v.kind, mark: v.mark, why: v.why }, now);
    // a worker without its pane does not run on: it ends through the normal path, which salvages its work
    if (v.kind === "worker" && v.mark === "NO PANE" && !v.session) await stopUnpaned(logDir, v.id, v.why ?? "no pane", deps.stop, now);
  }
  writeFileSync(toldFile(logDir), JSON.stringify(next), "utf8");
  return verdicts;
}

/** The pane session the worker recorded itself: status.pane.session, else its pane-exec launch record. */
function ownPaneSession(logDir: string, wid: string): string {
  return loadStatus(logDir, wid)?.pane?.session || readRecord(wid)?.session || "";
}

const reopenFile = (logDir: string): string => join(logDir, "pane-audit-reopen.json");

interface ReopenState {
  firstMs: number;
  tries: number;
  nextMs: number;
}

/** The host a new pane splits: the registered host while it lives, else any live iTerm session. */
function liveHost(v: PaneVerdict, tabs: TabMap): string | undefined {
  if (v.host && tabs.has(norm(v.host))) return v.host;
  return tabs.keys().next().value;
}

async function defaultReopen(logDir: string, wid: string, v: PaneVerdict, tabs: TabMap): Promise<void> {
  const host = liveHost(v, tabs);
  if (!host) throw new Error("no live iTerm session to split");
  const stale = loadRegistry(logDir).filter((e) => e.worker === wid);
  const env = { ...process.env, ITERM_SESSION_ID: host } as NodeJS.ProcessEnv;
  const r = await openPaneForWorker(logDir, readWorkersSection().workers, wid, host, env, undefined, true);
  if (!r.session) throw new Error(r.message);
  for (const e of stale) if (e.session !== r.session) dropPaneEntry(logDir, e, "pane audit", "pane reopened after it vanished");
}

/**
 * A running worker's registered pane is gone: open a new follow pane, retrying with backoff while the terminal
 * cannot be reached; after reopenGraceMs without success the worker is stopped (PANE-REOPEN-FAILED).
 * Returns true when the worker is handled (reopened, or waiting for its next try), false when it fell back to
 * the stop (the caller then records the violation).
 */
async function reopenOrFall(
  logDir: string,
  v: PaneVerdict,
  tabs: TabMap,
  reopen: ((wid: string, v: PaneVerdict, tabs: TabMap) => Promise<unknown>) | undefined,
  stop: ((wid: string, why: string) => Promise<unknown>) | undefined,
  now: Date
): Promise<boolean> {
  const nowMs = now.getTime();
  const all = readJsonAny<ReopenState>(reopenFile(logDir));
  const st = all[v.id] ?? { firstMs: nowMs, tries: 0, nextMs: 0 };
  if (nowMs < st.nextMs) return true;
  try {
    await (reopen ?? ((wid, vv, t) => defaultReopen(logDir, wid, vv, t)))(v.id, v, tabs);
    appendLedger(ledgerPath(logDir), "PANE-REOPENED", { id: v.id, was: v.session, tries: st.tries + 1 }, now);
    delete all[v.id];
    writeFileSync(reopenFile(logDir), JSON.stringify(all), "utf8");
    return true;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    if (nowMs - st.firstMs >= panePolicy().reopenGraceMs) {
      appendLedger(ledgerPath(logDir), "PANE-REOPEN-FAILED", { id: v.id, tries: st.tries + 1, why: err }, now);
      delete all[v.id];
      writeFileSync(reopenFile(logDir), JSON.stringify(all), "utf8");
      await stopUnpaned(logDir, v.id, `pane gone and could not be reopened: ${err}`, stop, now);
      return false;
    }
    // backoff 15 s, 30 s, ... capped at 2 min
    all[v.id] = { firstMs: st.firstMs, tries: st.tries + 1, nextMs: nowMs + Math.min(15_000 * 2 ** st.tries, 120_000) };
    writeFileSync(reopenFile(logDir), JSON.stringify(all), "utf8");
    return true;
  }
}

function readJsonAny<T>(file: string): Record<string, T> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, T>;
  } catch {
    return {};
  }
}

/** End a worker that runs without a registered pane (kill-tree is the normal end path); ledgered PANE-STOPPED. */
async function stopUnpaned(logDir: string, id: string, why: string, stop: ((wid: string, why: string) => Promise<unknown>) | undefined, now: Date): Promise<void> {
  appendLedger(ledgerPath(logDir), "PANE-STOPPED", { id, why }, now);
  await (stop ?? ((wid, reason) => killTree(logDir, wid, { only: true, by: "pane audit", reason })))(id, why).catch(() => undefined);
}

export interface LaunchFinding {
  id: string;
  /** What is wrong: the side that was left behind. */
  kind: "orphan-wrapper" | "orphan-child" | "unlaunched";
  action: string;
}

export interface LaunchAuditDeps {
  records?: () => LaunchRecord[];
  exit?: (id: string) => ExitRecord | null;
  alive?: (pid: number | undefined) => boolean;
  kill?: (pid: number, sig: NodeJS.Signals, group: boolean) => void;
  closePane?: (id: string) => Promise<unknown>;
  /** Running workers: [id, started ms, pane.exec, pane.opened===false]. */
  workers?: () => Array<{ id: string; startedMs: number; exec: boolean; exempt: boolean }>;
  /** Files of an ended launch older than this are removed. */
  keepMs?: number;
  /** Whether a pane is registered for the worker (default: the pane registry). */
  registered?: (id: string) => boolean;
  /** Stops an unlaunched worker (default: kill-tree). */
  stop?: (wid: string, why: string) => Promise<unknown>;
  /** Whether the live process `pid` is still the one this launch started (start time and, for the wrapper, its command). */
  owns?: (pid: number, r: LaunchRecord, side: "wrapper" | "child") => boolean;
  /** Whether the record's iTerm session now belongs to another launch or registered worker. */
  sessionHeld?: (r: LaunchRecord, all: LaunchRecord[]) => boolean;
}

export const LAUNCH_PID_SLACK_MS = 120_000;

/**
 * Whether a process started at `startMs` fits the launch. The wrapper starts when the pane opens (`openedMs`), the child when
 * the command starts (`startedMs`); a run that queued for a provider slot between the two has them minutes apart, so each side
 * is measured against its own stamp.
 */
export function launchPidFresh(startMs: number, r: Pick<LaunchRecord, "openedMs" | "startedMs">, side: "wrapper" | "child"): boolean {
  const at = side === "wrapper" ? (r.openedMs ?? r.startedMs) : r.startedMs;
  return Math.abs(startMs - at) <= LAUNCH_PID_SLACK_MS;
}

/** A pid is the launch's own only when it started within two minutes of its side's launch and, for the wrapper, runs `pane exec <id>`. */
function ownsLaunchPid(pid: number, r: LaunchRecord, side: "wrapper" | "child"): boolean {
  try {
    const env = { ...process.env, LC_ALL: "C" };
    const start = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env }).trim());
    if (Number.isNaN(start) || !launchPidFresh(start, r, side)) return false;
    if (side === "wrapper") return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", env }).includes(r.id);
    return true;
  } catch {
    return false;
  }
}

const killReal = (pid: number, sig: NodeJS.Signals, group: boolean): void => {
  try {
    process.kill(group ? -pid : pid, sig);
  } catch {
    /* gone */
  }
};

/**
 * The launcher audit, a bug detector: a pane-exec whose child is gone while its wrapper (the pane) lives, or
 * whose wrapper is gone while the child lives, has an orphan side, which is killed / closed here; a running
 * worker that never went through the launcher (no pane registered, no waiver record) is stopped. Ledger lines
 * only: PANE-ORPHAN, PANE-UNLAUNCHED. Never a session notice, never PAILot.
 */
export async function auditLaunches(logDir: string, d: LaunchAuditDeps = {}, now: Date = new Date()): Promise<LaunchFinding[]> {
  const out: LaunchFinding[] = [];
  const alive = d.alive ?? pidAlive;
  const kill = d.kill ?? killReal;
  const ledger = ledgerPath(logDir);
  const exitOf = d.exit ?? readExit;
  const nowMs = now.getTime();
  // an injected liveness is a fake world: identity is then taken as given
  const owns = d.owns ?? (d.alive ? () => true : ownsLaunchPid);
  const all = (d.records ?? listRecords)();
  const held =
    d.sessionHeld ??
    ((r: LaunchRecord, recs: LaunchRecord[]) =>
      !!r.session &&
      (recs.some((o) => o.id !== r.id && o.session === r.session && o.startedMs >= r.startedMs) ||
        (!d.records && loadRegistry(logDir).some((e) => e.worker !== r.id && e.session === itermUuid(r.session!)))));
  for (const r of all) {
    const ex = exitOf(r.id);
    // a pid is acted on only while it is verifiably this launch's process: a reused pid is someone else's
    const wrapperUp = alive(r.wrapper) && owns(r.wrapper!, r, "wrapper");
    const childUp = alive(r.child) && owns(r.child!, r, "child");
    // the pane's session now carries another worker: the old record is dropped, nothing is signalled or closed
    if ((wrapperUp || childUp) && held(r, all)) continue;
    if (ex && !wrapperUp && !childUp) continue;
    // the wrapper writes its exit file the moment the child ends; a grace covers the closing itself
    // the wrapper lingers on its own before it closes the pane: only one past that is an orphan
    if (ex && wrapperUp && nowMs - ex.endedMs > panePolicy().launchGraceMs + panePolicy().exitLingerSecs * 1000) {
      kill(r.wrapper!, "SIGKILL", false);
      await (d.closePane ?? defaultClose(logDir))(r.id).catch(() => undefined);
      appendLedger(ledger, "PANE-ORPHAN", { id: r.id, side: "wrapper", why: "child ended, pane still open" }, now);
      out.push({ id: r.id, kind: "orphan-wrapper", action: "wrapper killed, pane closed" });
    } else if (!ex && r.child && !childUp && wrapperUp && nowMs - r.startedMs > panePolicy().launchGraceMs) {
      kill(r.wrapper!, "SIGKILL", false);
      await (d.closePane ?? defaultClose(logDir))(r.id).catch(() => undefined);
      appendLedger(ledger, "PANE-ORPHAN", { id: r.id, side: "wrapper", why: "child gone without an exit file" }, now);
      out.push({ id: r.id, kind: "orphan-wrapper", action: "wrapper killed, pane closed" });
    } else if (!ex && r.wrapper && !wrapperUp && childUp) {
      // the runner reads this marker at the end: its report names the pane audit, not a bare rc 137
      const why = "pane audit: wrapper (the pane) is gone, child killed";
      requestKill(logDir, ledger, r.id, "pane audit", true, why);
      appendStopEvent(logDir, r.id, { killed_by: "pane audit", forced: true, reason: why });
      kill(r.child!, "SIGKILL", true);
      appendLedger(ledger, "PANE-ORPHAN", { id: r.id, side: "child", why: "wrapper (the pane) is gone" }, now);
      out.push({ id: r.id, kind: "orphan-child", action: "child killed" });
    }
  }
  // a running worker nobody launched through a pane, and with no recorded reason to run without one
  const told = readJson(join(logDir, "pane-audit-unlaunched.json"));
  const flagged: Record<string, string> = {};
  const registered = d.registered ?? ((id: string) => loadRegistry(logDir).some((e) => e.worker === id));
  for (const w of (d.workers ?? (() => runningWorkers(logDir)))()) {
    if (w.exec || w.exempt || nowMs - w.startedMs < panePolicy().startGraceMs || registered(w.id)) continue;
    flagged[w.id] = "1";
    if (!told[w.id]) {
      const why = "running without having been started through the pane launcher";
      appendLedger(ledger, "PANE-UNLAUNCHED", { id: w.id, why }, now);
      await stopUnpaned(logDir, w.id, why, d.stop, now);
      out.push({ id: w.id, kind: "unlaunched", action: "stopped" });
    }
  }
  writeFileSync(join(logDir, "pane-audit-unlaunched.json"), JSON.stringify(flagged), "utf8");
  // ended launches: their files are history after a day
  if (!d.records) {
    for (const r of listRecords()) {
      const ex = readExit(r.id);
      if (ex && nowMs - ex.endedMs > (d.keepMs ?? panePolicy().runKeepMs)) for (const f of [recordPath(r.id), exitFilePath(r.id)]) try { unlinkSync(f); } catch { /* gone */ }
    }
  }
  return out;
}

/** Launches whose wrapper outlives its child by this long are orphans (the wrapper closes the pane within a second). */

export interface CloseFinishedDeps {
  registry?: () => PaneEntry[];
  record?: (id: string) => LaunchRecord | null;
  exit?: (id: string) => ExitRecord | null;
  alive?: (pid: number | undefined) => boolean;
  /** A worker's status when no launch record exists: [ended, endedMs, process still owned]. */
  worker?: (id: string) => { ended: boolean; endedMs: number; owned: boolean } | null;
  kill?: (pid: number, sig: NodeJS.Signals, group: boolean) => void;
  closePane?: (id: string) => Promise<unknown>;
}

export interface CloseFinishedResult {
  closed: string[];
  kept: string[];
}

/**
 * Close every registered pane whose owned process is gone and whose linger (clean / failed) has run out:
 * the leftovers of older builds, a wrapper that died, a follow pane of an ended worker. A pane whose process
 * is alive (the exec child, or a worker's own pid) is never closed. Idempotent; nothing is closed in `dryRun`.
 */
export async function closeFinishedPanes(logDir: string, d: CloseFinishedDeps = {}, now: Date = new Date(), dryRun = false): Promise<CloseFinishedResult> {
  const res: CloseFinishedResult = { closed: [], kept: [] };
  const alive = d.alive ?? pidAlive;
  const kill = d.kill ?? killReal;
  const nowMs = now.getTime();
  const seen = new Set<string>();
  for (const e of (d.registry ?? (() => loadRegistry(logDir)))()) {
    if (seen.has(e.worker)) continue;
    seen.add(e.worker);
    const rec = (d.record ?? readRecord)(e.worker);
    let endedMs: number | null = null;
    let linger = panePolicy().exitLingerSecs;
    if (rec) {
      if (alive(rec.child)) {
        res.kept.push(e.worker);
        continue;
      }
      const ex = (d.exit ?? readExit)(e.worker);
      if (!ex) {
        res.kept.push(e.worker); // child gone without an exit record: the launcher audit judges it
        continue;
      }
      endedMs = ex.endedMs;
      linger = panePolicy().exitLingerSecs;
    } else {
      const w = (d.worker ?? ((id: string) => workerEnd(logDir, id)))(e.worker);
      if (!w || !w.ended || w.owned) {
        res.kept.push(e.worker);
        continue;
      }
      endedMs = w.endedMs;
      linger = panePolicy().exitLingerSecs;
    }
    if (!Number.isFinite(endedMs) || nowMs - (endedMs as number) < linger * 1000) {
      res.kept.push(e.worker);
      continue;
    }
    if (!dryRun) {
      if (rec?.wrapper && alive(rec.wrapper)) kill(rec.wrapper, "SIGKILL", false);
      await (d.closePane ?? defaultClose(logDir))(e.worker).catch(() => undefined);
    }
    res.closed.push(e.worker);
  }
  return res;
}

function workerEnd(logDir: string, id: string): { ended: boolean; endedMs: number; owned: boolean } | null {
  const s = loadStatus(logDir, id);
  if (!s) return null;
  return { ended: s.state !== "running" && s.state !== "queued", endedMs: stampMs(s.updated, false), owned: ownsPid(s) };
}

const defaultClose = (logDir: string) => (id: string) => closePaneForWorker(logDir, id);

function runningWorkers(logDir: string): Array<{ id: string; startedMs: number; exec: boolean; exempt: boolean }> {
  const out: Array<{ id: string; startedMs: number; exec: boolean; exempt: boolean }> = [];
  for (const s of loadStatusesCached(logDir)) {
    if (isChatPane(s) || s.state !== "running" || !isLive(s, ownsPidCached)) continue;
    out.push({ id: s.id, startedMs: spawnTimeOf(s) ?? stampMs(s.started, false), exec: s.pane?.exec === true, exempt: s.pane?.opened === false });
  }
  return out;
}

/** `pai worker ps --panes`: process -> pane -> tab for everything running. */
export function renderPaneAudit(verdicts: PaneVerdict[]): string {
  if (!verdicts.length) return "no running process owns a pane to list";
  return verdicts.map((v) => `${v.mark === "ok" ? "ok       " : v.mark.padEnd(9)} ${v.kind.padEnd(6)} ${v.id}  pane ${v.session ?? "-"}  tab ${v.tab ?? "-"}  host tab ${v.hostTab ?? "-"}`).join("\n");
}
