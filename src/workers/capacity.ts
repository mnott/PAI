/**
 * Capacity gate: a provider can only serve so many runs at once (a local
 * vllm-mlx server with --max-num-seqs 3 queues the rest inside the server,
 * where nobody sees it). Runs beyond `maxConcurrent` wait here instead, in
 * FIFO order, with a status line saying why. Queue = one file per waiting run
 * (name = run id, content = pid) in <logDir>/queue/<provider>/; entries whose
 * pid is gone are dropped.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backoffMs } from "./stagger.js";
import { alive, isLive, loadStatuses, ownsPid, reconcileStatuses, type WorkerStatus } from "./status.js";

export interface CapacityConfig {
  enabled: boolean;
}

export const DEFAULT_CAPACITY: CapacityConfig = { enabled: true };

/**
 * Loopback default. The server exposes no capacity: GET /v1/models, /health
 * and /v1/cache/stats on a vllm-mlx server report model names and cache
 * counters only, not max-num-seqs.
 */
export const LOCAL_DEFAULT_CAP = 3;

/** Provider cap: explicit `maxConcurrent`, else 3 for loopback, else unlimited (undefined). */
export function resolveCap(maxConcurrent: number | undefined, local: boolean): number | undefined {
  return maxConcurrent ?? (local ? LOCAL_DEFAULT_CAP : undefined);
}

/** Longest silence of the log while queued. */
export const HEARTBEAT_MS = 60_000;

const queueDir = (logDir: string, provider: string) => join(logDir, "queue", provider.replace(/[^\w.-]/g, "_"));

interface QueueEntry {
  id: string;
  pid: number;
  front: boolean;
  /** Explicit position (moveUp), within the entry's group; unset = after the ranked ones, by name. */
  rank?: number;
}

const entryText = (e: QueueEntry): string => `${e.pid}${e.front ? " front" : ""}${e.rank === undefined ? "" : ` ${e.rank}`}`;

function readEntry(dir: string, id: string): QueueEntry {
  const [p, ...marks] = readFileSync(join(dir, id), "utf8").trim().split(/\s+/);
  const rank = marks.map(Number).find((n) => Number.isInteger(n));
  return { id, pid: Number(p), front: marks.includes("front"), ...(rank === undefined ? {} : { rank }) };
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
export function liveQueue(logDir: string, provider: string, isAlive: (pid: number) => boolean = alive): string[] {
  return liveEntries(logDir, provider, isAlive).map((e) => e.id);
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

export interface CapacityInfo {
  provider: string;
  cap: number;
  /** Runs on the provider: those holding a slot plus those queued. */
  total: number;
  /** 1 = next in line. */
  position: number;
  elapsedSec: number;
  line: string;
}

export interface CapacityOpts {
  logDir: string;
  self: { id: string; provider: string; pid?: number };
  /** Resolved cap; undefined = unlimited. */
  cap: number | undefined;
  config: CapacityConfig;
  disabled?: boolean;
  /** "front": wait ahead of the provider's other queued runs (--now). */
  priority?: "front";
  log?: (line: string) => void;
  /** Called at the start and after every poll while queued; null when released. */
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
  const dir = queueDir(logDir, self.provider);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, self.id);
  writeFileSync(entry, `${self.pid ?? process.pid}${o.priority === "front" ? " front" : ""}`);

  // Runs holding a slot: live, running, on this provider, and not waiting in the queue themselves.
  const check = () => {
    const queue = liveQueue(logDir, self.provider, isAlive);
    const queued = new Set(queue);
    const holding = load(logDir).filter(
      (s) => s.id !== self.id && s.provider === self.provider && isLive(s, o.isAlive ? (w) => isAlive(w.pid) : ownsPid) && !queued.has(s.id),
    ).length;
    const position = queue.indexOf(self.id) + 1;
    return { holding, position: position || queue.length + 1, queued: queue.length };
  };

  let c = check();
  if (c.position === 1 && c.holding < cap) {
    rmSync(entry, { force: true });
    return null;
  }
  const t0 = now();
  const info = (): CapacityInfo => {
    const total = c.holding + c.queued;
    return {
      provider: self.provider,
      cap,
      total,
      position: c.position,
      elapsedSec: Math.floor((now() - t0) / 1000),
      line: `queued: ${total} on ${self.provider}, cap ${cap} (position ${c.position})`,
    };
  };
  o.log?.(info().line);
  let lastBeat = t0;
  try {
    o.onWait?.(info());
    for (let n = 0; ; n++) {
      await sleep(backoffMs(n));
      c = check();
      if (c.position === 1 && c.holding < cap) break;
      o.onWait?.(info());
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
  o.onWait?.(null);
  o.log?.(`waited ${waitedSec}s for a ${self.provider} slot`);
  return { waitedSec, cap };
}
