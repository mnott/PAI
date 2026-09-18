/**
 * keepalive.ts — one cache-keepalive beat, shared by the daemon scheduler and
 * the probe script.
 *
 * The provider (GLM anthropic-compat endpoint) caches the worker prefix
 * implicitly — no cache_control blocks — so a trivial single-turn worker spawn
 * through the very same runWorker path re-arms that cache for the next real
 * worker: identical env, identical tool grants, identical WORKER_CONTRACT_PROMPT
 * by construction, because it IS a worker spawn.
 *
 * Measured 2026-09-18 (docs/cache-keepalive.md): the implicit cache only
 * serves spawns within seconds of the previous identical request and never
 * survived a 60 s beat cadence in the armed proof — hence the knob defaults
 * to off and arming it is the operator's explicit call.
 *
 * Deliberately NOT a hand-built claude invocation: duplicated prefix
 * construction is how this repo has shipped real breakage before (probeResume
 * x3, archiver x2). Everything flows through runWorker.
 */

import { readFileSync } from "node:fs";
import { runWorker, type StreamEvent } from "./run.js";
import { readWorkersSection } from "./config.js";
import { appendLedger } from "./ledger.js";
import { eventsPath, ledgerPath, workersLogDir } from "./paths.js";
import { loadStatus } from "./status.js";

/**
 * The trivial prompt every cache beat (and probe) carries. Kept in one place
 * so the heartbeat arms exactly the prefix a verifying probe measures.
 */
export const HEARTBEAT_PROMPT = "Reply with exactly one word: pong.";

/** The worker class a beat runs as — the cheapest spawn the config defines. */
export const KEEPALIVE_CLASS = "simple";

/** Worker label of every beat, so `pai worker ps` can tell them apart. */
export const KEEPALIVE_LABEL = "cache-keepalive";

/** Cadence a keepalive runs at for this config; 0 keeps it off. */
export function keepaliveSecs(workers: { enabled: boolean; cacheKeepaliveSecs: number }): number {
  return workers.enabled ? workers.cacheKeepaliveSecs : 0;
}

// ---------------------------------------------------------------------------
// Transcript parsing — the only real usage on this endpoint is the final
// result event (per-turn assistant usage is zeroed), so a beat and a probe
// both read exactly that line.
// ---------------------------------------------------------------------------

/**
 * The LAST `type:"result"` event of a worker transcript, or null when the
 * file is missing, unreadable, or carries no result line (a failed run can
 * end without one).
 */
export function parseLastResultEvent(path: string): StreamEvent | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let found: StreamEvent | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: StreamEvent;
    try {
      e = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (e.type === "result") found = e;
  }
  return found;
}

/** One worker's cache metrics, as reported by its final result event. */
export interface BeatMetrics {
  id: string;
  ok: boolean;
  rc: number | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  duration_api_ms: number | null;
  duration_ms: number | null;
  num_turns: number | null;
}

/**
 * Metrics of one run from its final result event. Single-turn runs make the
 * cumulative result usage identical to first-turn usage, so a warm cache
 * shows up directly as cache_read_input_tokens > 0.
 */
export function extractBeatMetrics(
  m: Omit<BeatMetrics, "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens" | "duration_api_ms" | "duration_ms" | "num_turns">,
  ev: StreamEvent | null
): BeatMetrics {
  const u = ev?.usage;
  return {
    ...m,
    input_tokens: u?.input_tokens ?? null,
    output_tokens: u?.output_tokens ?? null,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? null,
    duration_api_ms: ev?.duration_api_ms ?? null,
    duration_ms: ev?.duration_ms ?? null,
    num_turns: ev?.num_turns ?? null,
  };
}

// ---------------------------------------------------------------------------
// The beat
// ---------------------------------------------------------------------------

export interface BeatOptions {
  /** Config path override (tests never touch the live config). */
  configPath?: string;
  /** Preset worker id (tests); a fresh stamp when omitted. */
  id?: string;
}

/** True while a beat's worker is still running — the overlap guard reads it. */
let beatInFlight = false;

export function beatBusy(): boolean {
  return beatInFlight;
}

/** `keepalive-<YYYYMMDD-HHMMSS>` — beats are minutes apart, seconds suffice. */
export function beatId(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `keepalive-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * One heartbeat: a single-turn trivial worker through the exact worker spawn
 * path, its result metrics parsed from the transcript, one WORKER-KEEPALIVE
 * ledger line. Returns null when another beat is still running (overlap
 * guard) — a skipped beat is free, a queue of them is not.
 *
 * The beat runs in the workers logDir: no session renders its status line
 * there, so the spawn adopts no spawnerSession and no iTerm identity, and
 * worker supervision has no owner to notify — heartbeats are infrastructure,
 * not somebody's workers.
 */
export async function runKeepaliveBeat(opts: BeatOptions = {}): Promise<BeatMetrics | null> {
  if (beatInFlight) return null;
  beatInFlight = true;
  try {
    const { workers: config } = readWorkersSection(opts.configPath);
    const logDir = workersLogDir(config);
    const id = opts.id ?? beatId();
    const rc = await runWorker({
      claudeArgs: ["-p", HEARTBEAT_PROMPT],
      className: KEEPALIVE_CLASS,
      label: KEEPALIVE_LABEL,
      noPane: true,
      quiet: true,
      worktreeFlag: false,
      id,
      cwd: logDir,
    });
    const status = loadStatus(logDir, id);
    const metrics = extractBeatMetrics(
      {
        id,
        ok: rc === 0,
        rc,
        provider: status?.provider ?? null,
        model: status?.model ?? null,
      },
      parseLastResultEvent(eventsPath(logDir, id))
    );
    appendLedger(ledgerPath(logDir), "WORKER-KEEPALIVE", {
      id,
      provider: metrics.provider,
      model: metrics.model,
      input_tokens: metrics.input_tokens,
      cache_read_input_tokens: metrics.cache_read_input_tokens,
      cache_creation_input_tokens: metrics.cache_creation_input_tokens,
      duration_api_ms: metrics.duration_api_ms,
    });
    return metrics;
  } finally {
    beatInFlight = false;
  }
}
