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
import { listLessons, LESSON_STATES, type Lesson, type LessonState } from "../memory/lessons.js";
import { readFinishedRun, readRun, type FinishedRun, type RunState } from "../memory/run-state.js";
import { readRunProgress, type JobRunProgress, type RunKind, type RunProgressView } from "../memory/job-progress.js";
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
  /** Set when more than 1 % of the chunks belong to no project (daemon/orphan-check.ts). */
  orphans?: { orphaned: number; total: number; message: string } | null;
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
  /** A run marker whose process died without finishing; defaults to the stale marker under the PAI home. */
  deadRun?: () => RunState | null;
  /** The last finished run of a kind (run-state); defaults to the marker kept under the PAI home. */
  finished?: (kind: "embed" | "index") => FinishedRun | null;
  /** The shared run-progress record of a kind (every run: cockpit, CLI, daemon); defaults to the record under the PAI home. */
  runRecord?: (kind: RunKind) => RunProgressView | null;
  /** All lessons; defaults to the lesson files under the PAI home. */
  lessons?: () => Lesson[];
}

/** Lessons card: a count per state and the newest candidates (what waits for review), with their age. */
export function lessonsSummary(all: Lesson[], nowMs: number, top: number): { counts: Record<LessonState, number>; candidates: { id: string; title: string; ageSec: number | null }[] } {
  const counts = Object.fromEntries(LESSON_STATES.map((s) => [s, 0])) as Record<LessonState, number>;
  for (const l of all) counts[l.state]++;
  const at = (l: Lesson): number => Date.parse(l.created);
  const candidates = all
    .filter((l) => l.state === "candidate")
    .sort((a, b) => (at(b) || 0) - (at(a) || 0))
    .slice(0, top)
    .map((l) => ({ id: l.id, title: l.title, ageSec: Number.isNaN(at(l)) ? null : Math.max(0, Math.round((nowMs - at(l)) / 1000)) }));
  return { counts, candidates };
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

/** The run marker of a process that is gone (readRun ignores it); null when there is none or its process lives. */
function deadRunMarker(home: string): RunState | null {
  return readRun(home) ? null : readRun(home, () => true);
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

/** What the Index tile shows of a run record: counters, rate, ETA, and how long nothing moved. Null when the run is over. */
export interface RunTileView {
  kind: RunKind;
  state: "running" | "ended";
  pid: number;
  phase: string;
  unit: string;
  done: number;
  total: number;
  files: number;
  ratePerMin: number | null;
  etaSec: number | null;
  current: string;
  elapsedSec: number;
  updatedAt: string;
  stalledSec: number | null;
}

export function runTileView(r: RunProgressView | null, nowMs: number): RunTileView | null {
  if (!r || r.state === "finished") return null;
  const started = Date.parse(r.startedAt);
  return {
    kind: r.kind, state: r.state, pid: r.pid, phase: r.phase, unit: r.unit, done: r.done, total: r.total, files: r.files,
    ratePerMin: r.ratePerMin, etaSec: r.etaSec, current: r.current, updatedAt: r.updatedAt,
    elapsedSec: Math.max(0, Math.round((nowMs - (Number.isNaN(started) ? nowMs : started)) / 1000)),
    stalledSec: r.state === "running" ? stalledSeconds(r, nowMs) : null,
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
export function memoryJobProgress(home: string, j: LocalJobState, nowMs = Date.now()): { elapsedSec: number; tail: string; stalledSec?: number } | null {
  if (j.kind !== "memory" || j.state !== "running") return null;
  const started = Date.parse(j.startedAt ?? j.at);
  const stalled = stalledSeconds(j.progress, nowMs);
  return { elapsedSec: Math.max(0, Math.round((nowMs - (Number.isNaN(started) ? nowMs : started)) / 1000)), tail: logTailSince(memoryRunLog(home), 0), ...(stalled !== null ? { stalledSec: stalled } : {}) };
}

/** A run whose counters have not moved for longer than this shows "no progress for N s". */
export const JOB_STALL_SEC = 60;

/** Seconds since the counters last changed when that exceeds JOB_STALL_SEC (server clock, so the page needs no skew guard); null otherwise. */
export function stalledSeconds(p: JobRunProgress | undefined, nowMs: number): number | null {
  const moved = p ? Date.parse(p.movedAt) : NaN;
  if (Number.isNaN(moved)) return null;
  const sec = Math.round((nowMs - moved) / 1000);
  return sec > JOB_STALL_SEC ? sec : null;
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
  /** set on the kept tile of a finished run (until the next run of its kind starts) */
  finished: { outcome: string; reason: string; endedAt: number; durationSec: number } | null;
}

/** An ollama-style tag-tolerant model name: "name" and "name:latest" are the same model. */
export function sameModel(a: string, b: string): boolean {
  const n = (x: string): string => x.trim().replace(/:latest$/, "");
  return n(a) === n(b);
}

/** The last finished run as a tile: result, backlog done, duration, average rate. */
function finishedTile(f: FinishedRun): JobTile {
  const start = Date.parse(f.startedAt);
  const end = Date.parse(f.endedAt);
  const durationSec = Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, Math.round((end - start) / 1000));
  const total = f.kind === "embed" ? f.backlogStart : null;
  return {
    id: `last-${f.kind}`, kind: f.kind, name: `${f.kind} run`, phase: f.outcome, done: f.done, total,
    pct: total && total > 0 ? Math.min(100, (100 * f.done) / total) : null,
    rate: durationSec > 0 && f.done > 0 ? Math.round((f.done / durationSec) * 10) / 10 : null, etaSec: null, doneAt: null,
    lastProgressAt: end, stalled: false, series: [], by: f.by,
    finished: { outcome: f.outcome, reason: f.reason, endedAt: end, durationSec },
  };
}

/** The running memory run as a job tile, with its server-side progress history. */
function runTile(r: RunProgress, run: RunState, now: number, stallMs: number, len: number, moved: number | null): JobTile {
  const key = `${run.pid}|${run.startedAt}`;
  const h = runHistory.get(key) ?? [];
  const last = h[h.length - 1];
  if (!last || now > last.t) h.push({ t: now, done: run.done });
  while (h.length > len + 1) h.shift();
  runHistory.set(key, h);
  for (const k of runHistory.keys()) if (k !== key) runHistory.delete(k);
  let progressAt = Date.parse(run.startedAt);
  for (let i = 1; i < h.length; i++) if (h[i]!.done > h[i - 1]!.done) progressAt = h[i]!.t;
  // counters inside a project (files, chunks) count as progress, so one big project does not read stalled
  if (moved !== null && !Number.isNaN(moved) && moved > progressAt) progressAt = moved;
  const total = run.kind === "embed" ? run.backlogStart : null;
  return {
    id: `run-${run.kind}`, kind: run.kind, name: `${run.kind} run`, phase: run.kind, done: run.done, total,
    pct: total && total > 0 ? Math.min(100, (100 * run.done) / total) : null,
    rate: r.rate, etaSec: r.etaSec, doneAt: r.etaSec === null ? null : now + r.etaSec * 1000,
    lastProgressAt: progressAt, stalled: now - progressAt >= stallMs, series: rateSeries(h, len), by: run.by, finished: null,
  };
}

interface LastPass { at: number; chunks: number | null; result: string; by: string }

type Pass = { name: string; running: boolean; lastEnd: number; nextAt: number | null; failure: { at: number; error: string; attempts: number; gaveUp: boolean; retryAt: number | null } | null };

/** The last daemon answer and the current failure streak of the daemon call (a router-process cache). */
const lastGood: { d: DaemonMemory | null; fails: number; since: number | null } = { d: null, fails: 0, since: null };

/** Forget the kept data and failure streak (tests). */
export function resetMemoryStale(): void {
  lastGood.d = null;
  lastGood.fails = 0;
  lastGood.since = null;
}

const hhmmss = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

export async function cockpitMemoryPayload(deps: MemoryDeps = liveMemoryDeps()): Promise<unknown> {
  const L = cockpitLayout();
  const now = deps.now();
  const stallMs = L.memoryStallSecs * 1000;
  const fresh = await deps.daemon();
  // A failed daemon call keeps the last good data, marked stale; no data yet = nothing to keep.
  let fail: { failures: number; since: number; reason: string } | null = null;
  if (fresh) {
    lastGood.d = fresh;
    lastGood.fails = 0;
    lastGood.since = null;
  } else {
    lastGood.fails++;
    lastGood.since ??= now;
    fail = { failures: lastGood.fails, since: lastGood.since, reason: "daemon not answering" };
  }
  const d = fresh ?? lastGood.d;
  const bf = d?.status?.index.bindingFailure ?? null;
  if (!fail && bf) fail = { failures: bf.failures, since: bf.since ?? now, reason: `binding check failed: ${bf.reason}` };
  if (!fail && d?.status?.index.error) fail = { failures: 1, since: now, reason: `binding check: ${d.status.index.error}` };
  const s = d?.status ?? null;
  const run = deps.run();
  const files = s?.index.files ?? null;
  const chunks = s?.index.chunks ?? null;
  const embedded = s?.index.embedded ?? null;
  const rr = deps.runRecord ?? ((k: RunKind) => readRunProgress(deps.home, k));
  const runRec = { index: rr("index"), embed: rr("embed") };
  const runs = { index: runTileView(runRec.index, now), embed: runTileView(runRec.embed, now) };
  const liveEmbed = runRec.embed?.state === "running" && runRec.embed.total > 0 ? runRec.embed : null;
  let backlog = d?.embedBacklog ?? (chunks !== null && embedded !== null ? Math.max(0, chunks - embedded) : null);
  let coverage = s?.index.coverage ?? null;
  // the daemon samples its counts slowly: while an embed run reports, the coverage follows its counters
  let embeddedNow = embedded;
  if (liveEmbed && chunks !== null && chunks > 0) {
    backlog = Math.max(0, liveEmbed.total - liveEmbed.done);
    embeddedNow = Math.max(0, chunks - backlog);
    coverage = embeddedNow / chunks;
  }
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
      series: rateSeries(j.history ?? [], L.memoryHistoryLen), by: null, finished: null,
    };
  });
  if (run && progress) jobs.unshift(runTile(progress, run, now, stallMs, L.memoryHistoryLen, runRec[run.kind]?.state === "running" ? Date.parse(runRec[run.kind]!.movedAt) : null));
  else runHistory.clear();
  const starting = !run ? runningMemoryJob(deps.home, now, L.memoryStartGraceSecs * 1000) : null;
  if (starting) {
    jobs.unshift({ id: "run-starting", kind: starting.what ?? "embed", name: `${starting.what ?? "run"} run`, phase: "starting", done: 0, total: null, pct: null, rate: null, etaSec: null, doneAt: null, lastProgressAt: null, stalled: false, series: [], by: "cockpit", finished: null });
  }
  const readFin = deps.finished ?? ((k) => readFinishedRun(k, deps.home));
  const fins: FinishedRun[] = [];
  const dead = !run ? (deps.deadRun ?? (() => deadRunMarker(deps.home)))() : null;
  for (const k of ["embed", "index"] as const) {
    let f = run?.kind === k ? null : readFin(k);
    // a run that died without recording its end is shown once, in its Last-run card, unless a later finish superseded it
    if (dead && dead.kind === k && (!f || Date.parse(f.endedAt) < Date.parse(dead.startedAt))) {
      f = { kind: k, by: dead.by, startedAt: dead.startedAt, endedAt: dead.updatedAt, backlogStart: dead.backlogStart, done: dead.done, outcome: "failed", reason: `ended unexpectedly at ${hhmmss(Date.parse(dead.updatedAt))}` };
    }
    if (f) fins.push(f);
  }
  for (const f of fins) jobs.push(finishedTile(f));
  const embedLog = (deps.embedPasses ?? (() => []))();
  const lastLogged = embedLog.length ? embedLog[embedLog.length - 1]! : null;
  const passes = ((s?.passes ?? []) as Pass[]).filter((p) => p.name !== "vault").map((p) => {
    const kind = p.name === "embed" || p.name === "index" ? p.name : null;
    // the newest of: the daemon's scheduled pass, the embed pass log, a run started from the cockpit or CLI
    let last: LastPass | null = p.lastEnd ? { at: p.lastEnd, chunks: null, result: "ok", by: "nightly" } : null;
    const dp = kind === "embed" ? d?.lastEmbedPass : kind === "index" ? d?.lastIndexPass : null;
    if (dp && (!last || dp.at >= last.at)) last = { at: dp.at, chunks: kind === "embed" ? (dp as { embedded: number }).embedded : (dp as { chunks: number }).chunks, result: "outcome" in dp ? dp.outcome : "done", by: "nightly" };
    if (kind === "embed" && lastLogged && (!last || lastLogged.end >= last.at)) last = { at: lastLogged.end, chunks: lastLogged.embedded, result: lastLogged.stopReason, by: "nightly" };
    const f = fins.find((x) => x.kind === kind);
    const fe = f ? Date.parse(f.endedAt) : NaN;
    if (f && !Number.isNaN(fe) && (!last || fe >= last.at)) last = { at: fe, chunks: f.done, result: f.reason ? `${f.outcome}: ${f.reason}` : f.outcome, by: f.by === "daemon" ? "nightly" : f.by };
    return {
      name: p.name, state: p.failure ? "failed" : p.running ? "running" : "ok", lastEnd: last?.at ?? (p.lastEnd || null), nextAt: p.nextAt, failure: p.failure, last,
      detail: p.name === "embed" && lastLogged ? { embedded: lastLogged.embedded, backlogLeft: lastLogged.backlogLeft, stopReason: lastLogged.stopReason, note: lastLogged.detail ?? null, at: lastLogged.end } : null,
    };
  });
  const model = s?.backend.model ?? null;
  const loadedAll = s?.backend.loaded ?? [];
  const loaded = model ? loadedAll.find((m) => sameModel(m.name, model)) ?? null : null;
  const stalled = jobs.find((j) => j.stalled);
  // Degraded = serving last-good data over a failing source. The payload says so (transient) and reads red; the page's
  // hold-last-good keeps its previous good payload on screen for holdLastGoodSecs and only then shows this one.
  const orphans = d?.orphans ?? null;
  const baseLevel: Level = fail ? "red" : s?.level ?? (d ? "amber" : "red");
  const level: Level = orphans && baseLevel === "green" ? "amber" : baseLevel;
  return {
    at: now,
    ...(fail ? { transient: fail.reason } : {}),
    staleSince: fail ? fail.since : null,
    failures: fail?.failures ?? 0,
    title: L.memoryTitle,
    daemon: fresh !== null,
    orphans,
    level: stalled && level === "green" ? "red" : level,
    reason: fail ? (d === null ? fail.reason : `${fail.reason} since ${hhmmss(fail.since)}`)
      : stalled && level === "green" ? `job ${stalled.name} stalled` : orphans && baseLevel === "green" ? orphans.message : s?.reason ?? (d ? "status not sampled yet" : "daemon not answering"),
    stallSecs: L.memoryStallSecs,
    counts: { files, chunks, embedded: embeddedNow, backlog, coverage, coverageLevel, exact: s?.index.countsExact ?? false },
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
      alsoLoaded: loadedAll.filter((m) => m !== loaded).map((m) => m.name),
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
    runs,
    lessons: lessonsSummary((deps.lessons ?? (() => listLessons()))(), now, L.memoryLessonsTop),
    // the cockpit job that has not produced its run marker yet: the card is busy from the click
    starting: starting ? { jobId: starting.id } : null,
    lastRun: job && job.state !== "running" ? { op: job.what ?? "", ok: job.state === "done", message: job.message, at: job.at } : null,
  };
}
