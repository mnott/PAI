/**
 * queue.ts — the machine-wide build queue as plain files.
 *
 * One ticket file per build in <dir>/tickets, written under a short mkdir
 * mutex. A ticket is "waiting" or "running"; the running ones hold the slots
 * (config `builds.slots`, default 1), the waiting ones start in `seq` order
 * (FIFO; `next` gives one the lowest seq). A ticket whose gate process is
 * gone is pruned by whoever looks next, and the build tree it left behind is
 * killed, so a SIGKILLed caller cannot keep the lock.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BuildTicket {
  id: string;
  /** The gate process (`pai build run|lock`) that owns this ticket. */
  pid: number;
  label: string;
  /** Who asked: "worker <id>" or the session/project name. */
  session: string;
  /** Worker id when started by a worker (so killing the worker frees the lock). */
  worker?: string;
  cmd: string;
  mode: "delta" | "full";
  seq: number;
  state: "waiting" | "running";
  enqueuedAt: number;
  startedAt?: number;
  /** Process group of the running build. */
  pgid?: number;
  log?: string;
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
  return join(env.PAI_HOME || join(homedir(), ".claude", "pai"), "logs", "builds");
}

const ticketsDir = (dir: string): string => join(dir, "tickets");
const ticketFile = (dir: string, id: string): string => join(ticketsDir(dir), `${id}.json`);
export const buildLogPath = (dir: string, id: string): string => join(dir, `${id}.log`);

async function withMutex<T>(dir: string, fn: () => T): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const m = join(dir, "mutex");
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(m);
      break;
    } catch {
      try {
        if (Date.now() - statSync(m).mtimeMs > 5000) rmdirSync(m); // holder died inside the critical section
      } catch {
        /* raced */
      }
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
  return [...run, ...wait];
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
  info: Pick<BuildTicket, "pid" | "label" | "session" | "cmd" | "mode"> & { worker?: string },
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
    if (me.state === "running") return true;
    const free = slots - all.filter((t) => t.state === "running").length;
    if (free <= 0) return false;
    const first = all.filter((t) => t.state === "waiting").sort((a, b) => a.seq - b.seq).slice(0, free);
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

/** Give a waiting build the next start. Returns the new waiting order. */
export async function buildNext(dir: string, idOrLabel: string, d: Partial<QueueDeps> = {}): Promise<string[]> {
  const deps = { ...defaultDeps(), ...d };
  return withMutex(dir, () => {
    prune(dir, deps);
    const all = readTickets(dir);
    const t = all.find((x) => x.id === idOrLabel) ?? all.find((x) => x.label === idOrLabel && x.state === "waiting");
    if (!t) throw new Error(`no queued build "${idOrLabel}"`);
    if (t.state !== "waiting") throw new Error(`build ${t.id} is already running`);
    const lowest = Math.min(...all.filter((x) => x.state === "waiting").map((x) => x.seq));
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

/** The text `pai build queue` and `pai worker ps` print. */
export function renderBuildQueue(tickets: BuildTicket[], slots: number, now = Date.now()): string {
  const head = `builds (${slots} slot${slots === 1 ? "" : "s"})`;
  if (!tickets.length) return `${head}: nothing running or waiting`;
  const lines = [head];
  let pos = 0;
  for (const t of tickets) {
    const mode = t.mode === "full" ? " [full]" : "";
    if (t.state === "running") lines.push(`  running  ${t.label}${mode} — ${t.session}, ${mins(now - (t.startedAt ?? t.enqueuedAt))}  ${t.id}`);
    else lines.push(`  ${++pos}. waiting ${t.label}${mode} — ${t.session}, ${mins(now - t.enqueuedAt)}  ${t.id}`);
  }
  return lines.join("\n");
}

/** Read-only, lock-free view for `pai worker ps` and the cockpit: live tickets only, nothing pruned. */
export function listBuildsSync(dir: string, isAlive: (pid: number) => boolean = defaultDeps().isAlive): BuildTicket[] {
  return ordered(readTickets(dir).filter((t) => isAlive(t.pid)));
}
