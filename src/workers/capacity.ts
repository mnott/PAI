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
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backoffMs } from "./stagger.js";
import { isLocalProvider, QUEUE_PRIORITIES, type CapacityConfig, type QueuePriority } from "./config.js";
import { fmtElapsed } from "./waiting.js";
import { alive, isLive, loadStatus, loadStatuses, ownsPid, reconcileStatuses, type WorkerStatus } from "./status.js";

export type { CapacityConfig, QueuePriority };

/**
 * The fallback used when the config cannot be read; the policy values live in
 * the shipped defaults file (defaults/workers.yaml, `workers.capacity`).
 */
export const DEFAULT_CAPACITY: CapacityConfig = { enabled: true, localDefaultCap: 1, uncappedQueueCap: 3, maxTotalWaitMs: 2 * 3_600_000, heartbeatMs: 60_000, agingMs: 15 * 60_000 };

/** A config object written before these keys existed (tests, old files): the
 *  shipped defaults fill each missing one. */
export function capacityOf(c: Partial<CapacityConfig> | undefined): CapacityConfig {
  return { ...DEFAULT_CAPACITY, ...(c ?? {}) };
}

/**
 * Provider cap, the model's default concurrency: explicit `maxConcurrent`
 * (N for a parallel-capable server), else the loopback default cap for loopback
 * (one local engine serves one request at a time), else unlimited (undefined).
 */
export function resolveCap(maxConcurrent: number | undefined, local: boolean, localDefaultCap: number = DEFAULT_CAPACITY.localDefaultCap): number | undefined {
  return maxConcurrent ?? (local ? localDefaultCap : undefined);
}

/** admitCap (the one admission rule, conversationSlots included) with a number always: unlimited becomes the uncapped queue cap (queue/plan runners). */
export function effectiveCap(maxConcurrent: number | undefined, local: boolean, conversationSlots?: number, capacity: CapacityConfig = DEFAULT_CAPACITY): number {
  return admitCap(maxConcurrent, conversationSlots, local, capacity) ?? capacity.uncappedQueueCap;
}

/**
 * Admission cap: the provider cap, held below the engine's conversation-cache
 * slots (one spare, never under 1) when `conversationSlots` is configured —
 * admitting more makes the cached conversations evict each other every turn.
 * Unset: the provider cap alone (conversationSlots defaults to it).
 */
export function admitCap(maxConcurrent: number | undefined, conversationSlots: number | undefined, local: boolean, capacity: CapacityConfig = DEFAULT_CAPACITY): number | undefined {
  const cap = resolveCap(maxConcurrent, local, capacity.localDefaultCap);
  if (conversationSlots === undefined) return cap;
  const limit = Math.max(1, conversationSlots - 1);
  return cap === undefined ? limit : Math.min(cap, limit);
}

/** Cap of a named provider from the config, the same rule the gate applies. */
export function providerCap(config: { providers: Record<string, { maxConcurrent?: number; conversationSlots?: number; baseUrl: string }>; capacity?: Partial<CapacityConfig> }, provider: string): number | undefined {
  const p = config.providers[provider];
  if (!p) return undefined;
  return admitCap(p.maxConcurrent, p.conversationSlots, isLocalProvider(p.baseUrl), capacityOf(config.capacity));
}

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
  /** Admission priority; unset = normal. */
  priority?: QueuePriority;
}

/** Write a ticket atomically (temp + rename): a poller never reads it half-written. The ".tmp" suffix keeps it out of the listing. */
function writeTicket(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const entryText = (e: QueueEntry): string =>
  `${e.pid}${e.front ? " front" : ""}${e.rank === undefined ? "" : ` ${e.rank}`}${e.since === undefined ? "" : ` @${e.since}`}${e.priority && e.priority !== "normal" ? ` p:${e.priority}` : ""}`;

/** A ticket deleted (its run stopped) or written unparsably between the listing and this read is absent, not an error. */
function readEntry(dir: string, id: string): QueueEntry | null {
  let text: string;
  try {
    text = readFileSync(join(dir, id), "utf8");
  } catch {
    return null;
  }
  const [p, ...marks] = text.trim().split(/\s+/);
  const rank = marks.map(Number).find((n) => Number.isInteger(n));
  const at = marks.find((m) => m.startsWith("@"));
  const since = at ? Number(at.slice(1)) : NaN;
  const prio = marks.find((m) => m.startsWith("p:"))?.slice(2) as QueuePriority | undefined;
  return {
    id,
    pid: Number(p),
    front: marks.includes("front"),
    ...(rank === undefined ? {} : { rank }),
    ...(Number.isFinite(since) ? { since } : {}),
    ...(prio && QUEUE_PRIORITIES.includes(prio) ? { priority: prio } : {}),
  };
}

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
  /** Aging bound; default `workers.capacity.agingMs`. */
  agingMs?: number;
}

/**
 * Grant order of a provider's waiting tickets: `--now` (front) tickets first,
 * then by priority (high, normal, low), and within a priority tickets waiting
 * longer than the aging bound (oldest first), then fair
 * share — the next slot goes to the session with the fewest slots (running +
 * already ordered ahead), ties to the session served least recently, then to
 * the one whose head waited longest, so
 * sessions take turns regardless of how many tickets each queued. A session's
 * own tickets keep their order (pull-forward via front/up/next).
 */
export function fairOrder(i: FairInput): QueueEntry[] {
  const aging = i.agingMs ?? DEFAULT_CAPACITY.agingMs;
  const since = (e: QueueEntry): number => e.since ?? i.now;
  const front = i.entries.filter((e) => e.front);
  const rest = i.entries.filter((e) => !e.front);
  const load = new Map<string, number>();
  for (const k of i.running) load.set(k, (load.get(k) ?? 0) + 1);
  for (const e of front) load.set(i.sessionOf(e.id), (load.get(i.sessionOf(e.id)) ?? 0) + 1);
  const out: QueueEntry[] = [...front];
  // higher priority is admitted first; fairness and aging only order tickets of the same priority
  for (const tier of QUEUE_PRIORITIES) {
    const mine = rest.filter((e) => (e.priority ?? "normal") === tier);
    const aged = mine.filter((e) => i.now - since(e) > aging).sort((a, b) => since(a) - since(b));
    const agedIds = new Set(aged.map((e) => e.id));
    const per = new Map<string, QueueEntry[]>();
    for (const e of mine) {
      if (agedIds.has(e.id)) continue;
      const k = i.sessionOf(e.id);
      per.set(k, [...(per.get(k) ?? []), e]);
    }
    for (const e of aged) load.set(i.sessionOf(e.id), (load.get(i.sessionOf(e.id)) ?? 0) + 1);
    out.push(...aged);
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
function fairEntries(logDir: string, key: string, isAlive: (pid: number) => boolean, statuses?: WorkerStatus[], now: number = Date.now(), agingMs?: number): QueueEntry[] {
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
    ...(agingMs === undefined ? {} : { agingMs }),
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
    if (!e) continue;
    // an empty or unparsable ticket is unknown, not dead: keep it, leave it out of the order
    if (!Number.isInteger(e.pid) || e.pid <= 0) continue;
    if (isAlive(e.pid)) out.push(e);
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
export function liveQueue(logDir: string, provider: string, isAlive: (pid: number) => boolean = alive, statuses?: WorkerStatus[], now?: number, agingMs?: number): string[] {
  return fairEntries(logDir, provider, isAlive, statuses, now, agingMs).map((e) => e.id);
}

/** Put a waiting run ahead of the provider's non-front runs ("front"). False when it is not waiting. */
export function setFront(logDir: string, provider: string, id: string, isAlive: (pid: number) => boolean = alive): boolean {
  const e = liveEntries(logDir, provider, isAlive).find((x) => x.id === id);
  if (!e) return false;
  if (!e.front) writeTicket(join(queueDir(logDir, provider), id), entryText({ ...e, front: true, rank: undefined }));
  return true;
}

/** Move a waiting run one place up. False when it is not waiting or already first. */
export function moveUp(logDir: string, provider: string, id: string, isAlive: (pid: number) => boolean = alive): boolean {
  const order = liveEntries(logDir, provider, isAlive);
  const i = order.findIndex((x) => x.id === id);
  if (i <= 0) return false;
  // the run takes the place (and group) of the one it passes
  [order[i - 1], order[i]] = [{ ...order[i], front: order[i - 1].front }, order[i - 1]];
  order.forEach((e, rank) => writeTicket(join(queueDir(logDir, provider), e.id), entryText({ ...e, rank })));
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
  order.forEach((x, rank) => writeTicket(join(queueDir(logDir, provider), x.id), entryText({ ...x, rank })));
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
  /** Admission priority of the ticket (normal when unset). */
  priority?: QueuePriority;
}

/**
 * The waiting workers of every provider, in grant order — the one queue
 * reader behind `pai worker ps`' QUEUED section, /cockpit/queue and the MCP
 * worker_queue list. Dead entries are dropped; a provider with no cap (or a
 * cap the config no longer names) still lists its waiters, cap undefined.
 */
export function queueRows(logDir: string, caps: Record<string, number | undefined> = {}, isAlive: (pid: number) => boolean = alive, statuses?: WorkerStatus[]): QueueRow[] {
  let providers: string[];
  try {
    providers = readdirSync(join(logDir, "queue")).sort();
  } catch {
    return [];
  }
  const rows: QueueRow[] = [];
  for (const prov of providers) {
    const queue = fairEntries(logDir, prov, isAlive, statuses);
    queue.forEach((e, i) => {
      rows.push({
        id: e.id,
        provider: prov,
        position: i + 1,
        queued: queue.length,
        cap: caps[prov],
        status: loadStatus(logDir, e.id) ?? undefined,
        ...(e.since === undefined ? {} : { since: e.since }),
        ...(e.priority ? { priority: e.priority } : {}),
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
  /** Admission priority when not normal. */
  priority?: QueuePriority;
}

/** The pane / footer line of a waiting run: "queued on p: position 2 of 3, behind <label> — waiting since 18:12". */
export function queuedText(q: { provider: string; position: number; queued: number; behind?: string; sinceMs: number }): string {
  const d = new Date(q.sinceMs);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `queued on ${q.provider}: position ${q.position} of ${q.queued}${q.behind ? `, behind ${q.behind}` : ""} — waiting since ${hhmm}`;
}

/** What a pane shows while its run waits for a provider slot (the `<id>.queued` file beside the launch record). */
export interface QueuedFile {
  provider: string;
  /** 1 = next in line. */
  position: number;
  /** Waiting runs on this provider. */
  queued: number;
  /** Seconds waiting so far. */
  elapsedSec: number;
  /** Label of the run holding a slot ahead of this one, when known. */
  behind?: string;
  /** The run's own label, shown last. */
  label?: string;
  /** Admission priority when not normal. */
  priority?: QueuePriority;
}

/** The pane's queue line, refreshed in place: "queued on gyro-m · position 2 of 5 · waiting 2m10s · <label>". */
export function queuedPaneLine(q: QueuedFile): string {
  const parts = [`queued on ${q.provider}`, `position ${q.position} of ${q.queued}`, `waiting ${fmtElapsed(q.elapsedSec)}`];
  if (q.priority && q.priority !== "normal") parts.push(`${q.priority} priority`);
  if (q.behind) parts.push(`behind ${q.behind}`);
  if (q.label) parts.push(q.label.replace(/[\x00-\x1f\x7f-\x9f]/g, ""));
  return parts.join(" · ");
}

/** Cut `s` to `width` characters at a word boundary with a trailing ellipsis; never mid-word unless one word fills the whole width. */
export function ellipsize(s: string, width: number): string {
  if (width <= 0 || s.length <= width) return s;
  const room = Math.max(1, width - 1);
  const cut = s.slice(0, room);
  if (s[room] === " ") return `${cut.trimEnd()}…`;
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 0 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** What identifies the place in line: a new line is printed only when this changes (the elapsed time alone does not). */
const queueStateKey = (q: QueuedFile): string => `${q.provider}|${q.position}|${q.queued}|${q.behind ?? ""}|${q.priority ?? ""}`;

export interface QueueLineWriter {
  /** Show the queue state; null clears a shown line. */
  show(q: QueuedFile | null): void;
  /** Remove the in-place line (TTY only). */
  clear(): void;
}

/**
 * The wrapper's queue line. On a terminal one line is refreshed in place
 * (\r + clear line, cut to the width with an ellipsis); it is committed with a
 * newline and a fresh line started only when the position or the run ahead
 * changes. Off a terminal (a log) a line is written only on such a change.
 */
export function queueLineWriter(o: {
  write: (s: string) => void;
  tty: boolean;
  columns?: () => number | null | undefined;
  /**
   * Whether the destination understands in-place redraw (\r + clear-line).
   * Default: `tty`. A wrapper that polls a queue file into plain strings
   * (pane-exec) passes true even off a terminal — the line is still one line
   * refreshed in place — while a plain log keeps whole newline-terminated lines.
   */
  inplace?: boolean;
}): QueueLineWriter {
  const inplace = o.inplace ?? o.tty;
  let key: string | null = null;
  let shown = false;
  let last = "";
  return {
    show(q) {
      if (!q) return this.clear();
      const k = queueStateKey(q);
      const full = queuedPaneLine(q);
      if (!inplace) {
        if (k === key) return;
        key = k;
        o.write(`${full}\n`);
        return;
      }
      const cols = o.columns?.();
      const line = o.tty && cols && cols > 1 ? ellipsize(full, cols - 1) : full;
      if (k === key && line === last) return;
      o.write(`${shown && k !== key ? "\n" : ""}\r\x1b[K${line}${o.tty ? "" : "\n"}`);
      key = k;
      last = line;
      shown = true;
    },
    clear() {
      if (inplace && shown) o.write("\r\x1b[K");
      shown = false;
      key = null;
      last = "";
    },
  };
}

/**
 * The pane's queue file: <pane-exec dir>/<id>.queued, written while the run
 * waits for a slot and removed when the command starts, so a pane opened
 * before the queue shows its place in line instead of sitting empty. The
 * wrapper (`pai pane exec`) prints it in place until the start frame arrives;
 * a missing or malformed file is simply no queue line.
 */
export function queuedFilePath(dir: string, id: string): string {
  return join(dir, `${id}.queued`);
}

export function readQueued(dir: string, id: string): QueuedFile | null {
  try {
    const q = JSON.parse(readFileSync(queuedFilePath(dir, id), "utf8")) as QueuedFile;
    if (typeof q.provider !== "string" || !Number.isInteger(q.position) || !Number.isInteger(q.queued) || !Number.isInteger(q.elapsedSec)) return null;
    return q;
  } catch {
    return null;
  }
}

/** Write atomically (rename), so the wrapper's poll never reads a half-written file. */
export function writeQueued(dir: string, id: string, q: QueuedFile): void {
  mkdirSync(dir, { recursive: true });
  const path = queuedFilePath(dir, id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(q), "utf8");
  renameSync(tmp, path);
}

export function removeQueued(dir: string, id: string): void {
  rmSync(queuedFilePath(dir, id), { force: true });
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
  /** Re-read on every poll: a cap raised (or lowered) in the config while the run waits applies at once. Lowering never evicts a holder. */
  capOf?: () => number | undefined;
  config: Partial<CapacityConfig>;
  disabled?: boolean;
  /** "front": wait ahead of the provider's other queued runs (--now). */
  priority?: "front";
  /** Admission priority (high before normal before low); default normal. */
  tier?: QueuePriority;
  log?: (line: string) => void;
  /** Waited this long (default `config.maxTotalWaitMs`): call onAlarm once. The alarm only tells the owner; it never kills or skips the run. */
  alarmMs?: number;
  onAlarm?: (info: CapacityInfo) => void;
  /** Called at the start and after every poll while queued; null once the slot is granted (the caller flips queued -> running then). */
  onWait?: (info: CapacityInfo | null) => void;
  /** Called at the start and after every poll with the pane's queue fields; null once the slot is granted (the pane's queue file). */
  onQueued?: (q: QueuedFile | null) => void;
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
  const cfg = capacityOf(o.config);
  if (o.disabled || !cfg.enabled || o.cap === undefined || o.cap <= 0) return null;
  const { logDir, self } = o;
  let cap: number = o.cap;
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
  writeTicket(entry, `${self.pid ?? process.pid}${o.priority === "front" ? " front" : ""} @${t0}${o.tier && o.tier !== "normal" ? ` p:${o.tier}` : ""}`);

  // Runs holding a slot: live and running on this provider — a "queued" status
  // is a waiter, never a holder, whatever its queue entry says.
  const check = () => {
    const loaded = load(logDir);
    const queue = liveQueue(logDir, queueKey, isAlive, loaded, now(), cfg.agingMs);
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
      priority: o.tier ?? "normal",
      line: `queued: ${total} on ${label}, cap ${cap} (position ${c.position})`,
    };
  };
  o.log?.(info().line);
  // the pane file is cosmetic: a failing writer never fails the gate
  const queued = (q: QueuedFile | null): void => {
    try { o.onQueued?.(q); } catch { /* ignore */ }
  };
  let lastBeat = t0;
  let alarmed = false;
  // the pane opened before the wait shows its place in line until the slot is granted
  const paneQueued = (i: CapacityInfo): QueuedFile => ({
    provider: i.provider,
    position: i.position,
    queued: i.queued,
    elapsedSec: i.elapsedSec,
    ...(c.behind ? { behind: c.behind } : {}),
    ...(i.priority ? { priority: i.priority } : {}),
  });
  try {
    o.onWait?.(info());
    queued(paneQueued(info()));
    for (let n = 0; ; n++) {
      await sleep(backoffMs(n));
      const fresh = o.capOf?.();
      if (fresh !== undefined && fresh > 0) cap = fresh;
      c = check();
      if (c.position === 1 && c.holding < cap) break;
      o.onWait?.(info());
      queued(paneQueued(info()));
      if (!alarmed && o.onAlarm && now() - t0 >= (o.alarmMs ?? cfg.maxTotalWaitMs)) {
        alarmed = true;
        o.onAlarm(info());
      }
      // a quiet log looks hung to wait-on's stall rule
      if (now() - lastBeat >= cfg.heartbeatMs) {
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
  queued(null);
  o.log?.(`waited ${waitedSec}s for a ${label} slot`);
  return { waitedSec, cap };
}
