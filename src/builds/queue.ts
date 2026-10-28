/**
 * queue.ts — the machine-wide build queue as plain files.
 *
 * One ticket file per build in <dir>/tickets, written under a short mkdir
 * mutex. A ticket is "waiting" or "running"; the running ones hold the slots
 * (config `builds.slots`, default 1; test-kind tickets have their own pool,
 * `builds.testSlots`), the waiting ones start in `seq` order within their
 * pool (FIFO; `next` gives one the lowest seq). A ticket whose gate process is
 * gone is pruned by whoever looks next, and the build tree it left behind is
 * killed, so a SIGKILLed caller cannot keep the lock.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { minOf } from "../utils/min-max.js";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { DEFAULT_TEST_SLOTS } from "./config.js";

/** Which pool a ticket draws from: compiling ("build") or simulator/device test runs ("test"). */
export type BuildKind = "build" | "test";

export const ticketKind = (t: Pick<BuildTicket, "kind">): BuildKind => t.kind ?? "build";

export interface BuildTicket {
  id: string;
  /** Pool of the ticket; absent means "build". */
  kind?: BuildKind;
  /** Simulators already booted when a test job started (so only the ones it added get shut down). */
  bootedBefore?: string[];
  /** The gate process (`pai build run|lock`) that owns this ticket. */
  pid: number;
  label: string;
  /** Build key: jobs with the same key run one at a time (one warm tree per target). */
  key?: string;
  /** Who asked: "worker <id>" or the session/project name. */
  session: string;
  /** Worker id when started by a worker (so killing the worker frees the lock). */
  worker?: string;
  cmd: string;
  mode: "delta" | "full";
  seq: number;
  state: "waiting" | "running" | "superseded";
  /** Why a ticket left the queue before it ran: superseded by a newer same-key same-owner ticket, or released by the operator. */
  goneReason?: "superseded" | "released";
  /** The new ticket id (superseded) or the actor (released). */
  goneBy?: string;
  enqueuedAt: number;
  startedAt?: number;
  /** Paths (cwd, derived data, ...) that name this job's compilers in `ps`. */
  paths?: string[];
  /** Process group of the running build. */
  pgid?: number;
  log?: string;
  /** Extra log files the door declared (PAI_BUILD_LOG, "log: <path>" in its output); watched for stall detection. */
  logs?: string[];
  /** Epoch ms the stall watcher found the output not growing; cleared when it grows again. */
  stalledAt?: number;
}

export interface QueueDeps {
  isAlive: (pid: number) => boolean;
  kill: (pid: number, sig: NodeJS.Signals) => void;
  now: () => number;
}

const defaultDeps = (): QueueDeps => ({
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  kill: (pid, sig) => {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  },
  now: () => Date.now(),
});

/** Where builds live: PAI_BUILD_DIR, else PAI_HOME/logs/builds. */
export function buildsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PAI_BUILD_DIR) return env.PAI_BUILD_DIR;
  return paiHomePath("logs", "builds");
}

const ticketsDir = (dir: string): string => join(dir, "tickets");
const ticketFile = (dir: string, id: string): string => join(ticketsDir(dir), `${id}.json`);
export const buildLogPath = (dir: string, id: string): string => join(dir, `${id}.log`);

/** Identity a waiting ticket is superseded under: the worker id when the ticket has one, else the session,
 *  so two workers of one session are never merged. */
const ownerKey = (t: BuildTicket): string => t.worker ?? t.session;

/** A ticket whose gate process is gone is pruned by whoever looks next; these are the codes a gate exits
 *  with when the queue took its place instead of running the command (documented next to the gate's
 *  signal codes 129/130/143):
 *  - 4: superseded — a newer waiting ticket with the same key and owner won;
 *  - 5: released by the operator (`pai build release`).
 *  Neither is 3: 3 is a door's `--wait` "still running, call again", and a door must not poll a dead job. */
export const SUPERSEDED_EXIT = 4;
export const RELEASED_EXIT = 5;

/** Mark a ticket gone (superseded or operator-released) so its gate notices on its next poll.
 *  The file stays (state "superseded") until the gate has read the reason — a gate that is SIGKILLed
 *  never reads it, and prune() drops those files. */
function markGone(dir: string, t: BuildTicket, reason: "superseded" | "released", by: string): void {
  writeTicket(dir, { ...t, state: "superseded", goneReason: reason, goneBy: by });
}

/** When `t` is a waiting ticket with a key, drop every older waiting ticket with the same key and the
 *  same owner: a re-run of the same door from the same worker supersedes its own earlier job (the newer
 *  tree wins) instead of making everyone wait behind a duplicate. A RUNNING ticket is never touched;
 *  tickets without a key are never superseded. Returns the ids dropped. */
function supersedeOlderWaiting(dir: string, t: BuildTicket): string[] {
  if (t.state !== "waiting" || !t.key) return [];
  const victims = readTickets(dir).filter(
    (x) => x.id !== t.id && x.state === "waiting" && x.key === t.key && ownerKey(x) === ownerKey(t) && x.seq < t.seq
  );
  for (const v of victims) markGone(dir, v, "superseded", t.id);
  return victims.map((v) => v.id);
}

/** Remove `m` when its holder died inside the critical section (older than `staleMs`).
 *  Breakers serialize on `m.break` and re-check the age under it, so a waiter that saw the old mutex
 *  cannot remove the fresh one a faster waiter took after the break. */
export function breakStaleMutex(m: string, staleMs = 5000): void {
  const guard = `${m}.break`;
  try {
    mkdirSync(guard);
  } catch {
    try {
      if (Date.now() - statSync(guard).mtimeMs > staleMs) rmdirSync(guard); // a breaker died holding the guard
    } catch {
      /* raced */
    }
    return;
  }
  try {
    if (Date.now() - statSync(m).mtimeMs > staleMs) rmdirSync(m);
  } catch {
    /* gone or raced */
  } finally {
    try {
      rmdirSync(guard);
    } catch {
      /* gone */
    }
  }
}

async function withMutex<T>(dir: string, fn: () => T): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const m = join(dir, "mutex");
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(m);
      break;
    } catch {
      breakStaleMutex(m);
      if (Date.now() - t0 > 15000) throw new Error("build queue mutex busy");
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(m);
    } catch {
      /* gone */
    }
  }
}

function readTickets(dir: string): BuildTicket[] {
  const d = ticketsDir(dir);
  if (!existsSync(d)) return [];
  const out: BuildTicket[] = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(d, f), "utf8")) as BuildTicket);
    } catch {
      /* half-written or foreign */
    }
  }
  return out;
}

function writeTicket(dir: string, t: BuildTicket): void {
  mkdirSync(ticketsDir(dir), { recursive: true });
  const f = ticketFile(dir, t.id);
  writeFileSync(`${f}.tmp`, JSON.stringify(t), "utf8");
  renameSync(`${f}.tmp`, f);
}

/** Running tickets first (oldest start first), then waiting ones in start order. */
export function ordered(tickets: BuildTicket[]): BuildTicket[] {
  const run = tickets.filter((t) => t.state === "running").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const wait = tickets.filter((t) => t.state === "waiting").sort((a, b) => a.seq - b.seq);
  const gone = tickets.filter((t) => t.state === "superseded").sort((a, b) => a.seq - b.seq);
  return [...run, ...wait, ...gone];
}

/** Kill the build tree of a ticket (group first, the gate itself after). */
export function killTicket(t: BuildTicket, deps: QueueDeps, withGate: boolean): void {
  if (t.pgid && t.pgid > 1) {
    deps.kill(-t.pgid, "SIGTERM");
    setTimeout(() => deps.kill(-(t.pgid as number), "SIGKILL"), 3000).unref();
  }
  if (withGate && t.pid > 1) deps.kill(t.pid, "SIGTERM");
}

function prune(dir: string, deps: QueueDeps): void {
  for (const t of readTickets(dir)) {
    if (deps.isAlive(t.pid)) continue;
    killTicket(t, deps, false);
    rmSync(ticketFile(dir, t.id), { force: true });
  }
  // a superseded/released ticket whose gate is gone without ever reading the reason
  for (const t of readTickets(dir)) {
    if (t.state === "superseded" && !deps.isAlive(t.pid)) rmSync(ticketFile(dir, t.id), { force: true });
  }
}

export async function listBuilds(dir: string, d: Partial<QueueDeps> = {}): Promise<BuildTicket[]> {
  const deps = { ...defaultDeps(), ...d };
  if (!existsSync(ticketsDir(dir))) return [];
  return withMutex(dir, () => {
    prune(dir, deps);
    return ordered(readTickets(dir));
  });
}

export async function enqueue(
  dir: string,
  info: Pick<BuildTicket, "pid" | "label" | "session" | "cmd" | "mode"> & { worker?: string; kind?: BuildKind; key?: string },
  d: Partial<QueueDeps> = {}
): Promise<BuildTicket> {
  const deps = { ...defaultDeps(), ...d };
  return withMutex(dir, () => {
    prune(dir, deps);
    const all = readTickets(dir);
    const now = deps.now();
    const seq = Math.max(now, ...all.map((t) => t.seq + 1));
    const id = `b-${new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${info.pid}${Math.floor(Math.random() * 36 ** 3).toString(36)}`;
    const t: BuildTicket = { ...info, id, seq, state: "waiting", enqueuedAt: now, log: buildLogPath(dir, id) };
    writeTicket(dir, t);
    supersedeOlderWaiting(dir, t);
    return t;
  });
}

/** Start `id` when a slot is free and it is among the first waiters. */
export async function tryStart(dir: string, id: string, slots: number, d: Partial<QueueDeps> = {}): Promise<boolean> {
  const deps = { ...defaultDeps(), ...d };
  return withMutex(dir, () => {
    prune(dir, deps);
    const all = readTickets(dir);
    const me = all.find((t) => t.id === id);
    if (!me) throw new Error(`build ${id} is not queued any more`);
    if (me.state === "superseded") return false; // gate notices on its next poll and exits (SUPERSEDED/RELEASED_EXIT)
    if (me.state === "running") return true;
    // a ticket left by supersede/release is not a waiter any more (no slot claim, no key block)
    const live = all.filter((t) => t.state !== "superseded");
    const kind = ticketKind(me);
    const pool = live.filter((t) => ticketKind(t) === kind);
    const free = slots - pool.filter((t) => t.state === "running").length;
    if (free <= 0) return false;
    // a waiter whose key is running (any pool) or already claimed by an earlier waiter does not take a slot
    const taken = new Set(live.filter((t) => t.state === "running" && t.key).map((t) => t.key as string));
    const first: BuildTicket[] = [];
    for (const t of pool.filter((x) => x.state === "waiting").sort((a, b) => a.seq - b.seq)) {
      if (first.length >= free) break;
      if (t.key) {
        if (taken.has(t.key)) continue;
        taken.add(t.key);
      }
      first.push(t);
    }
    if (!first.some((t) => t.id === id)) return false;
    writeTicket(dir, { ...me, state: "running", startedAt: deps.now() });
    return true;
  });
}

export async function patchTicket(dir: string, id: string, patch: Partial<BuildTicket>): Promise<void> {
  await withMutex(dir, () => {
    const t = readTickets(dir).find((x) => x.id === id);
    if (t) writeTicket(dir, { ...t, ...patch });
  });
}

export async function removeTicket(dir: string, id: string): Promise<void> {
  if (!existsSync(ticketFile(dir, id))) return;
  await withMutex(dir, () => rmSync(ticketFile(dir, id), { force: true }));
}

export async function getTicket(dir: string, id: string): Promise<BuildTicket | null> {
  return withMutex(dir, () => readTickets(dir).find((t) => t.id === id) ?? null);
}

/** Operator release: take a ticket out of the queue and mark it gone so its gate exits with
 *  SUPERSEDED_EXIT (waiting) or RELEASED_EXIT (running, after its build tree is killed).
 *  A running ticket's process group gets SIGTERM, SIGKILL after 5 s. Returns what happened. */
export async function releaseBuild(dir: string, id: string, d: Partial<QueueDeps> = {}): Promise<{ id: string; state: "waiting" | "running" }> {
  const deps = { ...defaultDeps(), ...d };
  return withMutex(dir, () => {
    prune(dir, deps);
    const t = readTickets(dir).find((x) => x.id === id);
    if (!t) throw new Error(`no queued build "${id}"`);
    const state: "waiting" | "running" = t.state === "running" ? "running" : "waiting";
    markGone(dir, t, "released", `operator pid ${process.pid}`);
    if (state === "running") killTicket(t, deps, false); // gate exits RELEASED_EXIT on its next poll
    return { id: t.id, state };
  });
}

/** Give a waiting build the next start. Returns the new waiting order. */
export async function buildNext(dir: string, idOrLabel: string, d: Partial<QueueDeps> = {}): Promise<string[]> {
  const deps = { ...defaultDeps(), ...d };
  return withMutex(dir, () => {
    prune(dir, deps);
    const all = readTickets(dir);
    const t = all.find((x) => x.id === idOrLabel) ?? all.find((x) => x.label === idOrLabel && x.state === "waiting");
    if (!t) throw new Error(`no queued build "${idOrLabel}"`);
    if (t.state !== "waiting") throw new Error(`build ${t.id} is already running`);
    const lowest = minOf(all.filter((x) => x.state === "waiting").map((x) => x.seq));
    writeTicket(dir, { ...t, seq: lowest - 1 });
    return ordered(readTickets(dir)).filter((x) => x.state === "waiting").map((x) => x.id);
  });
}

/** A worker was killed or loop-stopped: free its builds and kill their trees. Returns the ticket ids freed. */
export async function releaseBuildsOf(dir: string, worker: string, d: Partial<QueueDeps> = {}): Promise<string[]> {
  const deps = { ...defaultDeps(), ...d };
  if (!existsSync(ticketsDir(dir))) return [];
  return withMutex(dir, () => {
    const mine = readTickets(dir).filter((t) => t.worker === worker);
    for (const t of mine) {
      killTicket(t, deps, true);
      rmSync(ticketFile(dir, t.id), { force: true });
    }
    return mine.map((t) => t.id);
  });
}

const mins = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m`;
};

/** Why a waiting job is held back by its key: "same key as <job>" (the running or earlier-queued holder), else null. */
export function waitReason(t: BuildTicket, tickets: BuildTicket[]): string | null {
  if (!t.key) return null;
  const holder =
    tickets.find((x) => x.id !== t.id && x.key === t.key && x.state === "running") ??
    tickets.filter((x) => x.id !== t.id && x.key === t.key && x.state === "waiting" && x.seq < t.seq).sort((a, b) => a.seq - b.seq)[0];
  return holder ? `same key as ${holder.label}` : null;
}

/** Slot counts of both pools. */
export interface PoolSlots {
  build: number;
  test: number;
}

/** The text `pai build queue` and `pai worker ps` print: one block per pool. */
export function renderBuildQueue(tickets: BuildTicket[], slots: number | PoolSlots, testSlots?: number, now = Date.now()): string {
  const pools: PoolSlots = typeof slots === "number" ? { build: slots, test: testSlots ?? DEFAULT_TEST_SLOTS } : slots;
  const plural = (n: number): string => `${n} slot${n === 1 ? "" : "s"}`;
  const block = (kind: BuildKind, name: string, n: number): string => {
    const head = `${name} (${plural(n)})`;
    const mine = tickets.filter((t) => ticketKind(t) === kind);
    if (!mine.length) return `${head}: nothing running or waiting`;
    const lines = [head];
    let pos = 0;
    for (const t of mine) {
      const mode = t.mode === "full" ? " [full]" : "";
      const key = t.key ? ` [${t.key}]` : "";
      if (t.state === "running") lines.push(`  running  ${t.label}${mode}${key} — ${t.session}, ${mins(now - (t.startedAt ?? t.enqueuedAt))}${t.stalledAt ? `  STALLED ${mins(now - t.stalledAt)}` : ""}  ${t.id}`);
      else {
        const why = waitReason(t, tickets);
        lines.push(`  ${++pos}. waiting ${t.label}${mode}${key} — ${t.session}, ${mins(now - t.enqueuedAt)}${why ? `, ${why}` : ""}  ${t.id}`);
      }
    }
    return lines.join("\n");
  };
  return [block("build", "builds", pools.build), block("test", "tests", pools.test)].join("\n");
}

/** Read-only, lock-free view for `pai worker ps` and the cockpit: live tickets only, nothing pruned. */
export function listBuildsSync(dir: string, isAlive: (pid: number) => boolean = defaultDeps().isAlive): BuildTicket[] {
  return ordered(readTickets(dir).filter((t) => isAlive(t.pid)));
}
