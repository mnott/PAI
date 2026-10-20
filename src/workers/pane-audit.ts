/**
 * pane-audit.ts — every process PAI starts (worker, plan runner, `pai pane run`) owns a LIVE pane in the
 * tab of the session that started it. The audit reads the pane registry and a listing of iTerm sessions
 * with their tab, and judges each running process: ok, NO PANE (none recorded, or gone while the process
 * runs) WRONG TAB (the pane is not in the starting session's tab) or HOST UNKNOWN (the starting session's tab cannot be
 * determined, so the placement cannot be judged). The daemon runs it every 30 s,
 * writes <logDir>/pane-audit.json for `ps` and the cockpit, and reports each violation once.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry, osascriptJxa, type PaneEntry } from "./pane.js";
import { itermUuid } from "./scope.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { loadStatuses, isLive, isChatPane, spawnTimeOf } from "./status.js";
import { loadPlanStatuses } from "./plan-status.js";
import { loadPaneRunStatuses } from "./pane-run.js";
import { eventLine, type Messenger } from "./run-events.js";

export type PaneMark = "ok" | "NO PANE" | "WRONG TAB" | "HOST UNKNOWN" | "SMALL";

export interface AuditProc {
  id: string;
  kind: "worker" | "plan" | "pane";
  /** The starting session's iTerm id (status.term), when known. */
  host?: string;
  /** When the process started (ms); a young process gets the start grace. */
  startedMs?: number;
}

/** A process younger than this (since start or pane registration) is not judged: its pane is still being opened. */
export const START_GRACE_MS = 30_000;

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
export type SizeMap = Map<string, { cols: number; rows: number }>;
const SMALL_COLS = 40;
const SMALL_ROWS = 6;

const norm = (id: string): string => itermUuid(id) || id;

const stampMs = (t: string | undefined, utc: boolean): number => (t ? Date.parse(t.replace(" ", "T") + (utc ? "Z" : "")) : NaN);

export function auditPanes(procs: AuditProc[], registry: PaneEntry[], tabs: TabMap, nowMs?: number, sizes?: SizeMap): PaneVerdict[] {
  const tabOf = (id: string | undefined): string | undefined => (id ? tabs.get(norm(id)) : undefined);
  return procs.map((p) => {
    const e = registry.find((x) => x.worker === p.id);
    const host = e?.host ?? p.host;
    const v: PaneVerdict = { id: p.id, kind: p.kind, mark: "ok", session: e?.session, host };
    if (nowMs !== undefined) {
      // registry stamps are UTC (toISOString); a recent start or a recent registration opens the grace
      const young = [p.startedMs, stampMs(e?.opened, true)].some((t) => t !== undefined && Math.abs(nowMs - t) < START_GRACE_MS);
      if (young) return { ...v, why: "within the start grace" };
    }
    if (!e) return { ...v, mark: "NO PANE", why: "no pane recorded for a running process" };
    const tab = tabOf(e.session);
    if (!tab) return { ...v, mark: "NO PANE", why: `pane ${e.session} is gone while the process runs` };
    const hostTab = tabOf(host);
    if (!hostTab) return { ...v, mark: "HOST UNKNOWN", tab, why: host ? `starting session ${host} is not in the iTerm listing` : `pane ${e.session} has no recorded starting session` };
    if (hostTab !== tab) return { ...v, mark: "WRONG TAB", tab, hostTab, why: `pane ${e.session} sits in ${tab}, the starting session in ${hostTab}` };
    const size = sizes?.get(norm(e.session));
    if (size && (size.cols < SMALL_COLS || size.rows < SMALL_ROWS)) {
      return { ...v, mark: "SMALL", tab, hostTab, why: `pane ${e.session} is ${size.cols}x${size.rows}, under ${SMALL_COLS}x${SMALL_ROWS}` };
    }
    return { ...v, tab, hostTab };
  });
}

/** Everything running now that must own a pane. A run that was refused/allowed hidden (pane.opened false) is exempt. */
export function runningProcs(logDir: string): AuditProc[] {
  const procs: AuditProc[] = [];
  for (const s of loadStatuses(logDir)) {
    if (isChatPane(s) || !isLive(s) || s.state === "queued" || s.pane?.opened === false) continue;
    procs.push({ id: s.id, kind: "worker", host: s.term || undefined, startedMs: spawnTimeOf(s) ?? stampMs(s.started, false) });
  }
  for (const p of loadPlanStatuses(logDir)) if (p.state === "running" && p.hasPane) procs.push({ id: p.id, kind: "plan", startedMs: stampMs(p.started, false) });
  for (const p of loadPaneRunStatuses(logDir)) if (p.state === "running") procs.push({ id: p.id, kind: "pane", startedMs: p.startedMs });
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
            arr(function () { return t.sessions(); }).forEach(function (s) {
                try { out += s.id() + "\\t" + wid + ":" + tid + "\\t" + s.columns() + "\\t" + s.rows() + "\\n"; } catch (e) {}
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
    const [id, tab, cols, rows] = l.split("\t");
    if (id && tab) m.set(norm(id), tab);
    if (id && cols && rows) sizes?.set(norm(id), { cols: Number(cols), rows: Number(rows) });
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
 * One audit round: judge, persist, and report each new violation once (ledger PANE-VIOLATION, the
 * starting session, PAILot). A violation that clears may be reported again if it returns.
 */
export async function auditTick(
  logDir: string,
  msg: Messenger,
  deps: { tabs?: (sizes: SizeMap) => Promise<TabMap>; procs?: () => AuditProc[]; registry?: () => PaneEntry[]; now?: () => Date } = {}
): Promise<PaneVerdict[]> {
  let tabs: TabMap;
  const sizes: SizeMap = new Map();
  try {
    tabs = await (deps.tabs ?? ((z) => listItermTabs(undefined, z)))(sizes);
  } catch {
    return []; // iTerm unreadable: no verdict, no false alarm
  }
  if (tabs.size === 0) return []; // no iTerm (tmux, other platform): nothing to compare against
  const now = deps.now?.() ?? new Date();
  const verdicts = auditPanes((deps.procs ?? (() => runningProcs(logDir)))(), (deps.registry ?? (() => loadRegistry(logDir)))(), tabs, now.getTime(), sizes);
  // a violation counts only when the previous check failed the same way: one bad listing is not a verdict
  const seen = readJson(pendingFile(logDir));
  const failing: Record<string, string> = {};
  for (const v of verdicts) {
    if (v.mark === "ok" || v.mark === "SMALL") continue;
    failing[v.id] = v.mark;
    if (seen[v.id] !== v.mark) Object.assign(v, { mark: "ok", tab: undefined, hostTab: undefined, why: "first failed check, confirming" });
  }
  writeFileSync(pendingFile(logDir), JSON.stringify(failing), "utf8");
  writeFileSync(auditFile(logDir), JSON.stringify({ at: now.toISOString(), verdicts } satisfies AuditFile), "utf8");
  const told = readTold(logDir);
  const next: Record<string, string> = {};
  for (const v of verdicts) {
    if (v.mark === "ok" || v.mark === "SMALL") continue; // SMALL is shown, never alarmed
    next[v.id] = v.mark;
    if (told[v.id] === v.mark) continue;
    appendLedger(ledgerPath(logDir), "PANE-VIOLATION", { id: v.id, kind: v.kind, mark: v.mark, why: v.why }, now);
    const what = `${v.mark}: ${v.kind} ${v.id} runs without its pane in this session's tab (${v.why}).`;
    if (v.host) await msg.toSession({ iterm: v.host }, eventLine(v.id, "pane-violation", { mark: v.mark }, what)).catch(() => false);
    await msg.toPailot(what).catch(() => false);
  }
  writeFileSync(toldFile(logDir), JSON.stringify(next), "utf8");
  return verdicts;
}

/** `pai worker ps --panes`: process -> pane -> tab for everything running. */
export function renderPaneAudit(verdicts: PaneVerdict[]): string {
  if (!verdicts.length) return "no running process owns a pane to list";
  return verdicts.map((v) => `${v.mark === "ok" ? "ok       " : v.mark.padEnd(9)} ${v.kind.padEnd(6)} ${v.id}  pane ${v.session ?? "-"}  tab ${v.tab ?? "-"}  host tab ${v.hostTab ?? "-"}`).join("\n");
}
