/**
 * dashboard.ts — read-only memory status dashboard served by the daemon.
 *
 * Embedding and index passes run unattended for hours; a crashed embed pass
 * went unnoticed for 7 h. This puts what is running and whether it is healthy
 * on one page (and /api/status) reachable from a phone on the tailnet.
 *
 * Nothing here computes anything per request: a background tick (30 s) samples
 * the job table, binding and backend health, and real row counts are refreshed
 * at most every 5 min. Requests only assemble the cached values.
 */

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import type { EmbeddingBinding, StorageBackend } from "../storage/interface.js";
import type { EmbeddingBackend } from "../memory/backends/types.js";
import { bindingMatches, mismatchReason } from "../memory/embedding-binding.js";
import { DASHBOARD_HTML } from "./dashboard-page.js";
import type { DashboardConfig } from "./config.js";
import { paiHomePath } from "../config/pai-home.js";

const TICK_MS = 30_000;
const COUNTS_TTL_MS = 5 * 60_000;
const STALL_MS = 5 * 60_000;
const RATE_WINDOW_MS = 5 * 60_000;
const EXACT_TIMEOUT_MS = 20_000;
const HISTORY_MAX = 120; // 1 h of 30 s samples
const HISTORY_PERSIST_MS = 30_000; // write at most every 30s
const HISTORY_PRUNE_AGE_MS = 2 * 60 * 60_000; // 2 hours

export type Level = "green" | "amber" | "red";
const RANK: Record<Level, number> = { green: 0, amber: 1, red: 2 };
const worst = (ls: Level[]): Level => ls.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "green" as Level);

// ---------------------------------------------------------------------------
// Host check (DNS-rebinding guard)
// ---------------------------------------------------------------------------

/** Host header without port; IPv6 literals keep their brackets stripped. */
function hostName(header: string | undefined): string {
  if (!header) return "";
  const h = header.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]"));
  return h.replace(/:\d+$/, "");
}

export function hostAllowed(header: string | undefined, allowed: Iterable<string>): boolean {
  const h = hostName(header);
  return h !== "" && new Set([...allowed].map((a) => a.toLowerCase())).has(h);
}

/** Tailnet DNS name and IPs of this machine from `tailscale status --json`; empty when unavailable. */
export async function tailnetHosts(): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)("tailscale", ["status", "--json"], { timeout: 3000 });
    const self = (JSON.parse(stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }).Self;
    return [self?.DNSName?.replace(/\.$/, ""), ...(self?.TailscaleIPs ?? [])].filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sources (everything the dashboard reads; faked in tests)
// ---------------------------------------------------------------------------

export interface Counts {
  files: number;
  chunks: number;
  /** null when not known (SQLite estimate). */
  embedded: number | null;
}

export interface RawJob {
  name: string;
  state: Record<string, unknown>;
}

export interface LoadedModel {
  name: string;
  size: number;
  sizeVram: number;
}

export interface PassSnapshot {
  name: string;
  running: boolean;
  /** Epoch ms of the last successful pass end, 0 = none since start. */
  lastEnd: number;
  failure: { at: number; error: string; attempts: number; gaveUp: boolean; retryAt: number | null } | null;
  nextAt: number | null;
}

export interface DashboardSource {
  storage: string;
  daemon(): { pid: number; startTime: number; version: string };
  /** Cheap (catalog statistics); used at start and between real refreshes. */
  estimate(): Promise<Counts>;
  /** Real counts; may be slow, must be bounded by the implementation. */
  exact(): Promise<Counts>;
  binding(): Promise<EmbeddingBinding | null>;
  jobs(): Promise<RawJob[]>;
  backend(): EmbeddingBackend;
  loadedModels(): Promise<LoadedModel[] | null>;
  passes(): PassSnapshot[];
}

// ---------------------------------------------------------------------------
// Cached state: tick() samples, status() assembles
// ---------------------------------------------------------------------------

interface JobSample {
  t: number;
  done: number;
}

interface PersistedHistory {
  jobs: Record<string, JobSample[]>;
}

interface Cache {
  counts: (Counts & { exact: boolean; at: number }) | null;
  binding: EmbeddingBinding | null;
  bindingError: string | null;
  jobs: RawJob[];
  backend: { ok: boolean; reason: string } | null;
  loaded: LoadedModel[] | null;
}

export interface JobView {
  name: string;
  phase: "prepare" | "carry" | "embed" | "finish" | "done";
  done: number;
  total: number;
  /** Rows per second over the last minutes; null until two samples exist. */
  rate: number | null;
  etaSecs: number | null;
  lastProgressAt: number;
  stalled: boolean;
  level: Level;
  /** Last hour of samples (oldest first); the page derives the per-interval rate from it. */
  history: JobSample[];
}

export interface IndexSegments {
  /** Vectors from the new backend (re-embed done count), 0 when no re-embed runs. */
  fresh: number;
  /** Embedded by the old backend, still to replace. */
  old: number;
  missing: number;
}

/** Stacked-bar numbers: done/embedded/total in, three non-negative segments out. `done` null = no re-embed. */
export function indexSegments(total: number, embedded: number, done: number | null): IndexSegments {
  const missing = Math.max(0, total - embedded);
  if (done === null) return { fresh: 0, old: Math.max(0, embedded), missing };
  return { fresh: done, old: Math.max(0, embedded - done), missing };
}

function phaseOf(s: Record<string, unknown>): JobView["phase"] {
  if (s.finished) return "done";
  if (s.embedDone) return "finish";
  if (s.carryDone) return "embed";
  if (s.prepared) return "carry";
  return "prepare";
}

export class DashboardState {
  private cache: Cache = { counts: null, binding: null, bindingError: null, jobs: [], backend: null, loaded: null };
  private samples = new Map<string, { list: JobSample[]; history: JobSample[]; progressAt: number; lastDone: number }>();
  private lastExactAt: number;
  private exactRunning = false;
  private lastPersistAt: number;
  private historyPath: string;

  constructor(private src: DashboardSource, private now: () => number = Date.now, historyPath?: string) {
    this.lastExactAt = now();
    this.lastPersistAt = now();
    this.historyPath = historyPath ?? paiHomePath("state", "dashboard-history.json");
  }

  async loadHistory(): Promise<void> {
    try {
      if (!existsSync(this.historyPath)) return;
      const content = await readFile(this.historyPath, "utf8");
      const data = JSON.parse(content) as PersistedHistory;
      const now = this.now();
      for (const [name, hist] of Object.entries(data.jobs ?? {})) {
        const pruned = hist.filter((s) => now - s.t <= HISTORY_PRUNE_AGE_MS);
        if (pruned.length > 0) {
          const s = this.samples.get(name) ?? { list: [], history: [], progressAt: now, lastDone: 0 };
          s.history = pruned.slice(-HISTORY_MAX);
          this.samples.set(name, s);
        }
      }
    } catch {
      // silently ignore load errors
    }
  }

  private async persistHistory(): Promise<void> {
    const t = this.now();
    if (t - this.lastPersistAt < HISTORY_PERSIST_MS) return;
    this.lastPersistAt = t;

    try {
      const jobs: Record<string, JobSample[]> = {};
      for (const [name, s] of this.samples) {
        if (s.history.length > 0) jobs[name] = s.history;
      }
      const data: PersistedHistory = { jobs };
      const dir = join(this.historyPath, "..");
      await mkdir(dir, { recursive: true });
      const tmp = this.historyPath + ".tmp";
      await writeFile(tmp, JSON.stringify(data), "utf8");
      await writeFile(this.historyPath, JSON.stringify(data), "utf8");
    } catch {
      // silently ignore persist errors
    }
  }

  /** Sample everything once. Never throws: a failing source shows up in the status instead. */
  async tick(): Promise<void> {
    const t = this.now();
    const c = this.cache;
    const run = async <T>(f: () => Promise<T>, onErr: (e: unknown) => void): Promise<T | undefined> => {
      try { return await f(); } catch (e) { onErr(e); return undefined; }
    };

    if (!c.counts) {
      const est = await run(() => this.src.estimate(), () => {});
      if (est) c.counts = { ...est, exact: false, at: t };
    }
    this.refreshExact(t);

    c.bindingError = null;
    const b = await run(() => this.src.binding(), (e) => { c.bindingError = e instanceof Error ? e.message : String(e); });
    if (b !== undefined) c.binding = b;

    const jobs = await run(() => this.src.jobs(), () => {});
    if (jobs) {
      c.jobs = jobs;
      for (const j of jobs) this.sample(j, t);
    }

    const be = this.src.backend();
    c.backend = (await run(() => be.available(), () => {})) ?? { ok: false, reason: "availability probe threw" };
    c.loaded = be.id.startsWith("ollama") ? (await run(() => this.src.loadedModels(), () => {})) ?? null : null;

    await this.persistHistory();
  }

  /** Real counts at most every COUNTS_TTL_MS, in the background; the tick never waits for them. */
  private refreshExact(t: number): void {
    if (this.exactRunning || t - this.lastExactAt < COUNTS_TTL_MS) return;
    this.exactRunning = true;
    this.lastExactAt = t;
    this.src.exact().then(
      (n) => { this.cache.counts = { ...n, exact: true, at: this.now() }; },
      () => {},
    ).finally(() => { this.exactRunning = false; });
  }

  private sample(j: RawJob, t: number): void {
    const done = Number(j.state.done ?? 0);
    const s = this.samples.get(j.name) ?? { list: [], history: [], progressAt: t, lastDone: done };
    if (done !== s.lastDone) { s.progressAt = t; s.lastDone = done; }
    s.list.push({ t, done });
    s.history.push({ t, done });
    if (s.history.length > HISTORY_MAX) s.history.shift();
    while (s.list.length > 2 && t - s.list[0].t > RATE_WINDOW_MS) s.list.shift();
    this.samples.set(j.name, s);
  }

  private jobView(j: RawJob, t: number): JobView {
    const total = Number(j.state.total ?? 0);
    const done = Number(j.state.done ?? 0);
    const phase = phaseOf(j.state);
    const s = this.samples.get(j.name);
    const first = s?.list[0];
    const last = s?.list[s.list.length - 1];
    const rate = first && last && last.t > first.t ? Math.max(0, (last.done - first.done) / ((last.t - first.t) / 1000)) : null;
    const etaSecs = rate && rate > 0 && total > done ? Math.round((total - done) / rate) : null;
    // Progress time = when `done` last changed as seen by this daemon; first sight if never.
    const lastProgressAt = s?.progressAt ?? t;
    const stalled = phase !== "done" && t - lastProgressAt >= STALL_MS;
    return { name: j.name, phase, done, total, rate, etaSecs, lastProgressAt, stalled, level: stalled ? "red" : "green", history: s?.history ?? [] };
  }

  status() {
    const t = this.now();
    const c = this.cache;
    const d = this.src.daemon();
    const be = this.src.backend();

    const jobs = c.jobs.filter((j) => Object.keys(j.state).length > 0).map((j) => this.jobView(j, t));

    const mismatch = !!c.binding && !bindingMatches(c.binding, be);
    const counts = c.counts;

    // Check for active re-embed job for the configured backend
    const reembedJob = this.findReembedJob(c.jobs, be.id);
    const reembedActive = reembedJob && !["done"].includes(phaseOf(reembedJob.state));

    const indexLevel: Level = (mismatch && !reembedActive) || c.bindingError ? "red" : reembedActive ? "amber" : "green";
    const backendLevel: Level = c.backend && !c.backend.ok ? "red" : c.backend ? "green" : "amber";

    const passes = this.src.passes().map((p) => ({
      ...p,
      level: (p.failure ? "red" : "green") as Level,
    }));

    let hint: string | null = null;
    if (mismatch && c.binding) {
      if (reembedActive) {
        const jobBackend = this.deriveBackendFromJobName(reembedJob!.name);
        hint = `re-embed to ${jobBackend} in progress, semantic search keyword-only until it finishes`;
      } else {
        hint = mismatchReason(c.binding, be);
      }
    }

    const level = worst([indexLevel, backendLevel, ...jobs.map((j) => j.level), ...passes.map((p) => p.level)]);
    const reason =
      level === "green" ? "all systems healthy"
      : c.bindingError ? `binding check failed: ${c.bindingError}`
      : jobs.find((j) => j.stalled) ? `job ${jobs.find((j) => j.stalled)!.name} stalled`
      : c.backend && !c.backend.ok ? `backend unavailable: ${c.backend.reason}`
      : passes.find((p) => p.failure) ? `pass ${passes.find((p) => p.failure)!.name} failed`
      : hint ?? (reembedActive ? `re-embed ${reembedJob!.name} running` : c.backend ? "degraded" : "backend not probed yet");
    const activeJob = reembedActive ? jobs.find((j) => j.name === reembedJob!.name) : undefined;
    const segments = counts && counts.embedded !== null ? indexSegments(counts.chunks, counts.embedded, activeJob ? activeJob.done : null) : null;

    return {
      generatedAt: t,
      level,
      reason,
      daemon: { pid: d.pid, uptimeSecs: Math.floor((t - d.startTime) / 1000), version: d.version, storage: this.src.storage },
      index: {
        level: indexLevel,
        files: counts?.files ?? null,
        chunks: counts?.chunks ?? null,
        embedded: counts?.embedded ?? null,
        coverage: counts && counts.embedded !== null && counts.chunks > 0 ? Math.min(1, counts.embedded / counts.chunks) : null,
        countsExact: counts?.exact ?? false,
        countsAt: counts?.at ?? null,
        segments,
        binding: c.binding,
        configured: { backend: be.id, model: be.model, dims: be.dims },
        mismatch,
        hint,
        error: c.bindingError,
      },
      jobs,
      passes,
      backend: {
        level: backendLevel,
        id: be.id,
        model: be.model,
        available: c.backend?.ok ?? null,
        reason: c.backend?.reason ?? null,
        loaded: c.loaded?.map((m) => ({ name: m.name, size: m.size, sizeVram: m.sizeVram, gpuShare: m.size > 0 ? m.sizeVram / m.size : null })) ?? null,
      },
    };
  }

  private findReembedJob(jobs: RawJob[], configuredBackendId: string): RawJob | undefined {
    return jobs.find((j) => j.name.endsWith("-reembed") && this.deriveBackendFromJobName(j.name) === configuredBackendId);
  }

  private deriveBackendFromJobName(jobName: string): string {
    const match = jobName.match(/^(.+)-reembed$/);
    return match ? match[1] : jobName;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export interface DashboardHandle {
  server: Server;
  url: string;
  stop(): void;
}

export async function startDashboard(
  cfg: DashboardConfig,
  src: DashboardSource,
  opts: { extraHosts?: string[]; historyPath?: string } = {},
): Promise<DashboardHandle> {
  const state = new DashboardState(src, Date.now, opts.historyPath);
  await state.loadHistory();
  const allowed = [cfg.bind, "localhost", "127.0.0.1", "::1", ...(opts.extraHosts ?? (await tailnetHosts()))];

  const server = createServer((req, res) => {
    const deny = (code: number, msg: string) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(msg); };
    if (!hostAllowed(req.headers.host, allowed)) return deny(403, "forbidden host");
    if (req.method !== "GET" && req.method !== "HEAD") return deny(405, "read-only");
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/api/status") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(state.status()));
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(DASHBOARD_HTML);
    }
    deny(404, "not found");
  });

  await state.tick();
  const timer = setInterval(() => void state.tick(), TICK_MS);
  timer.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.bind, resolve);
  });
  return {
    server,
    url: `http://${cfg.bind}:${cfg.port}/`,
    stop: () => { clearInterval(timer); server.close(); },
  };
}

// ---------------------------------------------------------------------------
// Live source (Postgres or SQLite storage + configured backend)
// ---------------------------------------------------------------------------

/** Postgres statements for the dashboard; table names are the existing pai_* ones. */
async function pgEstimate(pool: Pool): Promise<Counts> {
  const rel = await pool.query<{ relname: string; n: string }>(
    "SELECT relname, reltuples::bigint::text AS n FROM pg_class WHERE relname IN ('pai_files', 'pai_chunks')",
  );
  const n = (name: string) => Math.max(0, Number(rel.rows.find((r) => r.relname === name)?.n ?? 0));
  const nf = await pool.query<{ null_frac: number }>(
    "SELECT null_frac FROM pg_stats WHERE tablename = 'pai_chunks' AND attname = 'embedding' LIMIT 1",
  );
  const frac = nf.rows[0]?.null_frac;
  const chunks = n("pai_chunks");
  return { files: n("pai_files"), chunks, embedded: frac === undefined ? null : Math.round(chunks * (1 - frac)) };
}

async function pgExact(pool: Pool): Promise<Counts> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${EXACT_TIMEOUT_MS}`);
    const f = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM pai_files");
    const c = await client.query<{ n: string; e: string }>(
      "SELECT count(*)::text AS n, count(embedding)::text AS e FROM pai_chunks",
    );
    return { files: Number(f.rows[0].n), chunks: Number(c.rows[0].n), embedded: Number(c.rows[0].e) };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

async function pgJobs(pool: Pool): Promise<RawJob[]> {
  const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('pai_embedding_jobs')::text AS t");
  if (!exists.rows[0]?.t) return [];
  const r = await pool.query<{ column_name: string; state: Record<string, unknown> | null }>(
    "SELECT column_name, state FROM pai_embedding_jobs",
  );
  return r.rows.map((x) => ({ name: x.column_name, state: x.state ?? {} }));
}

async function ollamaPs(baseUrl: string): Promise<LoadedModel[] | null> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/ps`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { models?: Array<{ name: string; size: number; size_vram: number }> };
    return (j.models ?? []).map((m) => ({ name: m.name, size: m.size, sizeVram: m.size_vram }));
  } catch {
    return null;
  }
}

export function liveSource(deps: {
  storage: StorageBackend;
  backend: () => EmbeddingBackend;
  ollamaBaseUrl: string;
  daemon: DashboardSource["daemon"];
  passes: DashboardSource["passes"];
}): DashboardSource {
  const pool = (deps.storage as unknown as { getPool?: () => Pool }).getPool?.();
  const sqliteCounts = async (): Promise<Counts> => ({ ...(await deps.storage.getStats()), embedded: null });
  return {
    storage: deps.storage.backendType,
    daemon: deps.daemon,
    estimate: pool ? () => pgEstimate(pool) : sqliteCounts,
    exact: pool ? () => pgExact(pool) : sqliteCounts,
    binding: () => deps.storage.getEmbeddingBinding(),
    jobs: pool ? () => pgJobs(pool) : async () => [],
    backend: deps.backend,
    loadedModels: () => ollamaPs(deps.ollamaBaseUrl),
    passes: deps.passes,
  };
}
