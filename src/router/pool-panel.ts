/**
 * pool-panel.ts — the cockpit "Worker pool" panel: whether the worker session
 * pool is on, whether its host is up, what every slot has carried, and how
 * many runs of the last 24 h did NOT go through it (and why). Kept out of
 * cockpit.ts: the data function is pure over its inputs, the loader reads the
 * pool state, metrics and ledger tail, and the page gets its section and
 * script as strings.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { warmOrCold, poolCarry, poolHostStale, bundleBuildStamp, poolHostProbe, poolMetricsPath, poolSettings, readPoolMetrics, readPoolState } from "../workers/pool.js";
import type { PoolMetricRow, PoolSlotRecord, PoolState, SpareMissReason } from "../workers/pool.js";
import { diskBundleMtime, ensurePoolHost } from "../workers/pool-cli.js";
import { cockpitProbeSettings } from "./cockpit-layout.js";
import { readWorkersCached } from "../workers/config.js";
import { parseLedger, type LedgerLine, parseStamp } from "../workers/ledger.js";
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
  /** When the host's code was built (its bundle mtime), null when unknown. */
  hostBuiltAt: string | null;
  /** A newer build is on disk than the one the host runs. */
  hostStale: boolean;
  /** When the host last ran (its state file's update stamp), null when it never started. */
  hostLastSeen: string | null;
  slots: PoolPanelSlot[];
  /** Ready/starting spares per provider, from the host state (empty when the host never reported spares). */
  spares: Array<{ provider: string; ready: number; starting: number }>;
  /** Claims served from a spare since the host started (0 when the state file predates spares). */
  spareClaims: number;
  /** Claims that found no usable spare, by reason, most frequent first. */
  spareMisses: Array<{ reason: string; misses: number }>;
  totals: { tasksServed: number; tokensCarried: number; hitRatio: number | null; carriedTasks: number };
  last24h: {
    runs: number;
    pooled: number;
    notPooled: number;
    /** Reasons the pool gate or host gave, most frequent first. */
    reasons: Array<{ reason: string; runs: number }>;
    topReason: string | null;
    /** Runs not pooled that predate reason logging (no skip line, pool was on). */
    unattributed: number;
    /** Runs started before the pool showed any activity in the window, or while it is disabled: not "not pooled because of X". */
    poolOff: number;
  };
  /** Why the pool is off, from the fields this panel already has; null when it is on. */
  offReason: string | null;
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
  /** mtime of the host bundle on disk (null/absent = unknown). */
  diskBundleMtimeMs?: number | null;
}

/** Ledger stamps are local wall time. */
function stampMs(stamp: string): number {
  return parseStamp(stamp);
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
  // the ledger has no on/off marker: the pool counts as on from its first trace in the window
  // (any WORKER-POOL-* line, a pooled run or a spare claim), and as off for the whole window when disabled
  const isPooledStart = (l: LedgerLine): boolean => l.event === "WORKER-START" && (l.fields.mode === "pooled" || l.fields.spare === "hit");
  let onSince = Infinity;
  for (const l of i.ledger) {
    const t = stampMs(l.stamp);
    if (t < since || t >= onSince) continue;
    if (l.event.startsWith("WORKER-POOL-") || isPooledStart(l)) onSince = t;
  }
  if (!i.enabled) onSince = Infinity;
  let poolOff = 0;
  for (const l of i.ledger) {
    if (stampMs(l.stamp) < since) continue;
    if (l.event === "WORKER-START") {
      runs++;
      if (isPooledStart(l)) pooled++;
      else if (stampMs(l.stamp) < onSince) poolOff++;
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
    unattributed: Math.max(0, notPooled - skipped - poolOff),
    poolOff,
  };

  // the reason the host records when settings.spares is 0 (pool-host claimSpare)
  const SPARES_OFF: SpareMissReason = "spares-off";
  // spares and spare misses come from the host state; a state file from before spares reports none
  const spareGroups = new Map<string, { ready: number; starting: number }>();
  for (const sp of i.state?.spares ?? []) {
    const g = spareGroups.get(sp.provider) ?? { ready: 0, starting: 0 };
    if (sp.state === "ready") g.ready += 1;
    else g.starting += 1;
    spareGroups.set(sp.provider, g);
  }
  const spares = [...spareGroups.entries()].map(([provider, g]) => ({ provider, ready: g.ready, starting: g.starting }));
  const spareMisses = [...Object.entries(i.state?.spareMisses ?? {})].sort((a, b) => b[1] - a[1]).map(([reason, misses]) => ({ reason, misses }));

  // provider-neutral: the pool pre-starts spares for every provider, so no message names one
  let offReason: string | null = null;
  let message: string;
  if (!i.enabled) {
    offReason = "config disabled";
    message = "Pool is OFF (config disabled): every worker starts cold (no pre-started spare). Turn on with `pai worker pool on`.";
  } else if (!i.hostUp) {
    offReason = "host down";
    message = "Pool is enabled but its host is DOWN (host down): every worker starts cold (no pre-started spare). Start it with `pai worker pool on`.";
  } else if (i.state?.spares !== undefined && (i.state.spareMisses?.[SPARES_OFF] ?? 0) > 0 && !(i.state.spareClaims ?? 0)) {
    offReason = "claims disabled: spares are off";
    message = "Pool host is up but spare claims are disabled (pool.spares is 0): every worker starts cold.";
  } else if (!carry.tasks && !pooled) message = "Pool is up but has not served a task yet (no slot spawns before the first pooled task).";
  else message = `Pool served ${i.state?.tasksServed ?? carry.tasks} task(s) since the host started; ${pooled} of ${runs} runs in 24 h were pooled.`;

  return {
    enabled: i.enabled,
    hostUp: i.hostUp,
    port: i.port,
    maxSlots: i.maxSlots,
    idleKillSecs: i.idleSecs,
    hostSince: i.state?.startedAt ?? null,
    hostLastSeen: i.state?.updatedAt ?? null,
    hostBuiltAt: i.state?.bundleMtimeMs !== undefined ? bundleBuildStamp(i.state.bundleMtimeMs) : null,
    hostStale: poolHostStale(i.state?.bundleMtimeMs, i.diskBundleMtimeMs ?? null),
    slots,
    spares,
    spareClaims: i.state?.spareClaims ?? 0,
    spareMisses,
    totals: {
      tasksServed: i.state?.tasksServed ?? 0,
      tokensCarried: carry.tokensCarried,
      hitRatio: carry.tasks ? carry.hitRatio : null,
      carriedTasks: carry.tasks,
    },
    last24h,
    offReason,
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

const hostState = new Map<number, { up: boolean; strikes: number }>();

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the pool host is shown up. A probe that timed out says the router's own event loop (or the
 * host) was busy, not that the host is gone: while its pid is alive that keeps the last known state,
 * and only `strikesToDown` timeouts in a row show it down. A refused connection or a dead pid is down at once.
 */
export async function poolHostUp(port: number, hostPid: number | undefined, strikesToDown: number, probe = poolHostProbe): Promise<boolean> {
  const r = await probe(port);
  const prev = hostState.get(port) ?? { up: true, strikes: 0 };
  let up: boolean;
  if (r === "timeout" && pidAlive(hostPid)) {
    const strikes = prev.strikes + 1;
    up = prev.up && strikes < strikesToDown;
    hostState.set(port, { up, strikes });
  } else {
    up = r === "up";
    hostState.set(port, { up, strikes: 0 });
  }
  return up;
}

/** Panel data from the live workers config and logDir; cached 15 s. */
export function cachedPoolPanel(): () => Promise<PoolPanelData | null> {
  let at = 0;
  let cached: PoolPanelData | null = null;
  return async () => {
    if (Date.now() - at < 15_000) return cached;
    at = Date.now();
    try {
      const workers = readWorkersCached();
      const logDir = workersLogDir(workers);
      const s = poolSettings(workers);
      void ensurePoolHost(logDir).catch(() => undefined); // a lost host heals itself (bounded, logged)
      const state = readPoolState(logDir);
      cached = buildPoolPanel({
        enabled: s.enabled,
        hostUp: await poolHostUp(s.port, state?.hostPid, cockpitProbeSettings().timeoutStrikes),
        port: s.port,
        maxSlots: s.maxSlots,
        idleSecs: s.idleSecs,
        state,
        metrics: readPoolMetrics(poolMetricsPath(logDir)),
        ledger: readLedgerTail(ledgerPath(logDir)),
        nowMs: Date.now(),
        diskBundleMtimeMs: diskBundleMtime(),
      });
    } catch {
      cached = null;
    }
    return cached;
  };
}

/** Process-wide instance so the 15 s cache survives across requests. */
export const sharedPoolPanel = cachedPoolPanel();

/** Page script (ES5): defines loadPool(), the pool poll feeding the pool cards. */
export const POOL_PANEL_JS = String.raw`
function loadPool(){feed("pool","/cockpit/pool",["pool"],function(j){try{poolSwap(j);Win.update("pool",j)}catch(e){}})}
`;
