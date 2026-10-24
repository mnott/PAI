/**
 * job-progress.ts — live progress of an index or embed run, written into its cockpit job record
 * (<home>/cockpit-jobs/<id>.json, field `progress`).
 *
 * The cockpit spawns the run with PAI_COCKPIT_JOB=<id>; the run feeds its own counters in here and
 * the cockpit shows them on its normal poll. The writer merges into the existing record (the
 * router's pid and message stay), only while the record says "running", and replaces the file
 * atomically. The router's final write (done/failed/interrupted) carries no `progress`, so the
 * end state replaces it.
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
  /** display name of the project in hand, "" when none */
  current: string;
  elapsedSec: number;
  /** ISO time of this write */
  updatedAt: string;
  /** ISO time the counters last changed (a hung run stops moving this) */
  movedAt: string;
}

export type ProgressFields = Partial<Omit<JobRunProgress, "elapsedSec" | "updatedAt" | "movedAt">>;

export interface ProgressWriter {
  /** Set the counters; writes at most once per `minGapMs` (the first call always writes). */
  update(f: ProgressFields): void;
}

export const PROGRESS_GAP_MS = 3000;

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

/** A writer for the cockpit job named by PAI_COCKPIT_JOB; null when this run was not started by the cockpit. */
export function jobProgressFromEnv(env: NodeJS.ProcessEnv = process.env): ProgressWriter | null {
  const id = env.PAI_COCKPIT_JOB;
  return id ? createProgressWriter(id) : null;
}

export function createProgressWriter(
  jobId: string,
  o: { home?: string; now?: () => number; minGapMs?: number } = {},
): ProgressWriter {
  const home = o.home ?? paiHomeDir();
  const now = o.now ?? Date.now;
  const gap = o.minGapMs ?? PROGRESS_GAP_MS;
  const started = now();
  const cur: JobRunProgress = { phase: "scan", done: 0, total: 0, unit: "projects", files: 0, chunks: 0, skipped: 0, current: "", elapsedSec: 0, updatedAt: "", movedAt: new Date(started).toISOString() };
  let lastWrite = -Infinity;
  return {
    update(f) {
      const t = now();
      const before = JSON.stringify([cur.done, cur.total, cur.files, cur.chunks, cur.skipped, cur.phase]);
      Object.assign(cur, f);
      if (JSON.stringify([cur.done, cur.total, cur.files, cur.chunks, cur.skipped, cur.phase]) !== before) cur.movedAt = new Date(t).toISOString();
      if (t - lastWrite < gap) return;
      lastWrite = t;
      cur.elapsedSec = Math.max(0, Math.round((t - started) / 1000));
      cur.updatedAt = new Date(t).toISOString();
      writeJobProgress(home, jobId, { ...cur });
    },
  };
}
