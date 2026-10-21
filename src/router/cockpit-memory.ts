/**
 * cockpit-memory.ts — the cockpit's Memory section: the /cockpit/memory payload.
 *
 * The data is the daemon's own (DashboardState, answered over IPC as
 * `memory_dashboard`: counts, binding, backend, jobs, passes, last pass
 * records, nightly schedule); this module only reshapes it and adds the one
 * running index/embed run (src/memory/run-state.ts) with its progress.
 */

import { readdirSync } from "node:fs";
import type { DashboardState } from "../daemon/dashboard.js";
import { PaiClient } from "../daemon/ipc-client.js";
import { loadConfig } from "../daemon/config.js";
import { paiHomeDir } from "../config/pai-home.js";
import { readRun, type RunState } from "../memory/run-state.js";
import { cockpitLayout } from "./cockpit-layout.js";
import { logTailSince, readCockpitJob, type LocalJobState } from "./cockpit-actions.js";

type Status = ReturnType<DashboardState["status"]>;

/** What the daemon answers to `memory_dashboard` (daemon/dashboard-live.ts memoryDashboard). */
export interface DaemonMemory {
  status: Status | null;
  embedBacklog: number | null;
  maintenanceHour: number | null;
  indexIntervalSecs: number;
  embedIntervalSecs: number;
  embedMaxMinutes: number | null;
  lastIndexPass: { at: number; durationMs: number; projects: number; files: number; chunks: number } | null;
  lastEmbedPass: { at: number; durationMs?: number; outcome: string; embedded: number; reason?: string } | null;
}

export interface MemoryDeps {
  /** The daemon's memory status; null when the daemon does not answer. */
  daemon: () => Promise<DaemonMemory | null>;
  /** The running index/embed run, null when none. */
  run: () => RunState | null;
  /** PAI home for the run log and job files. */
  home: string;
  now: () => number;
}

/** The run's log file (the cockpit starts a run with its output here). */
export function memoryRunLog(home: string): string {
  return `${home}/state/memory-run.log`;
}

/** The daemon's answer over its socket; null when it is down or too old to know the method. */
export async function fetchDaemonMemory(): Promise<DaemonMemory | null> {
  try {
    return (await new PaiClient(loadConfig().socketPath).call("memory_dashboard", {}, 5000)) as DaemonMemory;
  } catch {
    return null;
  }
}

export function liveMemoryDeps(): MemoryDeps {
  const home = paiHomeDir();
  return { daemon: fetchDaemonMemory, run: () => readRun(home), home, now: Date.now };
}

export interface RunProgress {
  kind: "embed" | "index";
  /** cli | cockpit | daemon */
  by: string;
  pid: number;
  jobId: string;
  startedAt: string;
  elapsedSec: number;
  /** chunks embedded so far; backlog when it began (null = unknown) */
  done: number;
  backlogStart: number | null;
  /** chunks per second since the start; null before the first chunk */
  rate: number | null;
  etaSec: number | null;
  tail: string;
  /** the daemon's own pass cannot be stopped from here */
  stoppable: boolean;
}

/** Progress fields of a run from its marker: elapsed, rate (done over the time up to the last update), ETA, log tail. */
export function runProgress(r: RunState, nowMs: number, home: string): RunProgress {
  const start = Date.parse(r.startedAt);
  const upd = Date.parse(r.updatedAt);
  const elapsedSec = Math.max(0, Math.round((nowMs - start) / 1000));
  const spanSec = (Number.isNaN(upd) ? nowMs : upd) - start;
  const rate = r.done > 0 && spanSec > 0 ? r.done / (spanSec / 1000) : null;
  const left = r.backlogStart !== null ? Math.max(0, r.backlogStart - r.done) : null;
  return {
    kind: r.kind,
    by: r.by,
    pid: r.pid,
    jobId: r.jobId,
    startedAt: r.startedAt,
    elapsedSec,
    done: r.done,
    backlogStart: r.backlogStart,
    rate: rate === null ? null : Math.round(rate * 10) / 10,
    etaSec: rate !== null && left !== null ? Math.round(left / rate) : null,
    tail: r.by === "cockpit" ? logTailSince(memoryRunLog(home), 0) : "",
    stoppable: r.by !== "daemon",
  };
}

/** The newest memory job file (any state): its message is the result shown on the card. */
export function latestMemoryJob(home: string): LocalJobState | null {
  let best: LocalJobState | null = null;
  try {
    for (const f of readdirSync(`${home}/cockpit-jobs`)) {
      if (!f.endsWith(".json")) continue;
      const j = readCockpitJob(home, f.slice(0, -5));
      if (j?.kind === "memory" && (!best || Date.parse(j.at) > Date.parse(best.at))) best = j;
    }
  } catch {
    /* no jobs yet */
  }
  return best;
}

/** A memory job that is still marked running and young enough to be real (covers the gap before the run's marker exists). */
export function runningMemoryJob(home: string, nowMs: number, graceMs: number): LocalJobState | null {
  const j = latestMemoryJob(home);
  return j && j.state === "running" && nowMs - Date.parse(j.startedAt ?? j.at) < graceMs ? j : null;
}

/** Progress of a running memory job for /cockpit/job. */
export function memoryJobProgress(home: string, j: LocalJobState, nowMs = Date.now()): { elapsedSec: number; tail: string } | null {
  if (j.kind !== "memory" || j.state !== "running") return null;
  const started = Date.parse(j.startedAt ?? j.at);
  return { elapsedSec: Math.max(0, Math.round((nowMs - (Number.isNaN(started) ? nowMs : started)) / 1000)), tail: logTailSince(memoryRunLog(home), 0) };
}

type Level = "green" | "amber" | "red";

export async function cockpitMemoryPayload(deps: MemoryDeps = liveMemoryDeps()): Promise<unknown> {
  const L = cockpitLayout();
  const now = deps.now();
  const d = await deps.daemon();
  const s = d?.status ?? null;
  const run = deps.run();
  const files = s?.index.files ?? null;
  const chunks = s?.index.chunks ?? null;
  const embedded = s?.index.embedded ?? null;
  const backlog = d?.embedBacklog ?? (chunks !== null && embedded !== null ? Math.max(0, chunks - embedded) : null);
  const coverage = s?.index.coverage ?? null;
  const coverageLevel: Level | null = coverage === null ? null : coverage < L.memoryCoverageBad ? "red" : coverage < L.memoryCoverageWarn ? "amber" : "green";
  const job = latestMemoryJob(deps.home);
  return {
    at: now,
    title: L.memoryTitle,
    daemon: d !== null,
    level: s?.level ?? (d ? "amber" : "red"),
    reason: s?.reason ?? (d ? "status not sampled yet" : "daemon not answering"),
    counts: { files, chunks, embedded, backlog, coverage, coverageLevel, exact: s?.index.countsExact ?? false },
    binding: s ? { mismatch: s.index.mismatch, hint: s.index.hint, error: s.index.error } : null,
    backend: s ? { id: s.backend.id, model: s.backend.model, dims: s.index.configured.dims, available: s.backend.available, reason: s.backend.reason, loaded: s.backend.loaded } : null,
    jobs: s?.jobs ?? [],
    passes: s?.passes ?? [],
    lastIndex: d?.lastIndexPass ? { at: d.lastIndexPass.at, durationSec: Math.round(d.lastIndexPass.durationMs / 1000), files: d.lastIndexPass.files, chunks: d.lastIndexPass.chunks } : null,
    lastEmbed: d?.lastEmbedPass
      ? { at: d.lastEmbedPass.at, durationSec: d.lastEmbedPass.durationMs === undefined ? null : Math.round(d.lastEmbedPass.durationMs / 1000), chunks: d.lastEmbedPass.embedded, outcome: d.lastEmbedPass.outcome, reason: d.lastEmbedPass.reason ?? null }
      : null,
    schedule: d ? { maintenanceHour: d.maintenanceHour, indexIntervalSecs: d.indexIntervalSecs, embedIntervalSecs: d.embedIntervalSecs } : null,
    run: run ? runProgress(run, now, deps.home) : null,
    // the cockpit job that has not produced its run marker yet: the card is busy from the click
    starting: !run && runningMemoryJob(deps.home, now, L.memoryStartGraceSecs * 1000) ? { jobId: runningMemoryJob(deps.home, now, L.memoryStartGraceSecs * 1000)!.id } : null,
    lastRun: job && job.state !== "running" ? { op: job.what ?? "", ok: job.state === "done", message: job.message, at: job.at } : null,
  };
}
