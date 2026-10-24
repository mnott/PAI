/**
 * job-progress.ts — live progress of an index or embed run, written into its cockpit job record
 * (<home>/cockpit-jobs/<id>.json, field `progress`).
 *
 * The cockpit spawns the run with PAI_COCKPIT_JOB=<id>; the run feeds its own counters in here and
 * the cockpit shows them on its normal poll. The writer merges into the existing record (the
 * router's pid and message stay), only while the record says "running", and replaces the file
 * atomically. The router's final write (done/failed/interrupted) carries no `progress`, so the
 * end state replaces it.
 *
 * The same writer also keeps one record per kind for EVERY run, whoever started it (cockpit job, CLI,
 * the daemon's scheduled pass): <home>/run-progress/{index,embed}.json. A record whose pid is gone
 * and that never said "finished" reads "ended" (the run died).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { paiHomeDir } from "../config/pai-home.js";

export type ProgressPhase = "scan" | "index" | "embed";

export interface JobRunProgress {
  phase: ProgressPhase;
  /** units finished / all units (projects for an index run, chunks for an embed run); total 0 = unknown */
  done: number;
  total: number;
  unit: "projects" | "chunks";
  files: number;
  chunks: number;
  skipped: number;
  /** embed run: of `done`, chunks whose vector was carried over from a same-text twin (no model call) */
  carried: number;
  /** display name of the project in hand, "" when none */
  current: string;
  elapsedSec: number;
  /** ISO time of this write */
  updatedAt: string;
  /** ISO time the counters last changed (a hung run stops moving this) */
  movedAt: string;
}

/** Per-project tick of an index-all loop: what the run has done so far, within the project in hand included. */
export interface IndexAllProgress {
  done: number;
  total: number;
  current: string;
  files: number;
  chunks: number;
  skipped: number;
}

export type ProgressFields = Partial<Omit<JobRunProgress, "elapsedSec" | "updatedAt" | "movedAt">>;

export interface ProgressWriter {
  /** Set the counters; writes at most once per `minGapMs` (the first call always writes). */
  update(f: ProgressFields): void;
  /** Mark the run record finished (the cockpit job record is closed by the router). */
  finish(): void;
}

export const PROGRESS_GAP_MS = 3000;

export type RunKind = "index" | "embed";

/** The shared record of the newest run of a kind (<home>/run-progress/<kind>.json). */
export interface RunProgressRecord extends JobRunProgress {
  kind: RunKind;
  pid: number;
  startedAt: string;
  /** done per minute in this run's own unit; null before anything is done */
  ratePerMin: number | null;
  /** seconds to go at that rate; null when unknown */
  etaSec: number | null;
  state: "running" | "finished";
}

/** What a reader sees: a "running" record whose process is gone is "ended". */
export type RunProgressView = Omit<RunProgressRecord, "state"> & { state: "running" | "finished" | "ended" };

export function runProgressPath(home: string, kind: RunKind): string {
  return `${home}/run-progress/${kind}.json`;
}

function writeAtomic(file: string, dir: string, body: unknown): boolean {
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(body) + "\n", "utf8");
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The run record of a kind, null when absent or unreadable. */
export function readRunProgress(home: string, kind: RunKind, isAlive: (pid: number) => boolean = pidAlive): RunProgressView | null {
  try {
    const r = JSON.parse(readFileSync(runProgressPath(home, kind), "utf8")) as RunProgressRecord;
    if (r.kind !== kind || typeof r.pid !== "number") return null;
    return r.state === "running" && !isAlive(r.pid) ? { ...r, state: "ended" } : r;
  } catch {
    return null;
  }
}

function cockpitJobPath(home: string, id: string): string {
  return `${home}/cockpit-jobs/${id}.json`;
}

/** Merge `progress` into the job record atomically; false when the record is absent or not running. */
export function writeJobProgress(home: string, id: string, progress: JobRunProgress): boolean {
  if (!/^[a-z0-9]+$/i.test(id)) return false;
  const file = cockpitJobPath(home, id);
  try {
    const rec = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (rec.state !== "running") return false;
    const tmp = `${file}.${process.pid}.tmp`;
    mkdirSync(`${home}/cockpit-jobs`, { recursive: true });
    writeFileSync(tmp, JSON.stringify({ ...rec, progress }) + "\n", "utf8");
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * A writer for a run of `kind`: feeds the shared run record and, when PAI_COCKPIT_JOB names a job,
 * that job's record too. One writer for the cockpit, CLI and daemon paths.
 */
export function jobProgressFromEnv(kind?: RunKind, env: NodeJS.ProcessEnv = process.env, home?: string): ProgressWriter | null {
  const id = env.PAI_COCKPIT_JOB;
  return id || kind ? createProgressWriter(id || null, { kind, home }) : null;
}

export function createProgressWriter(
  jobId: string | null,
  o: { home?: string; now?: () => number; minGapMs?: number; kind?: RunKind; pid?: number } = {},
): ProgressWriter {
  const home = o.home ?? paiHomeDir();
  const now = o.now ?? Date.now;
  const gap = o.minGapMs ?? PROGRESS_GAP_MS;
  const started = now();
  const cur: JobRunProgress = { phase: "scan", done: 0, total: 0, unit: o.kind === "embed" ? "chunks" : "projects", files: 0, chunks: 0, skipped: 0, carried: 0, current: "", elapsedSec: 0, updatedAt: "", movedAt: new Date(started).toISOString() };
  let lastWrite = -Infinity;
  let touched = false;
  const key = (): string => JSON.stringify([cur.done, cur.total, cur.files, cur.chunks, cur.skipped, cur.phase]);
  const flush = (t: number, state: "running" | "finished"): void => {
    cur.elapsedSec = Math.max(0, Math.round((t - started) / 1000));
    cur.updatedAt = new Date(t).toISOString();
    if (jobId) writeJobProgress(home, jobId, { ...cur });
    if (o.kind) {
      const min = (t - started) / 60_000;
      const rate = cur.done > 0 && min > 0 ? Math.round(cur.done / min) : null;
      const eta = rate && cur.total > cur.done ? Math.round(((cur.total - cur.done) / rate) * 60) : null;
      const rec: RunProgressRecord = { ...cur, kind: o.kind, pid: o.pid ?? process.pid, startedAt: new Date(started).toISOString(), ratePerMin: rate, etaSec: eta, state };
      writeAtomic(runProgressPath(home, o.kind), `${home}/run-progress`, rec);
    }
  };
  return {
    update(f) {
      const t = now();
      touched = true;
      const before = key();
      Object.assign(cur, f);
      if (key() !== before) cur.movedAt = new Date(t).toISOString();
      if (t - lastWrite < gap) return;
      lastWrite = t;
      flush(t, "running");
    },
    finish() {
      // a writer that never saw a counter (the daemon waiting on a child pass) leaves the child's record alone
      if (o.kind && touched) flush(now(), "finished");
    },
  };
}

/** The index-all loop's tick as writer fields. */
export function indexTick(w: ProgressWriter): (p: IndexAllProgress) => void {
  return (p) => w.update({ phase: "index", unit: "projects", ...p });
}
