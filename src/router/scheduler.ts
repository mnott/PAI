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
 *
 * Accounting per request (queue wait, service time) is kept per worker
 * (x-pai-worker) and published through snapshot(): the router serves it at
 * /cockpit/scheduler and mirrors it to <workers log dir>/router-sched.json for
 * `pai worker ps` and the worker scheduler (readSchedFile).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
}

/**
 * The fallback used when the config cannot be read (fail-open paths). The
 * policy values themselves live in the shipped defaults file
 * (src/config/defaults/config.yaml, `router.scheduling`) and reach the
 * scheduler through `loadConfig().router.scheduling` → `schedConfigFrom`.
 */
export const DEFAULT_SCHED: SchedConfig = { enabled: true, wTokIn: 1, wTokOut: 2, agingSec: 120, sessionWeights: {}, warmMs: 300_000, pingMs: 15_000 };

export const SCHED_FILE = "router-sched.json";

/** Merge a raw `router.scheduling` config block over the defaults; bad values fall back. */
export function schedConfigFrom(raw: unknown): SchedConfig {
  const out: SchedConfig = { ...DEFAULT_SCHED, sessionWeights: {} };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  for (const k of ["wTokIn", "wTokOut", "agingSec", "warmMs", "pingMs"] as const) {
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
  /** Free the engine. Idempotent; the first call's `served` is what the session is charged. */
  release(served?: Served, opts?: ReleaseOpts): void;
}

export interface ReleaseOpts {
  /** the response just ended in a build-gate call: the worker will idle a while (parking candidate) */
  gate?: boolean;
}

/** Runs while the engine is still held after a gate-bound response; the engine frees when it settles. */
export type IdleHook = (engine: string, worker: string, waiting: number) => Promise<void>;

interface Waiter {
  seq: number;
  session: string;
  worker: string;
  at: number;
  grant: (t: Ticket) => void;
  fail: (e: Error) => void;
}

interface Flight {
  session: string;
  worker: string;
  since: number;
}

interface Engine {
  inflight: Flight | null;
  /** worker whose conversation the engine holds (its last response) */
  lastWorker?: string;
  waiting: Waiter[];
}

export interface WorkerAcct {
  requests: number;
  waitMsTotal: number;
  lastWaitMs: number;
  serviceMsTotal: number;
  lastServiceMs: number;
  /** epoch ms the worker's oldest queued request began waiting, 0 when none queued */
  waitingSince: number;
  /** epoch ms the worker's request in flight began, 0 when none */
  activeSince: number;
  lastEnd: number;
  session: string;
  engine: string;
}

export interface SchedSnapshot {
  at: number;
  engines: Record<string, { inflight: { session: string; worker: string; sinceMs: number } | null; queued: Record<string, number>; counters: Record<string, number> }>;
  workers: Record<string, WorkerAcct>;
}

export class RequestScheduler {
  private engines = new Map<string, Engine>();
  private counters = new Map<string, Map<string, number>>();
  private workers = new Map<string, WorkerAcct>();
  private seq = 0;
  /** called after any state change (the router mirrors the snapshot to disk) */
  onChange?: () => void;
  /** parking: see parking.ts */
  idleHook?: IdleHook;

  constructor(private cfg: () => SchedConfig = () => DEFAULT_SCHED, private now: () => number = Date.now) {}

  private engine(name: string): Engine {
    let e = this.engines.get(name);
    if (!e) this.engines.set(name, (e = { inflight: null, waiting: [] }));
    return e;
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
  acquire(engineName: string, session: string, worker: string, signal?: { onAbort(cb: () => void): void }): Promise<Ticket> {
    const eng = this.engine(engineName);
    const now = this.now();
    const ctr = this.ctr(engineName);
    // re-backlog lift: a session with nothing queued or running starts level with the backlogged ones
    const backlogged = new Set<string>(eng.waiting.map((w) => w.session));
    if (eng.inflight) backlogged.add(eng.inflight.session);
    if (!backlogged.has(session)) {
      const others = [...backlogged].map((s) => ctr.get(s) ?? 0);
      const floor = others.length ? Math.min(...others) : 0;
      ctr.set(session, Math.max(ctr.get(session) ?? 0, floor));
    } else if (!ctr.has(session)) ctr.set(session, 0);
    const acct = this.acct(worker, session, engineName);
    return new Promise<Ticket>((resolve, reject) => {
      const w: Waiter = { seq: ++this.seq, session, worker, at: now, grant: resolve, fail: reject };
      eng.waiting.push(w);
      if (!acct.waitingSince) acct.waitingSince = now;
      signal?.onAbort(() => {
        const i = eng.waiting.indexOf(w);
        if (i < 0) return;
        eng.waiting.splice(i, 1);
        this.refreshWaiting(worker);
        w.fail(new Error("cancelled while queued"));
        this.changed();
      });
      this.dispatch(engineName);
    });
  }

  private refreshWaiting(worker: string): void {
    const a = this.workers.get(worker);
    if (!a) return;
    let oldest = 0;
    for (const e of this.engines.values()) for (const w of e.waiting) if (w.worker === worker && (!oldest || w.at < oldest)) oldest = w.at;
    a.waitingSince = oldest;
  }

  /** The next waiter by the policy above; exported through dispatch only. */
  private pick(engineName: string): Waiter | undefined {
    const eng = this.engine(engineName);
    if (!eng.waiting.length) return undefined;
    const cfg = this.cfg();
    const now = this.now();
    const aged = eng.waiting.filter((w) => now - w.at > cfg.agingSec * 1000);
    if (aged.length) return aged.reduce((a, b) => (a.at <= b.at ? a : b));
    const ctr = this.ctr(engineName);
    const sessions = new Set(eng.waiting.map((w) => w.session));
    let best: string | undefined;
    let bestC = Infinity;
    let bestAt = Infinity;
    for (const s of sessions) {
      const c = ctr.get(s) ?? 0;
      const at = Math.min(...eng.waiting.filter((w) => w.session === s).map((w) => w.at));
      if (c < bestC || (c === bestC && at < bestAt)) {
        best = s;
        bestC = c;
        bestAt = at;
      }
    }
    const mine = eng.waiting.filter((w) => w.session === best).sort((a, b) => a.seq - b.seq);
    return mine.find((w) => this.isWarm(w.worker)) ?? mine[0];
  }

  private dispatch(engineName: string): void {
    const eng = this.engine(engineName);
    while (!eng.inflight) {
      const w = this.pick(engineName);
      if (!w) break;
      eng.waiting.splice(eng.waiting.indexOf(w), 1);
      const start = this.now();
      const waitedMs = start - w.at;
      eng.inflight = { session: w.session, worker: w.worker, since: start };
      const a = this.acct(w.worker, w.session, engineName);
      a.requests++;
      a.waitMsTotal += waitedMs;
      a.lastWaitMs = waitedMs;
      a.activeSince = start;
      this.refreshWaiting(w.worker);
      let done = false;
      const flight = eng.inflight;
      w.grant({
        waitedMs,
        release: (served, opts) => {
          if (done) return;
          done = true;
          const end = this.now();
          eng.lastWorker = w.worker;
          const hook = opts?.gate ? this.idleHook : undefined;
          let parking: Promise<void> | undefined;
          if (hook && eng.inflight === flight) {
            // keep the engine held while the conversation is saved, then admit the next worker
            parking = hook(engineName, w.worker, eng.waiting.length).catch(() => undefined);
            eng.inflight = { session: w.session, worker: w.worker, since: end };
          } else if (eng.inflight === flight) eng.inflight = null;
          const parkFlight = eng.inflight;
          a.activeSince = 0;
          a.lastServiceMs = end - start;
          a.serviceMsTotal += end - start;
          a.lastEnd = end;
          if (served) {
            const cfg = this.cfg();
            const weight = cfg.sessionWeights[w.session] ?? 1;
            const cost = (cfg.wTokIn * Math.max(0, served.prefill) + cfg.wTokOut * Math.max(0, served.decode)) / weight;
            const c = this.ctr(engineName);
            c.set(w.session, (c.get(w.session) ?? 0) + cost);
          }
          if (parking) {
            void parking.then(() => {
              if (eng.inflight === parkFlight) eng.inflight = null;
              this.dispatch(engineName);
            });
          } else this.dispatch(engineName);
          this.changed();
        },
      });
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
      for (const w of e.waiting) queued[w.session] = (queued[w.session] ?? 0) + 1;
      engines[name] = {
        inflight: e.inflight ? { session: e.inflight.session, worker: e.inflight.worker, sinceMs: now - e.inflight.since } : null,
        queued,
        counters: Object.fromEntries([...(this.counters.get(name) ?? [])].map(([k, v]) => [k, Math.round(v)])),
      };
    }
    return { at: now, engines, workers: Object.fromEntries(this.workers) };
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

/** `ps` / cockpit line: "scheduler: gyro-m running (sess-a) · queued sess-b 2 · counters sess-a 1200, sess-b 300"; "" when idle.
 *  names: session id → display name — a known session reads by name, an unknown one by its first 8 chars, never a raw uuid. */
export function schedLine(s: SchedSnapshot | null, names?: Record<string, string>): string {
  if (!s) return "";
  const label = (sid: string): string => names?.[sid] ?? sid.slice(0, 8);
  // copies of one model (`gyro-m`, `gyro-m#2`) read as one engine: `gyro-m x2`
  const groups = new Map<string, Array<SchedSnapshot["engines"][string]>>();
  for (const [name, e] of Object.entries(s.engines)) {
    if (!e.inflight && !Object.keys(e.queued).length) continue;
    const base = name.replace(/#\d+$/, "");
    groups.set(base, [...(groups.get(base) ?? []), e]);
  }
  const parts: string[] = [];
  for (const [base, es] of groups) {
    const inflight = es.filter((e) => e.inflight).map((e) => label(e.inflight!.session));
    const queued: Record<string, number> = {};
    const counters: Record<string, number> = {};
    for (const e of es) {
      for (const [k, n] of Object.entries(e.queued)) queued[k] = (queued[k] ?? 0) + n;
      for (const [k, n] of Object.entries(e.counters)) counters[k] = (counters[k] ?? 0) + n;
    }
    const q = Object.entries(queued);
    const c = Object.entries(counters).map(([k, v]) => `${label(k)} ${v} tokens served`);
    parts.push(
      `${base}${es.length > 1 ? ` x${es.length}` : ""} ${inflight.length ? `in flight (${inflight.join(", ")})` : "idle"}` +
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
