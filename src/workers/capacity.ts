/**
 * Capacity gate: a provider can only serve so many runs at once (a local
 * vllm-mlx server with --max-num-seqs 3 queues the rest inside the server,
 * where nobody sees it). Runs beyond `maxConcurrent` wait here instead, in
 * FIFO order, with a status line saying why. Queue = one file per waiting run
 * (name = run id, content = pid) in <logDir>/queue/<provider>/; entries whose
 * pid is gone are dropped. The waiting state is "queued" (status.ts): the
 * gate writes it through onWait while held, and the caller flips it back to
 * "running" (and rewrites `started`) once the slot is granted.
 *
 * Grant order is FIFO by id unless a pull-forward file
 * (<logDir>/queue/<provider>.order, written atomically by `pai worker queue
 * front|up`, the cockpit or the MCP tool) puts named ids first: the file
 * lists ids in grant order, live entries not in it keep their id order at the
 * back. Every waiting loop re-reads it with each poll, so a move takes effect
 * on the next check. Running workers are never interrupted — only the order
 * of the waiting ones changes.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backoffMs } from "./stagger.js";
import { isLocalProvider } from "./config.js";
import { alive, isLive, loadStatus, loadStatuses, ownsPid, reconcileStatuses, type WorkerStatus } from "./status.js";

export interface CapacityConfig {
  enabled: boolean;
}


/**
 * Loopback default. The server exposes no capacity: GET /v1/models, /health
 * and /v1/cache/stats on a vllm-mlx server report model names and cache
 * counters only, not max-num-seqs.
 */
export const LOCAL_DEFAULT_CAP = 1;

/** Cap shown/used by queue and plan runners for a provider with no cap at all (cloud, unset). */
export const UNCAPPED_QUEUE_CAP = 3;

/**
 * Provider cap, the model's default concurrency: explicit `maxConcurrent`
 * (N for a parallel-capable server), else LOCAL_DEFAULT_CAP for loopback (one
 * local engine serves one request at a time), else unlimited (undefined).
 */
export function resolveCap(maxConcurrent: number | undefined, local: boolean): number | undefined {
  return maxConcurrent ?? (local ? LOCAL_DEFAULT_CAP : undefined);
}

/** admitCap (the one admission rule, conversationSlots included) with a number always: unlimited becomes UNCAPPED_QUEUE_CAP (queue/plan runners). */
export function effectiveCap(maxConcurrent: number | undefined, local: boolean, conversationSlots?: number): number {
  return admitCap(maxConcurrent, conversationSlots, local) ?? UNCAPPED_QUEUE_CAP;
}

/**
 * Admission cap: the provider cap, held below the engine's conversation-cache
 * slots (one spare, never under 1) when `conversationSlots` is configured —
 * admitting more makes the cached conversations evict each other every turn.
 * Unset: the provider cap alone (conversationSlots defaults to it).
 */
export function admitCap(maxConcurrent: number | undefined, conversationSlots: number | undefined, local: boolean): number | undefined {
  const cap = resolveCap(maxConcurrent, local);
  if (conversationSlots === undefined) return cap;
  const limit = Math.max(1, conversationSlots - 1);
  return cap === undefined ? limit : Math.min(cap, limit);
}

/** Cap of a named provider from the config, the same rule the gate applies. */
export function providerCap(config: { providers: Record<string, { maxConcurrent?: number; conversationSlots?: number; baseUrl: string }> }, provider: string): number | undefined {
  const p = config.providers[provider];
  if (!p) return undefined;
  return admitCap(p.maxConcurrent, p.conversationSlots, isLocalProvider(p.baseUrl));
}

/** A run queued this long raises the max-total-wait alarm (notifies the owner, never kills). */
export const MAX_TOTAL_WAIT_MS = 2 * 3_600_000;

/** Longest silence of the log while queued. */
export const HEARTBEAT_MS = 60_000;

/** Queue key of a session's `max_parallel` gate (a provider name never contains "~"). */
export const sessionScopeKey = (name: string): string => `session~${name}`;

const queueDir = (logDir: string, provider: string) => join(logDir, "queue", provider.replace(/[^\w.~-]/g, "_"));

interface QueueEntry {
  id: string;
  pid: number;
  front: boolean;
  /** Explicit position (moveUp), within the entry's group; unset = after the ranked ones, by name. */
  rank?: number;
  /** Epoch ms the run started waiting; written once at enqueue, kept across every reorder. */
  since?: number;
}

const entryText = (e: QueueEntry): string =>
  `${e.pid}${e.front ? " front" : ""}${e.rank === undefined ? "" : ` ${e.rank}`}${e.since === undefined ? "" : ` @${e.since}`}`;

function readEntry(dir: string, id: string): QueueEntry {
  const [p, ...marks] = readFileSync(join(dir, id), "utf8").trim().split(/\s+/);
  const rank = marks.map(Number).find((n) => Number.isInteger(n));
  const at = marks.find((m) => m.startsWith("@"));
  const since = at ? Number(at.slice(1)) : NaN;
  return {
    id,
    pid: Number(p),
    front: marks.includes("front"),
    ...(rank === undefined ? {} : { rank }),
    ...(Number.isFinite(since) ? { since } : {}),
  };
}

/** A ticket waiting longer than this jumps ahead of newer tickets of any session. */
export const AGING_MS = 15 * 60_000;

/** The owning session of a worker (ownership checks: spawner, then host session), else its session-profile name, else one shared anonymous bucket. */
export function sessionOf(s: Pick<WorkerStatus, "spawnerSession" | "session" | "sessionKey"> | undefined | null): string {
  return s?.spawnerSession || s?.session?.id || s?.sessionKey || "~anonymous";
}

export interface FairInput {
  /** Waiting tickets in their own order (front, rank, id): the order a session keeps for itself. */
  entries: QueueEntry[];
  sessionOf: (id: string) => string;
  /** Sessions of the workers currently holding a slot (one item per worker). */
  running: string[];
  /** Epoch ms of each session's most recent slot grant on this provider (finished runs included): the tie-break that keeps turns going round. */
  lastServed?: ReadonlyMap<string, number>;
  now: number;
  agingMs?: number;
}

/**
 * Grant order of a provider's waiting tickets: `--now` (front) tickets first,
 * then tickets waiting longer than the aging bound (oldest first), then fair
 * share — the next slot goes to the session with the fewest slots (running +
 * already ordered ahead), ties to the session served least recently, then to
 * the one whose head waited longest, so
 * sessions take turns regardless of how many tickets each queued. A session's
 * own tickets keep their order (pull-forward via front/up/next).
 */
export function fairOrder(i: FairInput): QueueEntry[] {
  const aging = i.agingMs ?? AGING_MS;
  const since = (e: QueueEntry): number => e.since ?? i.now;
  const front = i.entries.filter((e) => e.front);
  const rest = i.entries.filter((e) => !e.front);
  const aged = rest.filter((e) => i.now - since(e) > aging).sort((a, b) => since(a) - since(b));
  const agedIds = new Set(aged.map((e) => e.id));
  const per = new Map<string, QueueEntry[]>();
  for (const e of rest) {
    if (agedIds.has(e.id)) continue;
    const k = i.sessionOf(e.id);
    per.set(k, [...(per.get(k) ?? []), e]);
  }
  const load = new Map<string, number>();
  for (const k of i.running) load.set(k, (load.get(k) ?? 0) + 1);
  for (const e of [...front, ...aged]) load.set(i.sessionOf(e.id), (load.get(i.sessionOf(e.id)) ?? 0) + 1);
  const out: QueueEntry[] = [...front, ...aged];
  while (per.size) {
    let best = "";
    for (const [k, q] of per) {
      if (!best) best = k;
      else {
        const [lb, lk] = [load.get(best) ?? 0, load.get(k) ?? 0];
        const [sb, sk] = [i.lastServed?.get(best) ?? 0, i.lastServed?.get(k) ?? 0];
        if (lk < lb || (lk === lb && (sk < sb || (sk === sb && since(q[0]) < since(per.get(best)![0]))))) best = k;
      }
    }
    const q = per.get(best)!;
    out.push(q.shift()!);
    load.set(best, (load.get(best) ?? 0) + 1);
    if (!q.length) per.delete(best);
  }
  return out;
}

function lastServed(all: WorkerStatus[], provider: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of all) {
    if (s.provider !== provider || s.state === "queued") continue;
    const t = Date.parse((s.started ?? "").replace(" ", "T"));
    if (Number.isFinite(t)) out.set(sessionOf(s), Math.max(out.get(sessionOf(s)) ?? 0, t));
  }
  return out;
}

/** liveEntries, then fair share across sessions (provider queues only; a session's own max_parallel queue stays as is). */
function fairEntries(logDir: string, key: string, isAlive: (pid: number) => boolean, statuses?: WorkerStatus[], now: number = Date.now()): QueueEntry[] {
  const entries = liveEntries(logDir, key, isAlive);
  if (key.startsWith("session~")) return entries;
  const all = statuses ?? loadStatuses(logDir);
  const byId = new Map(all.map((s) => [s.id, s]));
  return fairOrder({
    entries,
    sessionOf: (id) => sessionOf(byId.get(id)),
    running: all.filter((s) => s.provider === key && s.state === "running").map(sessionOf),
    lastServed: lastServed(all, key),
    now,
  });
}

/** Live entries in waiting order: "front" runs first, then by rank, then oldest (by name); dead entries are removed. */
function liveEntries(logDir: string, provider: string, isAlive: (pid: number) => boolean): QueueEntry[] {
  const dir = queueDir(logDir, provider);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => !n.endsWith(".tmp"));
  } catch {
    return [];
  }
  const out: QueueEntry[] = [];
  for (const id of names.sort()) {
    const e = readEntry(dir, id);
    if (Number.isInteger(e.pid) && e.pid > 0 && isAlive(e.pid)) out.push(e);
    else rmSync(join(dir, id), { force: true });
  }
  const group = (e: QueueEntry) => (e.front ? 0 : 1);
  // stable sort: ties keep the by-name order
  return out.sort((a, b) => group(a) - group(b) || (a.rank ?? Infinity) - (b.rank ?? Infinity));
}

/**
 * Live queue entries of a provider in waiting order (see liveEntries). An
 * entry file holds "<pid>", "<pid> front" and, after moveUp, "<pid> [front] <rank>".
 * This is the single ordering mechanism: `--now`, `pai worker queue front|up`
 * and the cockpit queue panel all go through capacityGate's priority, setFront
 * and moveUp.
 */
export function liveQueue(logDir: string, provider: string, isAlive: (pid: number) => boolean = alive, statuses?: WorkerStatus[], now?: number): string[] {
  return fairEntries(logDir, provider, isAlive, statuses, now).map((e) => e.id);
}

/** Put a waiting run ahead of the provider's non-front runs ("front"). False when it is not waiting. */
export function setFront(logDir: string, provider: string, id: string, isAlive: (pid: number) => boolean = alive): boolean {
  const e = liveEntries(logDir, provider, isAlive).find((x) => x.id === id);
  if (!e) return false;
  if (!e.front) writeFileSync(join(queueDir(logDir, provider), id), entryText({ ...e, front: true, rank: undefined }));
  return true;
}

/** Move a waiting run one place up. False when it is not waiting or already first. */
export function moveUp(logDir: string, provider: string, id: string, isAlive: (pid: number) => boolean = alive): boolean {
  const order = liveEntries(logDir, provider, isAlive);
  const i = order.findIndex((x) => x.id === id);
  if (i <= 0) return false;
  // the run takes the place (and group) of the one it passes
  [order[i - 1], order[i]] = [{ ...order[i], front: order[i - 1].front }, order[i - 1]];
  order.forEach((e, rank) => writeFileSync(join(queueDir(logDir, provider), e.id), entryText({ ...e, rank })));
  return true;
}

/**
 * Move a waiting run to a 1-based `position` in one step (drag and drop). The run
 * takes the group (front or not) of the neighbour it lands next to, so the
 * order stays one list. False when it is not waiting.
 */
export function moveTo(logDir: string, provider: string, id: string, position: number, isAlive: (pid: number) => boolean = alive): boolean {
  const order = liveEntries(logDir, provider, isAlive);
  const from = order.findIndex((x) => x.id === id);
  if (from < 0) return false;
  const [e] = order.splice(from, 1);
  const to = Math.max(0, Math.min(order.length, Math.floor(position) - 1));
  const near = order[to - 1] ?? order[to];
  order.splice(to, 0, { ...e, front: near ? near.front : e.front });
  order.forEach((x, rank) => writeFileSync(join(queueDir(logDir, provider), x.id), entryText({ ...x, rank })));
  return true;
}

/**
 * setFront / moveUp for callers that report the result (CLI, cockpit, MCP):
 * returns the new waiting order; throws when `id` is not waiting on the provider.
 */
export function reorderQueue(logDir: string, provider: string, id: string, how: "front" | "up"): string[] {
  if (!liveQueue(logDir, provider).includes(id)) throw new Error(`worker ${id} is not queued on provider ${provider}`);
  if (how === "front") setFront(logDir, provider, id);
  else moveUp(logDir, provider, id);
  return liveQueue(logDir, provider);
}

/** moveTo for callers that report the result: the new waiting order; throws when `id` is not waiting. */
export function reorderQueueTo(logDir: string, provider: string, id: string, position: number): string[] {
  if (!liveQueue(logDir, provider).includes(id)) throw new Error(`worker ${id} is not queued on provider ${provider}`);
  moveTo(logDir, provider, id, position);
  return liveQueue(logDir, provider);
}

export interface QueueRow {
  id: string;
  provider: string;
  /** 1 = next in line. */
  position: number;
  /** Waiting runs on this provider (M). */
  queued: number;
  /** Provider cap (C); undefined = unlimited. */
  cap?: number;
  /** Status of the waiting run, when its file is readable. */
  status?: WorkerStatus;
  /** Epoch ms the run started waiting (not the last reorder); undefined for an entry written before this field existed. */
  since?: number;
}

/**
 * The waiting workers of every provider, in grant order — the one queue
 * reader behind `pai worker ps`' QUEUED section, /cockpit/queue and the MCP
 * worker_queue list. Dead entries are dropped; a provider with no cap (or a
 * cap the config no longer names) still lists its waiters, cap undefined.
 */
export function queueRows(logDir: string, caps: Record<string, number | undefined> = {}, isAlive: (pid: number) => boolean = alive): QueueRow[] {
  let providers: string[];
  try {
    providers = readdirSync(join(logDir, "queue")).sort();
  } catch {
    return [];
  }
  const rows: QueueRow[] = [];
  for (const prov of providers) {
    const queue = fairEntries(logDir, prov, isAlive);
    queue.forEach((e, i) => {
      rows.push({
        id: e.id,
        provider: prov,
        position: i + 1,
        queued: queue.length,
        cap: caps[prov],
        status: loadStatus(logDir, e.id) ?? undefined,
        ...(e.since === undefined ? {} : { since: e.since }),
      });
    });
  }
  return rows;
}

export interface CapacityInfo {
  provider: string;
  cap: number;
  /** Runs on the provider: those holding a slot plus those queued. */
  total: number;
  /** 1 = next in line. */
  position: number;
  elapsedSec: number;
  line: string;
  /** Waiting runs on the queue (M of "position N of M"). */
  queued: number;
  /** Label of a run holding a slot, when one is known. */
  behind?: string;
  /** Epoch ms this run started waiting. */
  sinceMs: number;
}

/** The pane / footer line of a waiting run: "queued on p: position 2 of 3, behind <label> — waiting since 18:12". */
export function queuedText(q: { provider: string; position: number; queued: number; behind?: string; sinceMs: number }): string {
  const d = new Date(q.sinceMs);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `queued on ${q.provider}: position ${q.position} of ${q.queued}${q.behind ? `, behind ${q.behind}` : ""} — waiting since ${hhmm}`;
}

export interface CapacityOpts {
  logDir: string;
  self: { id: string; provider: string; pid?: number };
  /**
   * Gate on something other than the provider: a session's `max_parallel`.
   * `key` names the queue (<logDir>/queue/<key>), `label` the status line,
   * `holds` picks the running runs that count against the cap.
   */
  scope?: { key: string; label: string; holds: (s: WorkerStatus) => boolean };
  /** Resolved cap; undefined = unlimited. */
  cap: number | undefined;
  config: CapacityConfig;
  disabled?: boolean;
  /** "front": wait ahead of the provider's other queued runs (--now). */
  priority?: "front";
  log?: (line: string) => void;
  /** Waited this long (default 2 h): call onAlarm once. The alarm only tells the owner; it never kills or skips the run. */
  alarmMs?: number;
  onAlarm?: (info: CapacityInfo) => void;
  /** Called at the start and after every poll while queued; null once the slot is granted (the caller flips queued -> running then). */
  onWait?: (info: CapacityInfo | null) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  load?: (logDir: string) => WorkerStatus[];
  isAlive?: (pid: number) => boolean;
}

export interface CapacityResult {
  waitedSec: number;
  cap: number;
}

/** Resolves once fewer than `cap` other runs hold a slot on the provider and this run heads the queue; null when it never had to wait. */
export async function capacityGate(o: CapacityOpts): Promise<CapacityResult | null> {
  if (o.disabled || !o.config.enabled || o.cap === undefined || o.cap <= 0) return null;
  const { logDir, self, cap } = o;
  const load = o.load ?? ((dir: string) => (reconcileStatuses(dir, new Date(), 0), loadStatuses(dir)));
  const now = o.now ?? Date.now;
  const isAlive = o.isAlive ?? alive;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const queueKey = o.scope?.key ?? self.provider;
  const label = o.scope?.label ?? self.provider;
  const holds = o.scope?.holds ?? ((s: WorkerStatus) => s.provider === self.provider);
  const dir = queueDir(logDir, queueKey);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, self.id);
  const t0 = now();
  writeFileSync(entry, `${self.pid ?? process.pid}${o.priority === "front" ? " front" : ""} @${t0}`);

  // Runs holding a slot: live and running on this provider — a "queued" status
  // is a waiter, never a holder, whatever its queue entry says.
  const check = () => {
    const loaded = load(logDir);
    const queue = liveQueue(logDir, queueKey, isAlive, loaded, now());
    const owns = o.isAlive ? (w: { pid: number }) => isAlive(w.pid) : ownsPid;
    const holders = loaded.filter(
      (s) => s.id !== self.id && holds(s) && s.state === "running" && isLive(s, owns),
    );
    const position = queue.indexOf(self.id) + 1;
    return { holding: holders.length, behind: holders[0]?.label, position: position || queue.length + 1, queued: queue.length };
  };

  let c = check();
  if (c.position === 1 && c.holding < cap) {
    rmSync(entry, { force: true });
    return null;
  }
  const info = (): CapacityInfo => {
    const total = c.holding + c.queued;
    return {
      provider: label,
      cap,
      total,
      position: c.position,
      elapsedSec: Math.floor((now() - t0) / 1000),
      queued: c.queued,
      ...(c.behind ? { behind: c.behind } : {}),
      sinceMs: t0,
      line: `queued: ${total} on ${label}, cap ${cap} (position ${c.position})`,
    };
  };
  o.log?.(info().line);
  let lastBeat = t0;
  let alarmed = false;
  try {
    o.onWait?.(info());
    for (let n = 0; ; n++) {
      await sleep(backoffMs(n));
      c = check();
      if (c.position === 1 && c.holding < cap) break;
      o.onWait?.(info());
      if (!alarmed && o.onAlarm && now() - t0 >= (o.alarmMs ?? MAX_TOTAL_WAIT_MS)) {
        alarmed = true;
        o.onAlarm(info());
      }
      // a quiet log looks hung to wait-on's stall rule
      if (now() - lastBeat >= HEARTBEAT_MS) {
        lastBeat = now();
        o.log?.(`queued: still waiting, position ${c.position}, ${info().elapsedSec}s`);
      }
    }
  } finally {
    rmSync(entry, { force: true });
  }
  const waitedSec = Math.round((now() - t0) / 100) / 10;
  // The slot is ours: the caller flips the status back to "running" (and
  // rewrites `started`) before we report the release.
  o.onWait?.(null);
  o.log?.(`waited ${waitedSec}s for a ${label} slot`);
  return { waitedSec, cap };
}
