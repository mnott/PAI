/**
 * sessions.ts — Claude Code session id → display name, from PAI data only:
 * worker status files (claudeSession → label) and the agent-session registry
 * (session id → project). Unknown ids map to null.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";

export interface SessionInfo {
  /** display name */
  name: string;
  /** worker id when the session is a worker run */
  worker?: string;
  state?: string;
  /** worker outcome: ok, failed, or the raw state while running */
  verdict?: string;
  provider?: string;
}

export interface SessionSources {
  workerDirs: string[];
  agentSessionsFile: string;
  /** Claude Code transcript root: <dir>/<encoded cwd>/<session id>.jsonl */
  projectsDir?: string;
}

export function defaultSources(): SessionSources {
  const home = homedir();
  return {
    workerDirs: [paiHomePath("logs", "workers"), join(home, ".claude", "logs", "workers")],
    agentSessionsFile: paiHomePath("agent-sessions.json"),
    projectsDir: join(home, ".claude", "projects"),
  };
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
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
  if (s.state !== "done" || (typeof s.rc === "number" && s.rc !== 0)) return "failed";
  // a clean run whose report the validator flagged is done, not failed
  const commits = typeof s.commits === "number" ? s.commits : undefined;
  const suffix = commits !== undefined ? ` · ${commits} commit${commits === 1 ? "" : "s"}` : "";
  return s.reportValid === false ? `done · report flagged${suffix}` : `ok${suffix}`;
}

/** Full map session id → info. Reads every status file once; callers cache it. */
export function loadSessionMap(src: SessionSources = defaultSources()): Map<string, SessionInfo> {
  const map = new Map<string, SessionInfo>();
  const agents = existsSync(src.agentSessionsFile) ? readJson(src.agentSessionsFile) : undefined;
  if (agents) for (const [id, name] of Object.entries(agents)) if (typeof name === "string") map.set(id, { name });
  for (const dir of src.workerDirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".status")) continue;
      const s = readJson(join(dir, f));
      if (!s || typeof s.claudeSession !== "string") continue;
      map.set(s.claudeSession, {
        name: typeof s.label === "string" && s.label ? s.label : String(s.id ?? f),
        worker: typeof s.id === "string" ? s.id : undefined,
        state: typeof s.state === "string" ? s.state : undefined,
        verdict: workerVerdict(s),
        provider: typeof s.provider === "string" ? s.provider : undefined,
      });
    }
  }
  // Last resort for interactive sessions the registry does not list: the project directory of the transcript.
  if (src.projectsDir && existsSync(src.projectsDir)) {
    for (const d of readdirSync(src.projectsDir)) {
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
        if (id && !map.has(id)) map.set(id, { name });
      }
    }
  }
  return map;
}

/** Display name of a session id, null when PAI does not know it. */
export function sessionDisplayName(id: string | undefined, map: Map<string, SessionInfo> = loadSessionMap()): string | null {
  return (id && map.get(id)?.name) || null;
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
  return typeof v === "string" && Date.parse(v) ? Date.parse(v) : undefined;
}

/** Every status file as a run window; running runs end at `now`. */
export function loadWorkerWindows(src: SessionSources = defaultSources(), now: number = Date.now()): WorkerWindow[] {
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
  const unknown = new Map<string, Array<{ t: number; model?: string; provider?: string }>>();
  for (const r of rows) {
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
    const hits = new Map<string, WorkerWindow>();
    for (const w of windows) {
      const { from, to } = windowBounds(w, now);
      if (!reqs.some((r) => r.t >= from && r.t <= to)) continue;
      if (reqs.some((r) => (w.model && r.model && w.model !== r.model) || (w.provider && r.provider && w.provider !== r.provider))) continue;
      hits.set(w.worker, w);
    }
    if (!hits.size) continue;
    // containment is required for every request; among the covering runs the freshest start wins
    const first = Math.min(...reqs.map((r) => r.t));
    const best = [...hits.values()].sort((a, b) => b.startMs - a.startMs)[0]!;
    if (best.startMs > first) continue;
    out.set(id, { name: best.label, worker: best.worker, state: best.state, verdict: best.verdict, provider: best.provider });
  }
  return out;
}
