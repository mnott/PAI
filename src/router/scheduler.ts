/**
 * scheduler.ts — request-level scheduling for local engines.
 *
 * A local engine (one provider) is served one request at a time; further
 * requests wait in the router instead of interleaving inside the engine's
 * batch. Order is virtual-token-counter fair across the OWNING SESSIONS of the
 * workers (x-pai-session): each session's counter grows by the weighted tokens
 * its requests cost the engine (new prefill + decode), divided by its weight;
 * the session with the smallest counter among those waiting goes next.
 *
 *   - a session turning backlogged is lifted to the smallest counter among
 *     the sessions already backlogged (no banked credit from idle time)
 *   - a request waiting longer than agingSec goes next regardless
 *   - inside a session: FIFO, except a request whose worker's conversation is
 *     warm (last turn under warmMs ago, prefix likely cached) goes first
 *   - a hint (x-pai-priority, e.g. the high of an interactive `pai session
 *     --local`) ranks a bare client — one with no worker status file for the
 *     control source to read; a worker's current controls always win
 *
 * Accounting per request (queue wait, service time) is kept per worker
 * (x-pai-worker) and published through snapshot(): the router serves it at
 * /cockpit/scheduler and mirrors it to <workers log dir>/router-sched.json for
 * `pai worker ps` and the worker scheduler (readSchedFile).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { minOf } from "../utils/min-max.js";
import { join } from "node:path";

export interface SchedConfig {
  enabled: boolean;
  wTokIn: number;
  wTokOut: number;
  agingSec: number;
  sessionWeights: Record<string, number>;
  /** A worker whose last turn ended under this long ago still has its prefix cached (ms). */
  warmMs: number;
  /** Queued-stream ping interval (ms); PAI_ROUTER_PING_MS shortens it for tests. */
  pingMs: number;
  /** A low-priority request waiting longer than this gets one turn although higher ones wait (seconds). */
  lowAgingSec: number;
  /** An in-flight request with no upstream bytes for this long is released as stale (minutes). */
  staleMin: number;
}

/**
 * The fallback used when the config cannot be read (fail-open paths). The
 * policy values themselves live in the shipped defaults file
 * (src/config/defaults/config.yaml, `router.scheduling`) and reach the
 * scheduler through `loadConfig().router.scheduling` → `schedConfigFrom`.
 */
export const DEFAULT_SCHED: SchedConfig = { enabled: true, wTokIn: 1, wTokOut: 2, agingSec: 120, sessionWeights: {}, warmMs: 300_000, pingMs: 15_000, lowAgingSec: 900, staleMin: 5 };

export const SCHED_FILE = "router-sched.json";

/** Merge a raw `router.scheduling` config block over the defaults; bad values fall back. */
export function schedConfigFrom(raw: unknown): SchedConfig {
  const out: SchedConfig = { ...DEFAULT_SCHED, sessionWeights: {} };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  for (const k of ["wTokIn", "wTokOut", "agingSec", "warmMs", "pingMs", "lowAgingSec", "staleMin"] as const) {
    const v = r[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  if (r.sessionWeights && typeof r.sessionWeights === "object") {
    for (const [k, v] of Object.entries(r.sessionWeights as Record<string, unknown>)) {
      if (typeof v === "number" && v > 0) out.sessionWeights[k] = v;
    }
  }
  return out;
}

export interface Served {
  /** tokens the engine had to compute fresh for the prompt */
  prefill: number;
  decode: number;
}

export interface Ticket {
  /** ms spent queued (0 when granted at once) */
  waitedMs: number;
  /** the engine (instance) that granted the slot: with alternatives it is the first one with a free slot */
  engine: string;
  /** Free the engine. Idempotent; the first call's `served` is what the session is charged. */
  release(served?: Served, opts?: ReleaseOpts): void;
  /** Upstream bytes arrived: the holder is alive (resets the stale clock). */
  touch(): void;
  /** Estimated prompt tokens of the request in flight: the engine reads them before the first byte, which is progress. */
  setPromptTokens(n: number): void;
  /** Set by the router: ends the client's response with a retryable error and aborts the upstream request (engine-idle release). */
  onReap?: () => void;
}

export interface ReleaseOpts {
  /** the response just ended in a build-gate call: the worker will idle a while (parking candidate) */
  gate?: boolean;
}

/** Runs while the engine is still held after a gate-bound response; the engine frees when it settles. */
export type IdleHook = (engine: string, worker: string, waiting: number) => Promise<void>;

/** A worker's current engine controls (priority, pause): read at every admission decision. */
export type ControlSource = (worker: string, hint?: Priority) => { priority: Priority; paused: boolean; preemptedBy?: string };
export type Priority = "high" | "normal" | "low";
const LEVELS: readonly Priority[] = ["high", "normal", "low"];

interface Waiter {
  seq: number;
  /** priority the request announced (x-pai-priority); the control source outranks it */
  hint?: Priority;
  session: string;
  worker: string;
  at: number;
  interactive?: SessionOpts;
  grant: (t: Ticket) => void;
  fail: (e: Error) => void;
  /** engines this request may run on (it waits in all of them; the first free slot takes it) */
  engines?: string[];
}

interface Flight {
  session: string;
  worker: string;
  since: number;
  /** epoch ms of the last upstream byte (or the grant) */
  lastByte: number;
  /** estimated prompt tokens; reading them delays the first byte */
  promptTokens?: number;
  /** true once the first upstream byte arrived */
  gotByte?: boolean;
  /** held on purpose while the conversation is saved: never stale */
  parking?: boolean;
  release?: () => void;
  /** ends the client's request so it retries (engine-idle watchdog) */
  reap?: () => void;
}

interface Engine {
  /** requests holding a slot of this engine (at most `slots`) */
  flights: Flight[];
  /** concurrent requests the engine serves (1 unless the provider declares more) */
  slots: number;
  /** worker whose conversation the engine holds (its last response) */
  lastWorker?: string;
  waiting: Waiter[];
  /** epoch ms a low-priority request was last admitted (the anti-starvation turn counts from it) */
  lastLowAt?: number;
}

export interface WorkerAcct {
  requests: number;
  waitMsTotal: number;
  lastWaitMs: number;
  serviceMsTotal: number;
  lastServiceMs: number;
  /** epoch ms the worker's oldest queued request began waiting, 0 when none queued */
  waitingSince: number;
  /** epoch ms the worker's request in flight began, 0 when none (also 0 while the engine is parked saving its conversation — see parking.ts) */
  activeSince: number;
  lastEnd: number;
  session: string;
  engine: string;
  /** controls as of the last snapshot */
  priority?: Priority;
  paused?: boolean;
}

/** What the router knows of an interactive request (x-pai-interactive, x-pai-failover). */
export interface SessionOpts {
  /** the request was failed over from the cloud (ROUTER-FAILOVER) */
  failover?: boolean;
}

/** An interactive local session (pai local / pai NAME --local), keyed by session name; gone 30 min after its last request. */
export interface SessionAcct {
  session: string;
  engine: string;
  requests: number;
  waitMsTotal: number;
  lastWaitMs: number;
  serviceMsTotal: number;
  lastServiceMs: number;
  /** epoch ms of the last request */
  lastRequest: number;
  /** a request is being served now */
  inflight: boolean;
  /** prefill + decode tokens served */
  tokens: number;
  failover?: boolean;
}

/** An interactive session entry expires after this long without a request (ms). */
export const SESSION_TTL_MS = 30 * 60_000;

export interface SchedSnapshot {
  at: number;
  engines: Record<string, { inflight: { session: string; worker: string; sinceMs: number } | null; /** every request holding a slot, and the slot count (absent in older snapshots) */ flights?: Array<{ session: string; worker: string; sinceMs: number }>; slots?: number; queued: Record<string, number>; counters: Record<string, number> }>;
  workers: Record<string, WorkerAcct>;
  /** interactive sessions by name (absent in snapshots written by older routers) */
  sessions?: Record<string, SessionAcct>;
}

/** Local prompt-reading speed assumed by the stale reaper (tokens/s), and the slack on it. */
export const PROMPT_READ_TOK_S = 50;
export const PROMPT_READ_SLACK = 1.5;

/** Silence allowed before the stale reaper acts: while the prompt is still being read, max(staleMin, tokens/50*1.5). */
function staleLimitMs(staleMs: number, f: { promptTokens?: number; gotByte?: boolean }): number {
  if (f.gotByte || !f.promptTokens) return staleMs;
  return Math.max(staleMs, (f.promptTokens / PROMPT_READ_TOK_S) * PROMPT_READ_SLACK * 1000);
}

export class RequestScheduler {
  private engines = new Map<string, Engine>();
  private counters = new Map<string, Map<string, number>>();
  private workers = new Map<string, WorkerAcct>();
  private sessions = new Map<string, SessionAcct>();
  private seq = 0;
  /** called after any state change (the router mirrors the snapshot to disk) */
  onChange?: () => void;
  /** parking: see parking.ts */
  idleHook?: IdleHook;
  /** per-worker priority and pause; absent = everyone normal, nobody paused */
  control?: ControlSource;
  /** safety net: called (once per tick) for a paused waiter; true = it lifted an orphaned pause (cause gone), so the waiter is eligible again */
  orphanPause?: (worker: string) => boolean;
  /** called when a stale holder was released (the router writes the ledger line) */
  onStale?: (engine: string, worker: string, session: string, idleMs: number) => void;
  /** engine-idle watchdog: true when the engine shows no activity right now (router wires the GPU summary); absent = watchdog off */
  engineIdle?: (engine: string) => boolean;
  /** seconds a request may be in flight while the engine is idle before it is released; 0 = off */
  engineIdleSecs: () => number = () => 0;
  /** called when the idle watchdog released a request */
  onEngineIdle?: (engine: string, worker: string, session: string, inflightMs: number) => void;
  private idleSince = new Map<string, number>();
  private recheck?: NodeJS.Timeout;
  private reaper?: NodeJS.Timeout;

  constructor(private cfg: () => SchedConfig = () => DEFAULT_SCHED, private now: () => number = Date.now) {}

  private engine(name: string): Engine {
    let e = this.engines.get(name);
    if (!e) this.engines.set(name, (e = { flights: [], slots: 1, waiting: [] }));
    return e;
  }

  /** Concurrent requests an engine serves (a multi-instance provider's per-instance maxConcurrent). */
  setSlots(name: string, n: number): void {
    const e = this.engine(name);
    const slots = Math.max(1, Math.floor(n) || 1);
    if (e.slots === slots) return;
    e.slots = slots;
    this.dispatch(name);
  }

  /** Requests holding a slot of the engine plus those queued on it (what a router balances by). */
  load(name: string): number {
    const e = this.engines.get(name);
    return e ? e.flights.length + e.waiting.length : 0;
  }

  /** Free slots of the engine. */
  free(name: string): number {
    const e = this.engines.get(name);
    return e ? Math.max(0, e.slots - e.flights.length) : 1;
  }

  private ctr(name: string): Map<string, number> {
    let c = this.counters.get(name);
    if (!c) this.counters.set(name, (c = new Map()));
    return c;
  }

  private acct(worker: string, session: string, engine: string): WorkerAcct {
    let a = this.workers.get(worker);
    if (!a) {
      a = { requests: 0, waitMsTotal: 0, lastWaitMs: 0, serviceMsTotal: 0, lastServiceMs: 0, waitingSince: 0, activeSince: 0, lastEnd: 0, session, engine };
      this.workers.set(worker, a);
    }
    a.session = session;
    a.engine = engine;
    return a;
  }

  /** Releases every in-flight holder with no upstream bytes for staleMin minutes; returns how many. */
  reapStale(): number {
    const staleMs = this.cfg().staleMin * 60_000;
    if (!(staleMs > 0)) return 0;
    const now = this.now();
    let n = 0;
    for (const [name, e] of this.engines) {
      for (const f of [...e.flights]) {
        const limit = staleLimitMs(staleMs, f);
        if (f.parking || !f.release || now - f.lastByte <= limit) continue;
        n++;
        try {
          this.onStale?.(name, f.worker, f.session, now - f.lastByte);
        } catch {
          /* logging is best effort */
        }
        f.release();
      }
    }
    return n;
  }

  /**
   * Engine-idle watchdog: a request in flight (and silent) for `engineIdleSecs` while the engine has shown no activity
   * for that long is released and its client told to retry. Never releases while the engine shows activity. Returns how many.
   */
  reapEngineIdle(): number {
    const limit = this.engineIdleSecs() * 1000;
    if (!(limit > 0) || !this.engineIdle) return 0;
    const now = this.now();
    let n = 0;
    for (const [name, e] of this.engines) {
      let idle = false;
      try {
        idle = this.engineIdle(name);
      } catch {
        idle = false;
      }
      if (!idle) {
        this.idleSince.delete(name);
        continue;
      }
      if (!this.idleSince.has(name)) this.idleSince.set(name, now);
      for (const f of [...e.flights]) {
        if (f.parking || !f.release) continue;
        if (now - this.idleSince.get(name)! < limit || now - f.since < limit || now - f.lastByte < limit) continue;
        n++;
        try {
          this.onEngineIdle?.(name, f.worker, f.session, now - f.since);
        } catch {
          /* logging is best effort */
        }
        try {
          f.reap?.();
        } catch {
          /* the slot is freed below regardless */
        }
        f.release();
      }
    }
    return n;
  }

  private armReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      this.reapStale();
      this.reapEngineIdle();
      if (![...this.engines.values()].some((e) => e.flights.length)) {
        clearInterval(this.reaper);
        this.reaper = undefined;
      }
    }, 15_000);
    this.reaper.unref();
  }

  /** The worker whose conversation the engine's slot holds, if known. */
  slotHolder(engineName: string): string | undefined {
    return this.engines.get(engineName)?.lastWorker;
  }

  /** Queued-stream ping interval of the current scheduling config (ms). */
  pingMs(): number {
    return this.cfg().pingMs;
  }

  private isWarm(worker: string): boolean {
    const a = this.workers.get(worker);
    return !!a && a.lastEnd > 0 && this.now() - a.lastEnd < this.cfg().warmMs;
  }

  /** Wait for the engine. Resolves with a ticket; rejects only when cancelled. */
  acquire(engineName: string, session: string, worker: string, signal?: { onAbort(cb: () => void): void }, hint?: Priority, interactive?: SessionOpts, alts?: string[]): Promise<Ticket> {
    const eng = this.engine(engineName);
    // with alternatives the request waits on every engine and runs on the first with a free slot (its own engine first when free)
    const group = alts && alts.length ? [engineName, ...alts.filter((a) => a !== engineName)] : undefined;
    const now = this.now();
    const ctr = this.ctr(engineName);
    // re-backlog lift: a session with nothing queued or running starts level with the backlogged ones
    const backlogged = new Set<string>(eng.waiting.map((w) => w.session));
    for (const f of eng.flights) backlogged.add(f.session);
    if (!backlogged.has(session)) {
      const others = [...backlogged].map((s) => ctr.get(s) ?? 0);
      const floor = others.length ? minOf(others) : 0;
      ctr.set(session, Math.max(ctr.get(session) ?? 0, floor));
    } else if (!ctr.has(session)) ctr.set(session, 0);
    const acct = this.acct(worker, session, engineName);
    if (interactive) {
      const prev = this.sessions.get(session);
      this.sessions.set(session, { session, engine: engineName, requests: prev?.requests ?? 0, waitMsTotal: prev?.waitMsTotal ?? 0, lastWaitMs: prev?.lastWaitMs ?? 0, serviceMsTotal: prev?.serviceMsTotal ?? 0, lastServiceMs: prev?.lastServiceMs ?? 0, lastRequest: now, inflight: prev?.inflight ?? false, tokens: prev?.tokens ?? 0, ...(interactive.failover || (prev?.failover && now - prev.lastRequest < SESSION_TTL_MS) ? { failover: true } : {}) });
    }
    return new Promise<Ticket>((resolve, reject) => {
      const w: Waiter = { seq: ++this.seq, hint, session, worker, at: now, interactive, grant: resolve, fail: reject, ...(group ? { engines: group } : {}) };
      for (const n of group ?? [engineName]) this.engine(n).waiting.push(w);
      if (!acct.waitingSince) acct.waitingSince = now;
      signal?.onAbort(() => {
        if (!eng.waiting.includes(w)) return;
        this.unqueue(w, engineName);
        this.refreshWaiting(worker);
        w.fail(new Error("cancelled while queued"));
        this.changed();
      });
      // the engine with the most free slots first, so a free instance never idles while the request waits on a busy one
      const order = (group ?? [engineName]).map((n, k) => ({ n, k, free: this.free(n) })).sort((a, b) => b.free - a.free || a.k - b.k);
      for (const o of order) this.dispatch(o.n);
    });
  }

  /** Takes a waiter out of every engine queue it sits in. */
  private unqueue(w: Waiter, engineName: string): void {
    for (const n of w.engines ?? [engineName]) {
      const q = this.engines.get(n)?.waiting;
      const i = q ? q.indexOf(w) : -1;
      if (q && i >= 0) q.splice(i, 1);
    }
  }

  private refreshWaiting(worker: string): void {
    const a = this.workers.get(worker);
    if (!a) return;
    let oldest = 0;
    for (const e of this.engines.values()) for (const w of e.waiting) if (w.worker === worker && (!oldest || w.at < oldest)) oldest = w.at;
    a.waitingSince = oldest;
  }

  /** The `--now` run that preempted this worker (paused it, request in flight to be aborted), if it is paused by one now. */
  preemptedBy(worker: string): string | undefined {
    try {
      const c = this.control?.(worker);
      return c?.paused ? c.preemptedBy : undefined;
    } catch {
      return undefined;
    }
  }

  private ctl(w: Waiter): { priority: Priority; paused: boolean } {
    try {
      return this.control?.(w.worker, w.hint) ?? { priority: w.hint ?? "normal", paused: false };
    } catch {
      return { priority: w.hint ?? "normal", paused: false };
    }
  }

  /**
   * The next waiter. Paused workers' requests are not eligible. Of the rest:
   * a low request waiting longer than lowAgingSec goes (once per that span),
   * else the highest priority level present is served, and inside it the
   * session-fair policy above (FIFO inside a session).
   */
  private pick(engineName: string): Waiter | undefined {
    const eng = this.engine(engineName);
    const cfg = this.cfg();
    const now = this.now();
    const cl = new Map(eng.waiting.map((w) => [w, this.ctl(w)] as const));
    if (this.orphanPause) {
      for (const w of eng.waiting) {
        if (!cl.get(w)!.paused) continue;
        try {
          if (this.orphanPause(w.worker)) cl.set(w, this.ctl(w));
        } catch {
          /* the net is best effort */
        }
      }
    }
    const elig = eng.waiting.filter((w) => !cl.get(w)!.paused);
    if (!elig.length) return undefined;
    const starved = elig.filter((w) => cl.get(w)!.priority === "low" && now - Math.max(w.at, eng.lastLowAt ?? 0) > cfg.lowAgingSec * 1000);
    if (starved.length) return starved.reduce((a, b) => (a.at <= b.at ? a : b));
    const level = LEVELS.find((l) => elig.some((w) => cl.get(w)!.priority === l))!;
    const cand = elig.filter((w) => cl.get(w)!.priority === level);
    const aged = cand.filter((w) => now - w.at > cfg.agingSec * 1000);
    if (aged.length) return aged.reduce((a, b) => (a.at <= b.at ? a : b));
    const ctr = this.ctr(engineName);
    const sessions = new Set(cand.map((w) => w.session));
    let best: string | undefined;
    let bestC = Infinity;
    let bestAt = Infinity;
    for (const s of sessions) {
      const c = ctr.get(s) ?? 0;
      const at = minOf(cand.filter((w) => w.session === s).map((w) => w.at));
      if (c < bestC || (c === bestC && at < bestAt)) {
        best = s;
        bestC = c;
        bestAt = at;
      }
    }
    const mine = cand.filter((w) => w.session === best).sort((a, b) => a.seq - b.seq);
    return mine.find((w) => this.isWarm(w.worker)) ?? mine[0];
  }

  private dispatch(engineName: string): void {
    const eng = this.engine(engineName);
    while (eng.flights.length < eng.slots) {
      const w = this.pick(engineName);
      if (!w) break;
      this.unqueue(w, engineName);
      const start = this.now();
      if (this.ctl(w).priority === "low") eng.lastLowAt = start;
      const waitedMs = start - w.at;
      const flight: Flight = { session: w.session, worker: w.worker, since: start, lastByte: start };
      eng.flights.push(flight);
      this.armReaper();
      const a = this.acct(w.worker, w.session, engineName);
      a.requests++;
      a.waitMsTotal += waitedMs;
      a.lastWaitMs = waitedMs;
      a.activeSince = start;
      const sa = w.interactive ? this.sessions.get(w.session) : undefined;
      if (sa) {
        sa.requests++;
        sa.waitMsTotal += waitedMs;
        sa.lastWaitMs = waitedMs;
        sa.inflight = true;
      }
      this.refreshWaiting(w.worker);
      let done = false;
      const ticket: Ticket = {
        waitedMs,
        engine: engineName,
        touch: () => {
          if (eng.flights.includes(flight)) {
            flight.lastByte = this.now();
            flight.gotByte = true;
          }
        },
        setPromptTokens: (n) => {
          if (eng.flights.includes(flight)) flight.promptTokens = n;
        },
        release: (served, opts) => {
          if (done) return;
          done = true;
          const end = this.now();
          eng.lastWorker = w.worker;
          const hook = opts?.gate ? this.idleHook : undefined;
          let parking: Promise<void> | undefined;
          let parkFlight: Flight | undefined;
          const at = eng.flights.indexOf(flight);
          if (hook && at >= 0) {
            // keep the engine held while the conversation is saved, then admit the next worker
            parking = hook(engineName, w.worker, eng.waiting.length).catch(() => undefined);
            parkFlight = { session: w.session, worker: w.worker, since: end, lastByte: end, parking: true };
            eng.flights[at] = parkFlight;
          } else if (at >= 0) eng.flights.splice(at, 1);
          a.activeSince = 0;
          a.lastServiceMs = end - start;
          a.serviceMsTotal += end - start;
          a.lastEnd = end;
          if (sa) {
            sa.inflight = false;
            sa.lastServiceMs = end - start;
            sa.serviceMsTotal += end - start;
            if (served) sa.tokens += Math.max(0, served.prefill) + Math.max(0, served.decode);
          }
          if (served) {
            const cfg = this.cfg();
            const weight = cfg.sessionWeights[w.session] ?? 1;
            const cost = (cfg.wTokIn * Math.max(0, served.prefill) + cfg.wTokOut * Math.max(0, served.decode)) / weight;
            const c = this.ctr(engineName);
            c.set(w.session, (c.get(w.session) ?? 0) + cost);
          }
          if (parking) {
            void parking.then(() => {
              const k = parkFlight ? eng.flights.indexOf(parkFlight) : -1;
              if (k >= 0) eng.flights.splice(k, 1);
              this.dispatch(engineName);
            });
          } else this.dispatch(engineName);
          this.changed();
        },
      };
      flight.release = () => ticket.release();
      flight.reap = () => ticket.onReap?.();
      w.grant(ticket);
    }
    // a parked (paused) worker is released by a status-file change, which nothing signals: look again shortly
    if (!this.recheck && eng.waiting.some((w) => this.ctl(w).paused)) {
      this.recheck = setTimeout(() => {
        this.recheck = undefined;
        this.dispatch(engineName);
      }, 1000);
      this.recheck.unref();
    }
    this.changed();
  }

  private changed(): void {
    try {
      this.onChange?.();
    } catch {
      /* mirroring is best effort */
    }
  }

  snapshot(): SchedSnapshot {
    const now = this.now();
    const engines: SchedSnapshot["engines"] = {};
    for (const [name, e] of this.engines) {
      const queued: Record<string, number> = {};
      for (const w of e.waiting.filter((x) => !x.engines || x.engines[0] === name)) queued[w.session] = (queued[w.session] ?? 0) + 1;
      engines[name] = {
        inflight: e.flights[0] ? { session: e.flights[0].session, worker: e.flights[0].worker, sinceMs: now - e.flights[0].since } : null,
        flights: e.flights.map((f) => ({ session: f.session, worker: f.worker, sinceMs: now - f.since })),
        slots: e.slots,
        queued,
        counters: Object.fromEntries([...(this.counters.get(name) ?? [])].map(([k, v]) => [k, Math.round(v)])),
      };
    }
    const workers: Record<string, WorkerAcct> = {};
    for (const [id, a] of this.workers) {
      const w = [...this.engines.values()].flatMap((e) => e.waiting).find((x) => x.worker === id);
      const c = w ? this.ctl(w) : this.control?.(id);
      workers[id] = c ? { ...a, priority: c.priority, paused: c.paused } : { ...a };
    }
    const sessions: Record<string, SessionAcct> = {};
    for (const [name, a] of this.sessions) {
      if (!a.inflight && now - a.lastRequest > SESSION_TTL_MS) this.sessions.delete(name);
      else sessions[name] = { ...a };
    }
    return { at: now, engines, workers, sessions };
  }
}

/** Prefill tokens the engine computed: the prompt minus what its cache served. */
export function newPrefill(u: { input_tokens: number; cache_read_input_tokens?: number }): number {
  return Math.max(0, u.input_tokens - (u.cache_read_input_tokens ?? 0));
}

// ---------------------------------------------------------------------------
// process singleton + disk mirror

let shared: RequestScheduler | null = null;
let schedCfg: () => SchedConfig = () => DEFAULT_SCHED;

export function sharedScheduler(): RequestScheduler {
  if (!shared) shared = new RequestScheduler(() => schedCfg());
  return shared;
}

export function setSchedConfigSource(src: () => SchedConfig): void {
  schedCfg = src;
}

/** Fail open: an unreadable scheduler config reads as "off" and the router forwards directly. */
export function schedEnabled(): boolean {
  try {
    return schedCfg().enabled;
  } catch {
    return false;
  }
}

/** Mirror the snapshot to <dir>/router-sched.json at most once a second. */
export function mirrorTo(s: RequestScheduler, dir: () => string): void {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  const write = () => {
    timer = undefined;
    last = Date.now();
    try {
      const p = join(dir(), SCHED_FILE);
      writeFileSync(p + ".tmp", JSON.stringify(s.snapshot()));
      renameSync(p + ".tmp", p);
    } catch {
      /* best effort */
    }
  };
  s.onChange = () => {
    if (timer) return;
    const wait = Math.max(0, 1000 - (Date.now() - last));
    timer = setTimeout(write, wait);
    timer.unref();
  };
}

/** The router's snapshot as `pai worker ps` / the worker scheduler read it; null when absent or stale (>2 min). */
export function readSchedFile(dir: string, now = Date.now()): SchedSnapshot | null {
  try {
    const p = join(dir, SCHED_FILE);
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, "utf8")) as SchedSnapshot;
    // an idle router stops writing; a snapshot with nothing queued or active stays valid
    const busy = Object.values(s.engines).some((e) => e.inflight || Object.keys(e.queued).length);
    return busy && now - s.at > 120_000 ? null : s;
  } catch {
    return null;
  }
}

/** The instance of a provider serving a request, from the router's engine key: "signal-2 #1" / "signal-2 #2" when the provider runs several
 *  copies (the first copy's key is the bare provider name), the plain key when it runs one. */
export function instanceLabel(engine: string, snap: SchedSnapshot | null): string {
  const base = engine.replace(/#\d+$/, "");
  const n = /#(\d+)$/.exec(engine)?.[1] ?? "1";
  const copies = Object.keys(snap?.engines ?? {}).filter((k) => k.replace(/#\d+$/, "") === base).length;
  return copies > 1 || n !== "1" ? `${base} #${n}` : engine;
}

/** `ps` / cockpit line: "scheduler: gyro-m running (sess-a) · queued sess-b 2 · counters sess-a 1200, sess-b 300"; "" when idle.
 *  names: session id → display name — a known session reads by name, an unknown one by its first 8 chars, never a raw uuid. */
export function schedLine(s: SchedSnapshot | null, names?: Record<string, string>): string {
  if (!s) return "";
  const label = (sid: string): string => names?.[sid] ?? sid.slice(0, 8);
  // copies of one model (`gyro-m`, `gyro-m#2`) read as one engine: `gyro-m x2`
  const groups = new Map<string, Array<SchedSnapshot["engines"][string]>>();
  const active = new Set<string>();
  for (const [name, e] of Object.entries(s.engines)) if (e.inflight || Object.keys(e.queued).length) active.add(name.replace(/#\d+$/, ""));
  const perInstance = new Map<string, string[]>();
  for (const [name, e] of Object.entries(s.engines)) {
    const base = name.replace(/#\d+$/, "");
    if (!active.has(base)) continue;
    groups.set(base, [...(groups.get(base) ?? []), e]);
    perInstance.set(base, [...(perInstance.get(base) ?? []), `#${/#(\d+)$/.exec(name)?.[1] ?? "1"} ${e.flights?.length ?? (e.inflight ? 1 : 0)}/${e.slots ?? 1}`]);
  }
  const parts: string[] = [];
  for (const [base, es] of groups) {
    const inflight = es.flatMap((e) => (e.flights ?? (e.inflight ? [e.inflight] : [])).map((f) => label(f.session)));
    const busy = es.reduce((n, e) => n + (e.flights?.length ?? (e.inflight ? 1 : 0)), 0);
    const cap = es.reduce((n, e) => n + (e.slots ?? 1), 0);
    const queued: Record<string, number> = {};
    const counters: Record<string, number> = {};
    for (const e of es) {
      for (const [k, n] of Object.entries(e.queued)) queued[k] = (queued[k] ?? 0) + n;
      for (const [k, n] of Object.entries(e.counters)) counters[k] = (counters[k] ?? 0) + n;
    }
    const q = Object.entries(queued);
    const c = Object.entries(counters).map(([k, v]) => `${label(k)} ${v} tokens served`);
    parts.push(
      `${base}${es.length > 1 ? ` x${es.length}` : ""} ${inflight.length ? `in flight ${busy}/${cap} (${inflight.join(", ")})` : "idle"}${es.length > 1 ? ` [${perInstance.get(base)!.join(" · ")}]` : ""}` +
        (q.length ? `, queued ${q.map(([k, n]) => `${label(k)} ${n}`).join(" ")}` : "") +
        (c.length ? `, ${c.join(", ")}` : "")
    );
  }
  return parts.length ? `local scheduler: ${parts.join(" · ")}` : "";
}

/** compact count: 10838 -> "10.8k", 950 -> "950" */
function compactCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

/** Cockpit line in plain words: "local engine gyro-m: 1 request in flight, 1 queued; served 10.8k tokens this window".
 *  No session ids in the line; the per-session detail (name if known, else "session <8 chars>") is the title. */
export function schedPlain(s: SchedSnapshot | null, names?: Record<string, string>): { text: string; title: string } {
  if (!s) return { text: "", title: "" };
  const label = (sid: string): string => names?.[sid] ?? `session ${sid.slice(0, 8)}`;
  const lines: string[] = [];
  const titles: string[] = [];
  for (const [name, e] of Object.entries(s.engines)) {
    const q = Object.entries(e.queued);
    if (!e.inflight && !q.length) continue;
    const queued = q.reduce((a, [, n]) => a + n, 0);
    const served = Object.values(e.counters).reduce((a, v) => a + v, 0);
    lines.push(
      `local engine ${name}: ${e.inflight ? "1 request in flight" : "idle"}, ${queued} queued` +
        (served ? `; served ${compactCount(served)} tokens this window` : "")
    );
    if (e.inflight) titles.push(`${name} in flight: ${label(e.inflight.session)}`);
    if (q.length) titles.push(`${name} queued: ${q.map(([k, n]) => `${label(k)} ${n}`).join(", ")}`);
    const c = Object.entries(e.counters);
    if (c.length) titles.push(`${name} served: ${c.map(([k, v]) => `${label(k)} ${v} tokens`).join(", ")}`);
  }
  return { text: lines.join(" · "), title: titles.join("\n") };
}
