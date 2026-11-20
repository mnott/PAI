/**
 * run-state.ts — the one marker of a running index or embed run.
 *
 * `pai memory embed`, `pai memory index --direct` and the daemon's pass child
 * (`pai memory pass`) write <PAI home>/state/memory-run.json while they run:
 * who started it, its pid and how far it is. The cockpit's Memory section
 * reads it to show progress and to refuse a second run; a marker whose pid is
 * gone is stale and ignored. A marker carrying the SAME pid as the reader is
 * only held when that process registered an in-flight run of this kind
 * (`beginPass`/`endPass`): the daemon's own index pass runs in-process, so its
 * marker shares the daemon's pid, and a marker left by an earlier pass that
 * ended without releasing must not lock every later pass out (2026-11-20
 * 08:00: the daemon refused itself four times, then gave up).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paiHomePath } from "../config/pai-home.js";

export type RunKind = "embed" | "index";
export type RunStarter = "cli" | "cockpit" | "daemon";

export interface RunState {
  kind: RunKind;
  pid: number;
  by: RunStarter;
  /** ISO time the run began. */
  startedAt: string;
  /** Chunks without vectors when an embed run began; null when unknown (index). */
  backlogStart: number | null;
  /** Chunks embedded so far. */
  done: number;
  /** ISO time of the last update. */
  updatedAt: string;
  /** The cockpit job this run belongs to, "" when not started from the cockpit. */
  jobId: string;
  /** Start time (epoch ms) of `pid`, to tell this run from a later process that reuses the pid; absent in older markers. */
  pidStart?: number;
}

/** How a finished run ended. */
export type RunOutcome = "done" | "budget" | "yielded" | "stopped" | "failed";

/** The last finished run of a kind, kept until the next run of that kind starts. */
export interface FinishedRun {
  kind: RunKind;
  by: RunStarter;
  startedAt: string;
  endedAt: string;
  backlogStart: number | null;
  done: number;
  outcome: RunOutcome;
  /** Why it did not finish cleanly (stopped / yielded / failed); "" otherwise. */
  reason: string;
}

export function finishedRunFile(kind: RunKind, home?: string): string {
  return home ? `${home}/state/memory-last-${kind}.json` : paiHomePath("state", `memory-last-${kind}.json`);
}

/** The last finished run of this kind, null when none or a newer run of the kind has started. */
export function readFinishedRun(kind: RunKind, home?: string): FinishedRun | null {
  try {
    const r = JSON.parse(readFileSync(finishedRunFile(kind, home), "utf8")) as FinishedRun;
    return r && r.kind === kind && typeof r.endedAt === "string" ? r : null;
  } catch {
    return null;
  }
}

export function runStateFile(home?: string): string {
  return home ? `${home}/state/memory-run.json` : paiHomePath("state", "memory-run.json");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Start time of a process (epoch ms) from `ps`; undefined when unknown. */
export function processStartMs(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    const t = Date.parse(out.trim());
    return Number.isNaN(t) ? undefined : t;
  } catch {
    return undefined;
  }
}

/** The running run, null when there is none or its marker is stale (pid gone, or reused by another process). */
export function readRun(
  home?: string,
  isAlive: (pid: number) => boolean = alive,
  startOf: (pid: number) => number | undefined = processStartMs,
): RunState | null {
  try {
    const r = JSON.parse(readFileSync(runStateFile(home), "utf8")) as RunState;
    if (!r || typeof r.pid !== "number" || !isAlive(r.pid)) return null;
    if (typeof r.pidStart === "number") {
      const s = startOf(r.pid);
      if (s === undefined || Math.abs(s - r.pidStart) > 2000) return null;
    }
    // a marker carrying THIS process's pid is only held while this process says a
    // run of that kind is in flight (`inFlightPass`): a long-lived process — the
    // daemon — whose earlier pass left its marker behind must not read it as live.
    if (r.pid === process.pid && !inFlightPass(r.kind)) return null;
    return r;
  } catch {
    return null;
  }
}

/** Kinds with a run in flight in this process, set by beginPass/endPass around every pass that holds the marker. */
const passesInFlight = new Set<RunKind>();

/** Register (or clear) that this process has an index/embed run in flight — the same handle's acquire…release window. */
export function beginPass(kind: RunKind): void { passesInFlight.add(kind); }
export function endPass(kind: RunKind): void { passesInFlight.delete(kind); }

/** Whether this process holds a run of this kind in flight; the sole authority for a marker bearing our own pid. */
export function inFlightPass(kind: RunKind): boolean { return passesInFlight.has(kind); }

function write(file: string, r: RunState | FinishedRun): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r) + "\n", "utf8");
  renameSync(tmp, file);
}

/** Who started this process: the cockpit sets PAI_RUN_BY / PAI_COCKPIT_JOB when it spawns a run. */
export function starterFromEnv(env: NodeJS.ProcessEnv = process.env): { by: RunStarter; jobId: string } {
  const by = env.PAI_RUN_BY === "cockpit" || env.PAI_RUN_BY === "daemon" ? env.PAI_RUN_BY : "cli";
  return { by, jobId: env.PAI_COCKPIT_JOB ?? "" };
}

export interface RunHandle {
  /** Record the backlog at start (known once the embed run has counted it). */
  setBacklog(n: number): void;
  /** Record progress (throttled to one write per `minGapMs`). */
  progress(done: number): void;
  /** Remove the marker (only if it is still this run's) and keep the run as the last finished one of its kind.
   *  Without a result the run counts as failed (it ended without reporting one). */
  release(result?: { outcome: RunOutcome; reason?: string }): void;
}

/** Take the marker for this process; null when another live run holds it. */
export function acquireRun(
  kind: RunKind,
  o: { by?: RunStarter; jobId?: string; backlogStart?: number | null; home?: string; now?: () => number; minGapMs?: number } = {},
): RunHandle | null {
  const file = runStateFile(o.home);
  const unlock = lockStart(file);
  if (!unlock) return null;
  try {
    // readRun already treats a marker bearing our own pid as stale unless this
    // process registered an in-flight run of that kind, so any marker it still
    // reports belongs to another live run — refuse it (a same-pid marker left by
    // an earlier pass of this process is overwritten below).
    if (readRun(o.home)) return null;
    beginPass(kind);
    try {
      return takeMarker(kind, o, file);
    } catch (e) {
      endPass(kind);
      throw e;
    }
  } finally {
    unlock();
  }
}

/** Exclusive lock around check-and-write of the marker, so two simultaneous starts cannot both pass the check.
 *  Null when another start holds it (a lock older than 10 s belongs to a start that died). */
function lockStart(file: string): (() => void) | null {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      return () => {
        try { rmdirSync(lock); } catch { /* gone */ }
      };
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs <= 10_000) return null;
        rmdirSync(lock);
      } catch { /* raced */ }
    }
  }
  return null;
}

function takeMarker(
  kind: RunKind,
  o: { by?: RunStarter; jobId?: string; backlogStart?: number | null; home?: string; now?: () => number; minGapMs?: number },
  file: string,
): RunHandle {
  const now = o.now ?? Date.now;
  const starter = starterFromEnv();
  const pidStart = processStartMs(process.pid);
  const state: RunState = {
    kind,
    pid: process.pid,
    by: o.by ?? starter.by,
    startedAt: new Date(now()).toISOString(),
    backlogStart: o.backlogStart ?? null,
    done: 0,
    updatedAt: new Date(now()).toISOString(),
    jobId: o.jobId ?? starter.jobId,
    ...(pidStart !== undefined ? { pidStart } : {}),
  };
  rmSync(finishedRunFile(kind, o.home), { force: true });
  write(file, state);
  let latest = 0;
  let last = now();
  const gap = o.minGapMs ?? 2000;
  return {
    setBacklog(n) {
      state.backlogStart = n;
      try { write(file, state); } catch { /* best effort */ }
    },
    progress(done) {
      latest = done;
      const t = now();
      if (t - last < gap) return;
      last = t;
      state.done = done;
      state.updatedAt = new Date(t).toISOString();
      try { write(file, state); } catch { /* progress is best effort */ }
    },
    release(result) {
      // the in-flight flag goes first: from here on our own marker reads stale,
      // and the file itself is removed unconditionally — every path that took
      // this handle releases it (the callers' finally blocks), so a leftover
      // same-pid marker is by definition ours and dead.
      endPass(kind);
      try {
        rmSync(file, { force: true });
      } catch { /* best effort; readRun ignores a stale marker */ }
      try {
        const r = result ?? { outcome: "failed" as RunOutcome, reason: "ended without a result" };
        const fin: FinishedRun = { kind, by: state.by, startedAt: state.startedAt, endedAt: new Date(now()).toISOString(), backlogStart: state.backlogStart, done: Math.max(state.done, latest), outcome: r.outcome, reason: r.reason ?? "" };
        write(finishedRunFile(kind, o.home), fin);
      } catch { /* the record is informational */ }
    },
  };
}
