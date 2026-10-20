/**
 * pool-panel.ts — the cockpit "Worker pool" panel: whether the worker session
 * pool is on, whether its host is up, what every slot has carried, and how
 * many runs of the last 24 h did NOT go through it (and why). Kept out of
 * cockpit.ts: the data function is pure over its inputs, the loader reads the
 * pool state, metrics and ledger tail, and the page gets its section and
 * script as strings.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { warmOrCold, poolCarry, poolHostAlive, poolMetricsPath, poolSettings, readPoolMetrics, readPoolState } from "../workers/pool.js";
import type { PoolMetricRow, PoolSlotRecord, PoolState } from "../workers/pool.js";
import { readWorkersSection } from "../workers/config.js";
import { parseLedger, type LedgerLine } from "../workers/ledger.js";
import { ledgerPath, workersLogDir } from "../workers/paths.js";

export interface PoolPanelSlot {
  provider: string;
  model: string;
  cwd: string;
  state: "idle" | "busy";
  ageSecs: number;
  idleSecs: number;
  tasks: number;
  tokensCarried: number;
  /** First-request cache hit ratio over this slot's tasks (null = no task yet). */
  hitRatio: number | null;
  /** Task the slot is serving right now, and its branch (slot-worktree slots). */
  task: string | null;
  branch: string | null;
  /** Was the last task's first request served from the prefix cache ("warm") or prefilled ("cold")? */
  firstRequest: "warm" | "cold" | null;
}

export interface PoolPanelData {
  enabled: boolean;
  hostUp: boolean;
  port: number;
  maxSlots: number;
  idleKillSecs: number;
  hostSince: string | null;
  slots: PoolPanelSlot[];
  totals: { tasksServed: number; tokensCarried: number; hitRatio: number | null; carriedTasks: number };
  last24h: {
    runs: number;
    pooled: number;
    notPooled: number;
    /** Reasons the pool gate or host gave, most frequent first. */
    reasons: Array<{ reason: string; runs: number }>;
    topReason: string | null;
    /** Runs not pooled that predate reason logging, or ran while the pool was off. */
    unattributed: number;
  };
  /** One plain sentence for the operator. */
  message: string;
}

export interface PoolPanelInput {
  enabled: boolean;
  hostUp: boolean;
  port: number;
  maxSlots: number;
  idleSecs: number;
  state: PoolState | null;
  metrics: PoolMetricRow[];
  ledger: LedgerLine[];
  nowMs: number;
}

/** Ledger stamps are local wall time. */
function stampMs(stamp: string): number {
  return new Date(stamp.replace(" ", "T")).getTime();
}

const DAY_MS = 24 * 3600_000;

export function buildPoolPanel(i: PoolPanelInput): PoolPanelData {
  const slots: PoolPanelSlot[] = (i.state?.slots ?? []).map((s: PoolSlotRecord) => {
    const rows = s.claudeSession ? i.metrics.filter((m) => m.slotSession === s.claudeSession) : [];
    const c = poolCarry(rows);
    return {
      provider: s.provider,
      model: s.model,
      cwd: s.cwd,
      state: s.busyWith ? "busy" : "idle",
      ageSecs: Math.max(0, Math.round((i.nowMs - stampMs(s.spawnedAt)) / 1000)),
      idleSecs: Math.max(0, Math.round((i.nowMs - stampMs(s.lastUsedAt)) / 1000)),
      tasks: s.tasks,
      tokensCarried: c.tokensCarried,
      hitRatio: rows.length ? c.hitRatio : null,
      task: s.busyWith,
      branch: s.branch ?? null,
      firstRequest: warmOrCold(s.firstShare),
    };
  });
  const carry = poolCarry(i.metrics);

  const since = i.nowMs - DAY_MS;
  let runs = 0;
  let pooled = 0;
  const reasons = new Map<string, number>();
  let skipped = 0;
  for (const l of i.ledger) {
    if (stampMs(l.stamp) < since) continue;
    if (l.event === "WORKER-START") {
      runs++;
      if (l.fields.mode === "pooled") pooled++;
    } else if (l.event === "WORKER-POOL-SKIP") {
      skipped++;
      const r = l.fields.reason ?? "unknown";
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
  }
  const notPooled = Math.max(0, runs - pooled);
  const sorted = [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, runs: n }));
  const last24h = {
    runs,
    pooled,
    notPooled,
    reasons: sorted,
    topReason: sorted[0]?.reason ?? null,
    unattributed: Math.max(0, notPooled - skipped),
  };

  let message: string;
  if (!i.enabled) message = "Pool is OFF (workers.pool.enabled is false): every worker spawns a fresh claude. Turn on with `pai worker pool on`.";
  else if (!i.hostUp) message = "Pool is enabled but its host is DOWN: every worker spawns fresh. Start it with `pai worker pool on`.";
  else if (!carry.tasks && !pooled) message = "Pool is up but has not served a task yet (no slot spawns before the first pooled task).";
  else message = `Pool served ${i.state?.tasksServed ?? carry.tasks} task(s) since the host started; ${pooled} of ${runs} runs in 24 h were pooled.`;

  return {
    enabled: i.enabled,
    hostUp: i.hostUp,
    port: i.port,
    maxSlots: i.maxSlots,
    idleKillSecs: i.idleSecs,
    hostSince: i.state?.startedAt ?? null,
    slots,
    totals: {
      tasksServed: i.state?.tasksServed ?? 0,
      tokensCarried: carry.tokensCarried,
      hitRatio: carry.tasks ? carry.hitRatio : null,
      carriedTasks: carry.tasks,
    },
    last24h,
    message,
  };
}

/** The last `bytes` of a (possibly 30+ MB) ledger, from a line boundary. */
export function readLedgerTail(path: string, bytes = 6_000_000): LedgerLine[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let text = buf.toString("utf8");
    if (size > len) text = text.slice(text.indexOf("\n") + 1);
    return parseLedger(text);
  } finally {
    closeSync(fd);
  }
}

/** Panel data from the live workers config and logDir; cached 15 s. */
export function cachedPoolPanel(): () => Promise<PoolPanelData | null> {
  let at = 0;
  let cached: PoolPanelData | null = null;
  return async () => {
    if (Date.now() - at < 15_000) return cached;
    at = Date.now();
    try {
      const { workers } = readWorkersSection();
      const logDir = workersLogDir(workers);
      const s = poolSettings(workers);
      cached = buildPoolPanel({
        enabled: s.enabled,
        hostUp: await poolHostAlive(s.port),
        port: s.port,
        maxSlots: s.maxSlots,
        idleSecs: s.idleSecs,
        state: readPoolState(logDir),
        metrics: readPoolMetrics(poolMetricsPath(logDir)),
        ledger: readLedgerTail(ledgerPath(logDir)),
        nowMs: Date.now(),
      });
    } catch {
      cached = null;
    }
    return cached;
  };
}

/** Process-wide instance so the 15 s cache survives across requests. */
export const sharedPoolPanel = cachedPoolPanel();

/** The card, placed in the page body. */
export const POOL_PANEL_HTML = `<section data-section="pool" class="card c12"><h2>Worker pool<span class="tip" id="pooltip" tabindex="0" aria-label="Worker pool status" data-tip="Worker pool status">ⓘ</span></h2><div id="poolpanel"></div></section>`;

/** Page script (no template literals, ES5): defines loadPool(); uses the page's esc, fmt, pct, table helpers. */
export const POOL_PANEL_JS = String.raw`
function renderPool(p){
 var el=$("poolpanel");if(!p){el.innerHTML='<span class="dim">pool status unavailable</span>';return}
 function dur(s){return s<90?s+"s":s<5400?Math.round(s/60)+"m":Math.round(s/3600)+"h"}
 var head='<div class="kpis">'+
  [["pool",p.enabled?'<span class="ok">enabled</span>':'<span class="bad">disabled</span>',"max "+p.maxSlots+" slots · idle kill "+(p.idleKillSecs?dur(p.idleKillSecs):"never")],
   ["host",p.hostUp?'<span class="ok">up</span>':'<span class="bad">down</span>',"port "+p.port+(p.hostSince?" · since "+esc(p.hostSince):"")],
   ["tasks served",p.totals.tasksServed,fmt(p.totals.tokensCarried)+" cache-read tokens carried"],
   ["first-request hit",p.totals.hitRatio==null?"n/a":pct(p.totals.hitRatio),p.totals.carriedTasks+" pooled task(s)"],
   ["not pooled (24 h)",p.last24h.notPooled+" of "+p.last24h.runs,p.last24h.topReason?"top reason: "+esc(p.last24h.topReason):(p.last24h.notPooled?"reasons not logged yet":"")]
  ].map(function(k){return'<div class="kpi"><b>'+k[1]+'</b><span>'+k[0]+'</span><span style="display:block">'+k[2]+'</span></div>'}).join("")+'</div>';
 var rows=p.slots.length?table(["provider","model","cwd","state","task","branch","first req","age","idle","tasks","carried","hit%"],p.slots.map(function(s){return[esc(s.provider),esc(s.model),'<span title="'+esc(s.cwd)+'">'+esc(s.cwd.split("/").slice(-2).join("/"))+'</span>','<span class="'+(s.state==="busy"?"warn":"ok")+'">'+s.state+'</span>',s.task?esc(s.task):"-",s.branch?esc(s.branch):"-",s.firstRequest?'<span class="'+(s.firstRequest==="warm"?"ok":"warn")+'">'+s.firstRequest+'</span>':"-",dur(s.ageSecs),dur(s.idleSecs),s.tasks,fmt(s.tokensCarried),s.hitRatio==null?"-":pct(s.hitRatio)]})):'<span class="dim" title="A slot spawns with the first pooled task.">no slots</span>';
 var rs=p.last24h.reasons.length?"\nRejections (24 h): "+p.last24h.reasons.map(function(r){return r.reason+" x"+r.runs}).join(", ")+(p.last24h.unattributed?" · "+p.last24h.unattributed+" without a logged reason":""):"";
 setTip($("pooltip"),p.message+rs);
 el.innerHTML=head+rows;
}
function loadPool(){fetch("/cockpit/pool",{cache:"no-store"}).then(function(r){return r.json()}).then(renderPool).catch(function(){})}
`;
