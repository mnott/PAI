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
import { readEmbedPasses, type EmbedPassLogEntry } from "../memory/embed-pass.js";
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
  /** The recorded embed passes (oldest first); defaults to the pass log under the PAI home. */
  embedPasses?: () => EmbedPassLogEntry[];
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
  return { daemon: fetchDaemonMemory, run: () => readRun(home), home, now: Date.now, embedPasses: () => readEmbedPasses() };
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

interface Sample { t: number; done: number }

/** Progress samples of the runs seen by this router (key = run identity), bounded; the old page kept the same per job. */
const runHistory = new Map<string, Sample[]>();

/** Per-interval rate (units/s) between consecutive samples, newest last, at most `len` values. */
export function rateSeries(samples: Sample[], len: number): number[] {
  const r: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i]!.t - samples[i - 1]!.t) / 1000;
    r.push(dt > 0 ? Math.max(0, (samples[i]!.done - samples[i - 1]!.done) / dt) : 0);
  }
  return r.slice(-len).map((v) => Math.round(v * 100) / 100);
}

export interface JobTile {
  id: string;
  /** reembed (daemon job) | embed | index (running memory run) */
  kind: string;
  name: string;
  phase: string;
  done: number;
  /** backlog at start for an embed run; null when unknown (index run) */
  total: number | null;
  pct: number | null;
  rate: number | null;
  etaSec: number | null;
  /** epoch ms the job is expected to be done (now + ETA) */
  doneAt: number | null;
  lastProgressAt: number | null;
  stalled: boolean;
  /** chunks/s per sample interval over the kept window, oldest first */
  series: number[];
  by: string | null;
}

/** The running memory run as a job tile, with its server-side progress history. */
function runTile(r: RunProgress, run: RunState, now: number, stallMs: number, len: number): JobTile {
  const key = `${run.pid}|${run.startedAt}`;
  const h = runHistory.get(key) ?? [];
  const last = h[h.length - 1];
  if (!last || now > last.t) h.push({ t: now, done: run.done });
  while (h.length > len + 1) h.shift();
  runHistory.set(key, h);
  for (const k of runHistory.keys()) if (k !== key) runHistory.delete(k);
  let progressAt = Date.parse(run.startedAt);
  for (let i = 1; i < h.length; i++) if (h[i]!.done > h[i - 1]!.done) progressAt = h[i]!.t;
  const total = run.kind === "embed" ? run.backlogStart : null;
  return {
    id: `run-${run.kind}`, kind: run.kind, name: `${run.kind} run`, phase: run.kind, done: run.done, total,
    pct: total && total > 0 ? Math.min(100, (100 * run.done) / total) : null,
    rate: r.rate, etaSec: r.etaSec, doneAt: r.etaSec === null ? null : now + r.etaSec * 1000,
    lastProgressAt: progressAt, stalled: now - progressAt >= stallMs, series: rateSeries(h, len), by: run.by,
  };
}

type Pass = { name: string; running: boolean; lastEnd: number; nextAt: number | null; failure: { at: number; error: string; attempts: number; gaveUp: boolean; retryAt: number | null } | null };

export async function cockpitMemoryPayload(deps: MemoryDeps = liveMemoryDeps()): Promise<unknown> {
  const L = cockpitLayout();
  const now = deps.now();
  const stallMs = L.memoryStallSecs * 1000;
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
  const progress = run ? runProgress(run, now, deps.home) : null;
  const jobs: JobTile[] = (s?.jobs ?? []).map((j) => {
    const pastProgress = now - j.lastProgressAt;
    return {
      id: `job-${j.name}`, kind: "reembed", name: j.name, phase: j.phase, done: j.done, total: j.total,
      pct: j.total > 0 ? Math.min(100, (100 * j.done) / j.total) : null,
      rate: j.rate, etaSec: j.etaSecs, doneAt: j.etaSecs === null ? null : now + j.etaSecs * 1000,
      lastProgressAt: j.lastProgressAt, stalled: j.phase !== "done" && pastProgress >= stallMs,
      series: rateSeries(j.history ?? [], L.memoryHistoryLen), by: null,
    };
  });
  if (run && progress) jobs.push(runTile(progress, run, now, stallMs, L.memoryHistoryLen));
  else runHistory.clear();
  const embedLog = (deps.embedPasses ?? (() => []))();
  const lastLogged = embedLog.length ? embedLog[embedLog.length - 1]! : null;
  const passes = ((s?.passes ?? []) as Pass[]).filter((p) => p.name !== "vault").map((p) => ({
    name: p.name, state: p.failure ? "failed" : p.running ? "running" : "ok", lastEnd: p.lastEnd || null, nextAt: p.nextAt, failure: p.failure,
    detail: p.name === "embed" && lastLogged ? { embedded: lastLogged.embedded, backlogLeft: lastLogged.backlogLeft, stopReason: lastLogged.stopReason, note: lastLogged.detail ?? null, at: lastLogged.end } : null,
  }));
  const loaded = s?.backend.loaded?.[0] ?? null;
  const stalled = jobs.find((j) => j.stalled);
  const level: Level = s?.level ?? (d ? "amber" : "red");
  return {
    at: now,
    title: L.memoryTitle,
    daemon: d !== null,
    level: stalled && level === "green" ? "red" : level,
    reason: stalled && level === "green" ? `job ${stalled.name} stalled` : s?.reason ?? (d ? "status not sampled yet" : "daemon not answering"),
    stallSecs: L.memoryStallSecs,
    counts: { files, chunks, embedded, backlog, coverage, coverageLevel, exact: s?.index.countsExact ?? false },
    segments: s?.index.segments ?? (embedded !== null && backlog !== null ? { fresh: 0, old: embedded, missing: backlog } : null),
    reembedding: (s?.index.segments?.fresh ?? 0) > 0 && (s?.jobs ?? []).some((j) => j.phase !== "done"),
    binding: s ? {
      mismatch: s.index.mismatch, hint: s.index.hint, error: s.index.error,
      bound: s.index.binding ? { backend: s.index.binding.backend, model: s.index.binding.model ?? null } : null,
      configured: { backend: s.index.configured.backend, model: s.index.configured.model, dims: s.index.configured.dims },
    } : null,
    backend: s ? {
      id: s.backend.id, model: s.backend.model, dims: s.index.configured.dims, available: s.backend.available, reason: s.backend.reason, loaded: s.backend.loaded,
      loadedModel: loaded ? loaded.name : null, gpuShare: loaded ? loaded.gpuShare : null,
    } : null,
    daemonInfo: s ? s.daemon : null,
    jobs,
    passes,
    lastIndex: d?.lastIndexPass ? { at: d.lastIndexPass.at, durationSec: Math.round(d.lastIndexPass.durationMs / 1000), files: d.lastIndexPass.files, chunks: d.lastIndexPass.chunks } : null,
    lastEmbed: d?.lastEmbedPass
      ? { at: d.lastEmbedPass.at, durationSec: d.lastEmbedPass.durationMs === undefined ? null : Math.round(d.lastEmbedPass.durationMs / 1000), chunks: d.lastEmbedPass.embedded, outcome: d.lastEmbedPass.outcome, reason: d.lastEmbedPass.reason ?? null }
      : null,
    schedule: d ? { maintenanceHour: d.maintenanceHour, indexIntervalSecs: d.indexIntervalSecs, embedIntervalSecs: d.embedIntervalSecs } : null,
    run: progress,
    // the cockpit job that has not produced its run marker yet: the card is busy from the click
    starting: !run && runningMemoryJob(deps.home, now, L.memoryStartGraceSecs * 1000) ? { jobId: runningMemoryJob(deps.home, now, L.memoryStartGraceSecs * 1000)!.id } : null,
    lastRun: job && job.state !== "running" ? { op: job.what ?? "", ok: job.state === "done", message: job.message, at: job.at } : null,
  };
}
