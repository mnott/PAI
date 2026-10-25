/**
 * sessions.ts — Claude Code session id → display name, from PAI data only, in
 * one resolution order (highest first): worker run label > AIBroker name >
 * Claude Code background-job name > agent-session registry entry (a project
 * slug every session gets) > transcript-directory fallback. A lower source
 * never overwrites a higher one; the registry value stays in `project` for a
 * UI that shows the project separately. Unknown ids map to null.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseStamp } from "../workers/ledger.js";
import { paiHomePath } from "../config/pai-home.js";
import { claudeHomeDir, claudeProjectsDir } from "../config/pai-home.js";
import { aibrokerHomeDir } from "../runtime-paths.js";

export interface SessionInfo {
  /** display name */
  name: string;
  /** agent-sessions registry value (project slug): kept even when a higher source names the session */
  project?: string;
  /** set when the name comes from AIBroker: tops the job name without losing the slug */
  aibroker?: boolean;
  /** worker id when the session is a worker run */
  worker?: string;
  state?: string;
  /** worker outcome: ok, failed, or the raw state while running */
  verdict?: string;
  provider?: string;
  /** worker runs: the spawning session's AIBroker name, else the profile key, for grouping */
  parent?: string;
  /** worker runs: Claude id of the orchestrator whose Bash launched the run (a name lookup in the same map) */
  spawner?: string;
  /** worker runs: start and end (ms; a running run ends null) */
  startMs?: number;
  endMs?: number | null;
  /** worker runs: end-of-run scan findings per severity (absent when none recorded) */
  findings?: { block: number; confirm: number; warn: number };
}

export interface SessionSources {
  workerDirs: string[];
  agentSessionsFile: string;
  /** Claude Code transcript root: <dir>/<encoded cwd>/<session id>.jsonl */
  projectsDir?: string;
  /** AIBroker state dir (managers.json, session-names.json); absent or unreadable changes nothing */
  aibrokerDir?: string;
  /** Claude Code background jobs: <dir>/<first 8 chars of session id>/state.json, field "name" only */
  jobsDir?: string;
  /** statusline registry: Claude session id -> { uid: iTerm session uuid } */
  claudeMapFile?: string;
}

export function defaultSources(): SessionSources {
  return {
    workerDirs: [paiHomePath("logs", "workers"), join(claudeHomeDir(), "logs", "workers")],
    agentSessionsFile: paiHomePath("agent-sessions.json"),
    projectsDir: claudeProjectsDir(),
    aibrokerDir: aibrokerHomeDir(),
    claudeMapFile: paiHomePath("session-claude-map.json"),
    // CLAUDE_CONFIG_DIR is the .claude dir itself (the jobs dir is <it>/jobs)
    jobsDir: join(claudeHomeDir(), "jobs"),
  };
}

const JOB_TTL_MS = 30_000;
const jobCache = new Map<string, { at: number; name: string | null }>();

/** Drop the job-name cache (tests flip the jobs dir mid-run). */
export function clearJobNameCache(): void {
  jobCache.clear();
}

/**
 * Name of a Claude Code background-job session: jobs/<id8>/state.json, "name"
 * only (the file also holds respawn env settings — nothing else is read out of
 * it or kept). Cached per id like the session map; null when absent or malformed.
 */
export function jobSessionName(id: string | undefined, jobsDir: string | undefined = defaultSources().jobsDir, now: number = Date.now()): string | null {
  if (!id || !jobsDir) return null;
  const id8 = id.slice(0, 8);
  if (!/^[0-9A-Za-z-]{8}$/.test(id8)) return null;
  const key = `${jobsDir}\0${id8}`;
  const hit = jobCache.get(key);
  if (hit && now - hit.at < JOB_TTL_MS) return hit.name;
  const raw = readJson(join(jobsDir, id8, "state.json"))?.name;
  const name = typeof raw === "string" && raw ? raw : null;
  // entries are re-inserted on refresh, so the Map is ordered by age: drop expired ones from the front
  jobCache.delete(key);
  for (const [k, v] of jobCache) {
    if (now - v.at < JOB_TTL_MS) break;
    jobCache.delete(k);
  }
  jobCache.set(key, { at: now, name });
  return name;
}

/**
 * One resolution order, highest first: worker run label > AIBroker name >
 * background-job name > agent-sessions entry > transcript fallback. A lower
 * source never overwrites a higher one; the agent-sessions value survives as
 * `project`. `jobName` supplies the job name for ids the map does not carry
 * one for (the cockpit resolves it per rendered row).
 */
export function resolveSessionName(
  id: string,
  info: SessionInfo | undefined,
  jobName: (id: string) => string | null = (i) => jobSessionName(i)
): SessionInfo | undefined {
  if (!info) {
    const name = jobName(id);
    return name ? { name } : undefined;
  }
  // a worker label or an AIBroker name already tops the job; a bare registry
  // entry (the slug itself) yields to the job name
  if (info.worker || info.aibroker) return info;
  const name = jobName(id);
  return name ? { ...info, name } : info;
}

/** Ids the map does not carry a job name for, resolved through the order above. */
export function withJobNames(map: Map<string, SessionInfo>, ids: Iterable<string | undefined>, jobsDir?: string): Map<string, SessionInfo> {
  let out: Map<string, SessionInfo> | undefined;
  for (const id of ids) {
    if (!id) continue;
    const info = map.get(id);
    if (info?.project !== undefined) continue;
    const resolved = resolveSessionName(id, info, (i) => jobSessionName(i, jobsDir));
    if (resolved && resolved !== info) (out ??= new Map(map)).set(id, resolved);
  }
  return out ?? map;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Commits the run left on its branch, counted live: a killed run ends before
 * the record path writes `commits`, yet its work survives — the branch (it
 * outlives `pai worker merge`) or the `refs/pai-archive/<id>` ref gc left
 * behind. Counted from the repo's object store, so a removed worktree still
 * counts. null when nothing can be counted.
 */
const BRANCH_COMMITS_TTL_MS = 30_000;
const branchCommitsCache = new Map<string, { at: number; n: number | null }>();

/** Drop the memoised branch counts (tests). */
export function clearBranchCommitsCache(): void {
  branchCommitsCache.clear();
}

/** Number of memoised branch counts (tests). */
export function branchCommitsCacheSize(): number {
  return branchCommitsCache.size;
}

export function branchCommits(s: Record<string, unknown>, now: number = Date.now()): number | null {
  const cwd = typeof s.cwd === "string" ? s.cwd : undefined;
  const id = typeof s.id === "string" ? s.id : undefined;
  const base = typeof s.worktreeBase === "string" ? s.worktreeBase : undefined;
  if (!cwd || !id || !base) return null;
  // the status files are re-read every poll on the router loop: git runs once per (repo, run, branch) per TTL
  const key = `${cwd}\0${id}\0${base}\0${typeof s.branch === "string" ? s.branch : ""}`;
  const hit = branchCommitsCache.get(key);
  if (hit && now - hit.at < BRANCH_COMMITS_TTL_MS) return hit.n;
  const n = countBranchCommits(cwd, id, base, typeof s.branch === "string" ? s.branch : "");
  // entries are re-inserted on refresh, so the Map is ordered by age: drop expired ones from the front
  branchCommitsCache.delete(key);
  for (const [k, v] of branchCommitsCache) {
    if (now - v.at < BRANCH_COMMITS_TTL_MS) break;
    branchCommitsCache.delete(k);
  }
  branchCommitsCache.set(key, { at: now, n });
  return n;
}

function countBranchCommits(cwd: string, id: string, base: string, branch: string): number | null {
  const refs: string[] = [];
  if (branch) refs.push(`refs/heads/${branch}`);
  refs.push(`refs/pai-archive/${id}-branch`, `refs/pai-archive/${id}`);
  for (const ref of refs) {
    try {
      const out = execFileSync("git", ["-C", cwd, "rev-list", "--count", `${base}..${ref}`], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const n = parseInt(out.trim(), 10);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // ref gone or cwd not a repo: try the next one
    }
  }
  return null;
}

function workerFindings(s: Record<string, unknown>): SessionInfo["findings"] {
  const f = s.findings as Record<string, unknown> | undefined;
  if (!f || typeof f !== "object") return undefined;
  const c = (k: string): number => (typeof f[k] === "number" && f[k] > 0 ? (f[k] as number) : 0);
  return { block: c("block"), confirm: c("confirm"), warn: c("warn") };
}

function workerVerdict(s: Record<string, unknown>): string {
  // a run parked at the capacity gate waits for a provider slot
  if (s.state === "queued") return "queued (provider cap)";
  // a run held in the stagger gate is running, but waiting on a cache warm-up
  const w = s.warmup as { elapsedSec?: unknown; limitSec?: unknown } | undefined;
  if (s.state === "running" && w && typeof w.elapsedSec === "number" && typeof w.limitSec === "number") {
    return `waiting (warm-up) ${Math.max(0, Math.floor(w.elapsedSec))}s/${Math.floor(w.limitSec)}s`;
  }
  if (s.state !== "done" && s.state !== "failed" && s.state !== "error") return String(s.state ?? "?");
  // a run that escalated handed its work on: say where it went, not "failed"
  // a killed run never records `commits` (its end path stops before the record
  // step) — count them from its branch, which the escalation keeps for merge
  let commits = typeof s.commits === "number" ? s.commits : undefined;
  if (commits === undefined && s.escalated) commits = branchCommits(s) ?? undefined;
  const suffix = commits !== undefined ? ` · ${commits} commit${commits === 1 ? "" : "s"}` : "";
  if (typeof s.escalated === "string" && s.escalated) {
    return typeof s.escalatedTo === "string" && s.escalatedTo ? `escalated → ${s.escalatedTo}${suffix}` : "handed to session";
  }
  if (s.state !== "done" || (typeof s.rc === "number" && s.rc !== 0)) return "failed";
  // a clean run whose report the validator flagged is done, not failed
  return s.reportValid === false ? `done · report flagged${suffix}` : `ok${suffix}`;
}

/** iTerm session uuid -> AIBroker name: managers.json (sessionId -> {name}) overlaid by the operator's session-names.json (uuid -> name). */
function aibrokerNames(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const managers = readJson(join(dir, "managers.json"));
  if (managers) {
    for (const [key, v] of Object.entries(managers)) {
      const name = (v as { name?: unknown } | null)?.name;
      if (typeof name === "string" && name) out.set(key.toUpperCase(), name);
    }
  }
  const chosen = readJson(join(dir, "session-names.json"));
  if (chosen) for (const [key, name] of Object.entries(chosen)) if (typeof name === "string" && name) out.set(key.toUpperCase(), name);
  return out;
}

/** AIBroker name of the launching session, else its profile key. */
function workerParent(s: Record<string, unknown>): string | undefined {
  const name = (s.session as { name?: unknown } | null | undefined)?.name;
  if (typeof name === "string" && name) return name;
  return typeof s.sessionKey === "string" && s.sessionKey ? s.sessionKey : undefined;
}

/** Full map session id → info. Reads every status file once; callers cache it. */
export function loadSessionMap(src: SessionSources = defaultSources()): Map<string, SessionInfo> {
  return drain(loadSessionMapSteps(src));
}

/** The loader below as steps: a `yield` after each directory or file, so a driver can hand the event loop back between them. */
export function* loadSessionMapSteps(src: SessionSources = defaultSources()): Generator<void, Map<string, SessionInfo>> {
  // lowest first, each source overwrites only what is below it: transcript
  // fallback < agent-sessions entry < job name < AIBroker name < worker label
  const map = new Map<string, SessionInfo>();
  // The project directory of the transcript: today's fallback for ids nothing else lists.
  if (src.projectsDir && existsSync(src.projectsDir)) {
    let projectDirs: string[] = [];
    try {
      projectDirs = readdirSync(src.projectsDir);
    } catch {
      // unreadable or replaced since existsSync: no transcript fallback
    }
    for (const d of projectDirs) {
      const name = d.split("-").filter(Boolean).pop();
      if (!name) continue;
      let files: string[] = [];
      try {
        files = readdirSync(join(src.projectsDir, d));
      } catch {
        continue;
      }
      for (const f of files) {
        const id = f.endsWith(".jsonl") ? f.slice(0, -6) : "";
        if (id) map.set(id, { name });
      }
      yield;
    }
  }
  // The agent-session registry: a project slug every session gets — a name, never a display override.
  const agents = existsSync(src.agentSessionsFile) ? readJson(src.agentSessionsFile) : undefined;
  if (agents)
    for (const [id, project] of Object.entries(agents)) {
      if (typeof project !== "string" || !project) continue;
      const info = map.get(id);
      map.set(id, info ? { ...info, name: project, project } : { name: project, project });
    }
  // Claude Code background-job names: a session's own name beats the project slug.
  if (src.jobsDir)
    for (const [id, info] of map) {
      if (info.worker || info.aibroker) continue;
      const name = jobSessionName(id, src.jobsDir);
      if (name) map.set(id, { ...info, name });
      yield;
    }
  // AIBroker's names for interactive sessions: Claude id -> iTerm uuid (statusline map) -> name.
  if (src.aibrokerDir && src.claudeMapFile) {
    const names = aibrokerNames(src.aibrokerDir);
    const claude = names.size ? readJson(src.claudeMapFile) : undefined;
    if (claude) {
      for (const [id, e] of Object.entries(claude)) {
        const uid = (e as { uid?: unknown } | null)?.uid;
        const name = typeof uid === "string" ? names.get(uid.toUpperCase()) : undefined;
        if (name) map.set(id, { ...(map.get(id) ?? {}), name, aibroker: true });
      }
    }
  }
  // The worker run label tops the order.
  for (const dir of src.workerDirs) {
    if (!existsSync(dir)) continue;
    let dirFiles: string[] = [];
    try {
      dirFiles = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of dirFiles) {
      if (!f.endsWith(".status")) continue;
      yield;
      const s = readJson(join(dir, f));
      if (!s || typeof s.claudeSession !== "string") continue;
      map.set(s.claudeSession, {
        ...(map.get(s.claudeSession) ?? {}),
        name: typeof s.label === "string" && s.label ? s.label : String(s.id ?? f),
        worker: typeof s.id === "string" ? s.id : undefined,
        state: typeof s.state === "string" ? s.state : undefined,
        verdict: workerVerdict(s),
        provider: typeof s.provider === "string" ? s.provider : undefined,
        parent: workerParent(s),
        spawner: typeof s.spawnerSession === "string" && s.spawnerSession ? s.spawnerSession : undefined,
        startMs: parseLocalTs(s.started),
        endMs: s.state === "running" || s.state === "queued" ? null : (parseLocalTs(s.updated) ?? null),
        findings: workerFindings(s),
      });
    }
  }
  return map;
}

/** Display name of a session id, resolved through the order above; null when PAI does not know it. */
export function sessionDisplayName(id: string | undefined, map: Map<string, SessionInfo> = loadSessionMap(), jobsDir?: string): string | null {
  if (!id) return null;
  return resolveSessionName(id, map.get(id), (i) => jobSessionName(i, jobsDir))?.name || null;
}

// ---- one-shot attribution -------------------------------------------------

/**
 * Worker runs as time windows. One-shot flash runs often send their single
 * router request under a throwaway session id that no registry lists — the
 * status file's claudeSession belongs to the pane, not to the request. The
 * run window plus model/provider is then the only attribution PAI has, and
 * it is only used when it is unambiguous.
 */
export interface WorkerWindow {
  worker: string;
  label: string;
  provider?: string;
  model?: string;
  startMs: number;
  endMs: number;
  claudeSession?: string;
  state?: string;
  verdict?: string;
}

function parseLocalTs(v: unknown): number | undefined {
  return typeof v === "string" && parseStamp(v) ? parseStamp(v) : undefined;
}

/** Every status file as a run window; running runs end at `now`. */
export function loadWorkerWindows(src: SessionSources = defaultSources(), now: number = Date.now()): WorkerWindow[] {
  return drain(loadWorkerWindowsSteps(src, now));
}

export function* loadWorkerWindowsSteps(src: SessionSources = defaultSources(), now: number = Date.now()): Generator<void, WorkerWindow[]> {
  const out: WorkerWindow[] = [];
  for (const dir of src.workerDirs) {
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".status")) continue;
      yield;
      const s = readJson(join(dir, f));
      if (!s) continue;
      const startMs = parseLocalTs(s.started);
      if (startMs === undefined) continue;
      const endMs = parseLocalTs(s.updated) ?? (typeof s.secs === "number" ? startMs + s.secs * 1000 : undefined) ?? now;
      out.push({
        worker: String(s.id ?? f),
        label: typeof s.label === "string" && s.label ? s.label : String(s.id ?? f),
        provider: typeof s.provider === "string" ? s.provider : undefined,
        model: typeof s.model === "string" ? s.model : undefined,
        startMs,
        endMs,
        claudeSession: typeof s.claudeSession === "string" ? s.claudeSession : undefined,
        state: typeof s.state === "string" ? s.state : undefined,
        verdict: workerVerdict(s),
      });
    }
  }
  return out;
}

const ATTRIBUTE_SLACK_MS = 120_000;

/** Finished runs keep their exact window; only still-running ones get slack (their updated field trails the live request). */
function windowBounds(w: WorkerWindow, now: number): { from: number; to: number } {
  const finished = w.state === "done" || w.state === "failed" || w.state === "error";
  return {
    from: w.startMs,
    to: finished ? w.endMs : Math.min(w.endMs + ATTRIBUTE_SLACK_MS, now + ATTRIBUTE_SLACK_MS),
  };
}

/**
 * Extend an exact-match session map with time-attributed one-shot ids: a
 * session id that is not already a resolved worker run gets the worker label
 * when all of its requests fall inside a worker's run window (same model,
 * same provider). When several runs qualify — flash workers overlap — the
 * most recently started one wins: a one-shot request fires right after its
 * own run spawned, so the freshest live window is the likeliest owner.
 */
export function withWorkerAttribution(
  map: Map<string, SessionInfo>,
  rows: Array<{ ts: string; session_id?: string; model?: string; provider?: string }>,
  windows: WorkerWindow[],
  now: number = Date.now()
): Map<string, SessionInfo> {
  return drain(withWorkerAttributionSteps(map, rows, windows, now));
}

export function* withWorkerAttributionSteps(
  map: Map<string, SessionInfo>,
  rows: Array<{ ts: string; session_id?: string; model?: string; provider?: string }>,
  windows: WorkerWindow[],
  now: number = Date.now()
): Generator<void, Map<string, SessionInfo>> {
  let n = 0;
  const unknown = new Map<string, Array<{ t: number; model?: string; provider?: string }>>();
  for (const r of rows) {
    if (++n % 2000 === 0) yield;
    // a worker run keeps its label
    if (!r.session_id || map.get(r.session_id)?.worker) continue;
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t)) continue;
    const list = unknown.get(r.session_id) ?? [];
    list.push({ t, model: r.model, provider: r.provider });
    unknown.set(r.session_id, list);
  }
  if (!unknown.size) return map;
  const out = new Map(map);
  for (const [id, reqs] of unknown) {
    if (++n % 50 === 0) yield;
    // a session already named by a source above the worker label (AIBroker) is not relabelled
    if (map.get(id)?.aibroker) continue;
    const hits = new Map<string, WorkerWindow>();
    for (const w of windows) {
      const { from, to } = windowBounds(w, now);
      if (!reqs.some((r) => r.t >= from && r.t <= to)) continue;
      if (reqs.some((r) => (w.model && r.model && w.model !== r.model) || (w.provider && r.provider && w.provider !== r.provider))) continue;
      hits.set(w.worker, w);
    }
    if (!hits.size) continue;
    // containment is required for every request; among the covering runs the freshest start wins
    const first = reqs.reduce((m, r) => Math.min(m, r.t), Infinity);
    const best = [...hits.values()].sort((a, b) => b.startMs - a.startMs)[0]!;
    if (best.startMs > first) continue;
    out.set(id, { name: best.label, worker: best.worker, state: best.state, verdict: best.verdict, provider: best.provider });
  }
  return out;
}

/** Runs a stepped computation to its end in one go. */
export function drain<T>(steps: Generator<void, T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Runs a stepped computation in slices of about `sliceMs`, handing the event loop back between them. */
export async function runSliced<T>(steps: Generator<void, T>, sliceMs = 5): Promise<T> {
  let t = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - t >= sliceMs) {
      await new Promise<void>((res) => setImmediate(res));
      t = performance.now();
    }
  }
}
