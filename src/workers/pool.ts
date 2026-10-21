/**
 * pool.ts — the worker session pool: one long-lived headless claude per
 * (provider, model) for successive small `pai worker run` tasks, so the
 * provider-side prompt cache carries over between them.
 *
 * Evidence (2026-10-16, router-usage.jsonl): 158 of 161 glm sessions carry
 * exactly ONE request — every `pai worker run` spawns a fresh claude, sends
 * one giant prompt, exits. The provider cache can only serve a fresh spawn
 * within its TTL, so the effective hit ratio on first requests is ~13%
 * (continuous sessions: 98%). A warm slot turns the next task into the
 * SECOND request of a continuous session instead.
 *
 * Architecture (mirrors the openai proxy, src/workers/proxy/server.ts):
 *   - `pai worker pool on` starts a detached host (standalone/pool-host.ts,
 *     bundled to dist/hooks/worker-pool-host.mjs) that owns the slot
 *     processes and listens on a loopback port.
 *   - runWorker, behind workers.pool.enabled, routes eligible runs to the
 *     host (postTaskToPool); when the host answers `pooled`, the task ran as
 *     one more user turn of a pooled claude and the result comes back as
 *     JSON. Host down or task ineligible → the normal fresh spawn.
 *   - Each pooled task keeps its full worker identity: own id, status file,
 *     <id>.jsonl event mirror, ledger lines, AG2 contract and report
 *     validation — the pool wraps the bookkeeping, never replaces it.
 *
 * Contamination: a pooled claude sees the previous task's turns. Every task
 * turn starts with POOL_TASK_BOUNDARY — a system-reminder line naming the
 * task and forbidding references to prior turns — and the worker contract
 * already forbids restating; the boundary is the measured-in risk dial.
 *
 * Cwd: a slot process has ONE cwd, fixed at spawn, and the slot key is
 * (provider, model, cwd): a run in /repo pools into a slot living in /repo,
 * exactly where a fresh spawn would have run. Runs that need their own
 * worktree (writable tools in a git cwd, the default) pool only on loopback
 * providers, through slot worktrees (slots.ts): each slot owns ONE persistent
 * worktree that is the process cwd for its whole life, every task gets a new
 * branch in it and a fresh conversation, so the system prompt (which names the
 * cwd) is byte-identical across tasks and stays in the server's prefix cache.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { ANTHROPIC_NATIVE, DEFAULT_POOL_PORT, defaultWorkersConfig, type WorkersConfig, type WorkerProvider } from "./config.js";
import { grantsChrome, mcpServersFromToolGrants } from "./mcp.js";
import type { ParsedRunnerArgs } from "./args.js";
import type { StreamEvent } from "./run.js";
import { inputSideTokens, type UsageBlock } from "../utils/input-side-tokens.js";
import type { WorkerReport } from "./report.js";
import type { WorkerStatus } from "./status.js";
import { parseLedger } from "./ledger.js";
import { LOOPBACK_HOST } from "../utils/loopback.js";

// ---------------------------------------------------------------------------
// Config-facing helpers
// ---------------------------------------------------------------------------

/** The pool section of the workers config, with its defaults applied. { enabled, maxSlots, idleSecs, port } */
export interface PoolSettings {
  enabled: boolean;
  /** Maximum slot processes the host keeps, across all (provider, model) keys. */
  maxSlots: number;
  /** Idle seconds before the host kills a slot (0 = never); provider cache TTL makes longer pointless. */
  idleSecs: number;
  /** Loopback port the host listens on. */
  port: number;
  /** Native anthropic runs may use pooled slots (worktree runs never do). */
  native: boolean;
  /** Spares per (repo, provider) key; 0 = no spares. */
  spares: number;
  /** Idle seconds before an unclaimed spare is retired (0 = never). */
  idleKillSec: number;
  /** The old multi-task continuation path; spares are the default use of the pool. */
  continuation: boolean;
}

/** Pool fallbacks when a config names none — the shipped defaults file
 * (defaults/workers.yaml `workers.pool`), read via defaultWorkersConfig(). */
export function poolSettings(config: WorkersConfig): PoolSettings {
  const d = defaultWorkersConfig().pool;
  const p = config.pool;
  return {
    enabled: p?.enabled === true,
    maxSlots: p?.maxSlots ?? d.maxSlots,
    idleSecs: p?.idleSecs ?? d.idleSecs,
    port: p?.port ?? d.port,
    native: p?.native !== false,
    spares: p?.spares ?? d.spares ?? 1,
    idleKillSec: p?.idleKillSec ?? d.idleKillSec ?? 1800,
    continuation: p?.continuation === true,
  };
}

// ---------------------------------------------------------------------------
// On-disk state (under <logDir>/pool/)
// ---------------------------------------------------------------------------

/** One pooled slot: a long-lived claude process keyed by provider+model+cwd. */
export interface PoolSlotRecord {
  provider: string;
  model: string;
  /** The slot's fixed working directory (the host's neutral dir). */
  cwd: string;
  pid: number;
  /** Claude session id from the slot's init event (`pai worker resume` can reach it). */
  claudeSession: string | null;
  /** Context window the slot's init event announced, when it did. */
  contextWindow?: number | null;
  spawnedAt: string;
  lastUsedAt: string;
  /** Tasks the slot has served. */
  tasks: number;
  /** While a task is mid-turn the slot is exclusive to it. */
  busyWith: string | null;
  /** Slot-worktree slots: the branch of the current (or last) task. */
  branch?: string | null;
  /** Cached share of the last task's first request: 1 = whole prefix reused, ~0 = cold. */
  firstShare?: number | null;
}

/** One spare: a pre-started, task-less worker (worktree made, claude waiting for its first user turn). */
export interface PoolSpareRecord {
  id: string;
  /** Repo root, provider and model: the key a claim matches. */
  repo: string;
  provider: string;
  model: string;
  dir: string;
  branch: string;
  /** The repo HEAD the worktree was cut from; a claim after HEAD moved is a stale miss. */
  base: string;
  pid: number;
  createdAt: string;
  state: "starting" | "ready";
}

export interface PoolState {
  hostPid: number;
  port: number;
  startedAt: string;
  updatedAt: string;
  slots: PoolSlotRecord[];
  /** Pooled tasks served since the host started. */
  tasksServed: number;
  /** cache_read tokens seen on the first request of each pooled task. */
  tokensCarried: number;
  /** Spares waiting for a claim (absent in state files from before spares). */
  spares?: PoolSpareRecord[];
  /** Claims served from a spare since the host started. */
  spareClaims?: number;
  /** Claims that found no usable spare, by reason. */
  spareMisses?: Record<string, number>;
  /** mtime (ms) of the host's own bundle when it started: the code version it runs. */
  bundleMtimeMs?: number;
}

/** True when the bundle on disk is newer than the one the host started from (a build landed since). */
export function poolHostStale(startedMtimeMs: number | undefined, diskMtimeMs: number | null): boolean {
  return startedMtimeMs !== undefined && diskMtimeMs !== null && diskMtimeMs > startedMtimeMs;
}

/** Local `YYYY-MM-DD HH:MM:SS` of a bundle mtime (ledger style). */
export function bundleBuildStamp(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function poolDir(logDir: string): string {
  return join(logDir, "pool");
}

export function poolStatePath(logDir: string): string {
  return join(poolDir(logDir), "state.json");
}

export function poolMetricsPath(logDir: string): string {
  return join(poolDir(logDir), "metrics.jsonl");
}

export function poolPidPath(logDir: string): string {
  return join(poolDir(logDir), "host.pid");
}

export function readPoolState(logDir: string): PoolState | null {
  try {
    return JSON.parse(readFileSync(poolStatePath(logDir), "utf8")) as PoolState;
  } catch {
    return null;
  }
}

/** Persist the host's state (advisory file: a torn write costs a status read, not a task). */
export function writePoolState(state: PoolState, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* status is best effort */
  }
}

/** One pooled task's cache-carry record (first request of the task's turn). */
export interface PoolMetricRow {
  ts: string;
  id: string;
  provider: string;
  model: string;
  /** Task index within its slot (1 = the task that spawned the slot). */
  task: number;
  slotSession: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** Loopback providers: the server-side first-request share (the model itself reports no cache tokens). */
  firstShare?: number;
}

/** Append one task's carry record; accounting must never break a run. */
export function appendPoolMetric(row: PoolMetricRow, file: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* best effort */
  }
}

export function readPoolMetrics(file: string): PoolMetricRow[] {
  if (!existsSync(file)) return [];
  const rows: PoolMetricRow[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l) continue;
    try {
      const v = JSON.parse(l) as PoolMetricRow;
      if (typeof v.ts === "string" && typeof v.id === "string") rows.push(v);
    } catch {
      /* skip torn line */
    }
  }
  return rows;
}

/**
 * Cache-carry summary over pooled task records: how many tasks ran pooled
 * and how many tokens their FIRST request read from the provider cache —
 * the carry-over a fresh spawn would have missed.
 */
export interface PoolCarry {
  tasks: number;
  tokensCarried: number;
  /** cache_read / (read + write + fresh input) over the pooled first requests. */
  hitRatio: number;
}

export function poolCarry(rows: PoolMetricRow[]): PoolCarry {
  let read = 0;
  let write = 0;
  let fresh = 0;
  for (const r of rows) {
    read += r.cache_read_input_tokens ?? 0;
    write += r.cache_creation_input_tokens ?? 0;
    fresh += r.input_tokens ?? 0;
  }
  const denom = read + write + fresh;
  return { tasks: rows.length, tokensCarried: read, hitRatio: denom ? read / denom : 0 };
}

/** First-request carry of one provider: token-based for cloud providers, server-side share for local ones. */
export interface ProviderCarry {
  provider: string;
  /** Rows that carry a number (zero-report rows are dropped). */
  tasks: number;
  hitRatio: number;
  /** True when hitRatio is the mean router/server share rather than cache tokens. */
  server: boolean;
}

export function poolCarryByProvider(rows: PoolMetricRow[]): ProviderCarry[] {
  const groups = new Map<string, PoolMetricRow[]>();
  for (const r of rows) groups.set(r.provider, [...(groups.get(r.provider) ?? []), r]);
  const out: ProviderCarry[] = [];
  for (const [provider, rs] of groups) {
    const reported = rs.filter(
      (r) => (r.cache_read_input_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0) > 0
    );
    if (reported.length) {
      out.push({ provider, tasks: reported.length, hitRatio: poolCarry(reported).hitRatio, server: false });
      continue;
    }
    const shares = rs.flatMap((r) => (typeof r.firstShare === "number" ? [r.firstShare] : []));
    if (shares.length) {
      out.push({ provider, tasks: shares.length, hitRatio: shares.reduce((a, b) => a + b, 0) / shares.length, server: true });
    }
  }
  return out;
}

/** "anthropic 42% (5 tasks) · local 69% (63 tasks)", or "n/a" with no reporting rows. */
export function formatCarryByProvider(rows: PoolMetricRow[]): string {
  const parts = poolCarryByProvider(rows).map(
    (c) => `${c.provider} ${Math.round(c.hitRatio * 100)}% (${c.tasks} task${c.tasks === 1 ? "" : "s"}${c.server ? ", server" : ""})`
  );
  return parts.length ? parts.join(" · ") : "n/a";
}

// ---------------------------------------------------------------------------
// Eligibility — which runs may go through the pool at all
// ---------------------------------------------------------------------------

export interface PoolEligibilityInput {
  headless: boolean;
  prompt: string | null;
  /** Resolved provider name ("anthropic" for the built-in). */
  providerName: string;
  provider: Pick<WorkerProvider, "native" | "engine" | "protocol">;
  /** workers.pool.native; undefined = allowed. */
  nativeAllowed?: boolean;
  /**
   * The run will get its own git worktree (worktreeWanted: flag first, then
   * writable tools in a git cwd). A worktree is a fresh directory per run, so
   * a long-lived slot cannot serve it.
   */
  worktreeWanted: boolean;
  /**
   * The provider can serve worktree runs through slot worktrees (slots.ts):
   * loopback providers only. A worktree run is then pool-eligible.
   */
  slotWorktree?: boolean;
  resumeOf: string | undefined;
  printCmd: boolean | undefined;
  parsed: Pick<ParsedRunnerArgs, "callerSystemPrompt" | "callerMcpConfig" | "mcp" | "allowedTools">;
  /** Caller's --mcp flag value, when given. */
  mcpFlag: string | undefined;
  noBrowser: boolean;
  outputFormat: ParsedRunnerArgs["outputFormat"];
  /** Resolved cwd of the run; slots are keyed by it, so any existing directory pools. */
  cwd: string | undefined;
}

export type PoolIneligibleReason =
  | "pool-off"
  | "interactive"
  | "native-provider"
  | "engine"
  | "worktree"
  | "resume"
  | "print-cmd"
  | "system-prompt"
  | "mcp"
  | "browser"
  | "stream-json"
  | "tools"
  | "cwd";

/** Why a claim found no usable spare (the run then spawns fresh). */
export type SpareMissReason = "spares-off" | "no-worktree" | "not-git" | "no-spare" | "starting" | "stale" | "dirty-checkout" | "spare-dead" | "rename-failed";

/** The tool grant every slot is born with (== DEFAULT_WORKER_TOOLS in run.ts). */
const SLOT_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];

/**
 * A caller's --allowedTools is a deliberate restriction; a slot has the
 * default grant fixed at spawn. Only "no grant" or exactly the default set
 * gives the run what it asked for (MCP grants are screened by the mcp rule).
 */
export function toolGrantMatchesSlot(allowedTools: string[]): boolean {
  const names = allowedTools.flatMap((e) => e.split(",")).map((x) => x.trim()).filter((x) => x && !x.startsWith("mcp__"));
  if (!names.length) return true;
  const set = new Set(names);
  return set.size === SLOT_TOOLS.length && SLOT_TOOLS.every((t) => set.has(t));
}

/**
 * Why this run may not use the pool, or null when it may. Every reason is a
 * hard incompatibility with a slot whose system prompt, MCP config, tool
 * grants and cwd were fixed at spawn — the run would silently get a
 * different setup than the fresh spawn it asked for.
 */
export function poolIneligibleReason(input: PoolEligibilityInput): PoolIneligibleReason | null {
  if (!input.headless || input.prompt === null) return "interactive";
  // A native run on Claude Code's own login behaves like a fresh spawn inside a
  // slot (same env via buildRunEnv, same slim profile, model fixed in the slot
  // key, identical router pin); only caution kept it out. A worktree run is
  // refused by the "worktree" rule below. workers.pool.native=false switches it off.
  if ((input.providerName === ANTHROPIC_NATIVE || input.provider.native) && input.nativeAllowed === false) {
    return "native-provider";
  }
  if ((input.provider.engine ?? "claude") !== "claude") return "engine";
  if (input.worktreeWanted && !input.slotWorktree) return "worktree";
  if (input.resumeOf !== undefined) return "resume";
  if (input.printCmd === true) return "print-cmd";
  if (input.parsed.callerSystemPrompt) return "system-prompt";
  if (input.parsed.callerMcpConfig || input.mcpFlag || input.parsed.mcp.length) return "mcp";
  if (mcpServersFromToolGrants(input.parsed.allowedTools).length) return "mcp";
  if (!input.noBrowser && grantsChrome(input.parsed.allowedTools)) return "browser";
  if (input.outputFormat === "stream-json") return "stream-json";
  if (!toolGrantMatchesSlot(input.parsed.allowedTools)) return "tools";
  if (input.cwd === undefined || !existsSync(input.cwd)) return "cwd";
  return null;
}

// ---------------------------------------------------------------------------
// The task boundary — one delimiter per pooled turn
// ---------------------------------------------------------------------------

/**
 * The delimiter that opens every pooled task turn. A pooled session saw the
 * previous task's context; this line (plus the contract's own no-restating
 * rule) is the boundary: the new task is unrelated, prior turns must not be
 * referenced, and the fixed slot cwd is restated so absolute-path specs stay
 * anchored.
 */
export function poolTaskBoundary(taskNo: number, cwd: string): string {
  return (
    `<system-reminder>NEW TASK ${taskNo} — this session is a worker pool slot; the ` +
    `preceding turns were other, unrelated tasks by other workers. Ignore them ` +
    `completely: never reference, reuse or continue anything from them. Your working ` +
    `directory is ${cwd}; relative paths in the spec resolve there. Work only on the task ` +
    `below.</system-reminder>`
  );
}

/** Marker lines a spec uses to set its shared preamble apart from the per-unit part. */
export const SHARED_MARKER = "--- shared ---";
export const UNIT_MARKER = "--- unit ---";

/**
 * Split a spec written as `--- shared ---` … `--- unit ---` … into its shared
 * preamble (goes to the slot's system prompt, inside the cached prefix) and
 * the unit part. Without both markers in that order the spec is unchanged.
 */
export function splitSharedSpec(prompt: string): { shared: string | null; unit: string } {
  const lines = prompt.split("\n");
  const a = lines.findIndex((l) => l.trim() === SHARED_MARKER);
  const b = lines.findIndex((l, i) => i > a && l.trim() === UNIT_MARKER);
  if (a < 0 || b < 0) return { shared: null, unit: prompt };
  const shared = lines.slice(a + 1, b).join("\n").trim();
  if (!shared) return { shared: null, unit: prompt };
  const head = lines.slice(0, a).join("\n").trim();
  const unit = [head, lines.slice(b + 1).join("\n").trim()].filter(Boolean).join("\n\n");
  return { shared, unit };
}

/** The spec followed by the per-unit worktree note (worker id, branch): the stable text leads. */
export function pooledUnitPrompt(spec: string, worktreeNote: string): string {
  return worktreeNote ? `${spec}\n\n${worktreeNote}\n\n` : spec;
}

/** The full text fed to the slot for one task: boundary + spec + trailer. */
export function pooledTaskText(
  taskNo: number,
  cwd: string,
  prompt: string,
  trailer: string
): string {
  return `${poolTaskBoundary(taskNo, cwd)}\n\n${prompt}${trailer}`;
}

// ---------------------------------------------------------------------------
// Client: runWorker → pool host
// ---------------------------------------------------------------------------

/** The task payload a runWorker hands the pool host. */
export interface PoolTaskRequest {
  id: string;
  label: string;
  prompt: string;
  provider: string;
  model: string;
  /** The run's working directory; the slot is keyed by and runs in it. */
  cwd: string;
  className?: string;
  capability?: string;
  specPath?: string;
  parent?: string;
  stage?: string;
  /** The `pai worker run` client's pid: killing it cancels the pooled task (the host sees the disconnect). */
  clientPid?: number;
  reportFormat: "json" | "ag2";
  outputFormat: "text" | "json";
  /** The run wants its own worktree: served by a slot worktree (loopback providers only). */
  worktree?: boolean;
  /** Task time limit in minutes; null/0 = none. */
  maxMinutes: number | null;
  trailer: string;
  /** Claim a spare (POST /claim): the host binds this id to a pre-started worker in its own worktree. */
  spare?: boolean;
  /** Epoch ms when the run started: setupMs of a hit counts from here to the task being fed. */
  runStartedAt?: number;
  /** Ms the client spent in the capacity + stagger gates before shipping the task (ledger split of setupMs). */
  admissionMs?: number;
}

/** What the host answers: either the finished task or a refusal to pool it. */
export interface PoolTaskResponse {
  pooled: boolean;
  reason?: PoolIneligibleReason | SpareMissReason | "busy" | "host-error";
  rc?: number;
  resultEvent?: StreamEvent | null;
  report?: WorkerReport | null;
  status?: WorkerStatus | null;
}

/** The pool host's HTTP health shape. */
export function poolPort(config: WorkersConfig): number {
  return config.pool?.port ?? DEFAULT_POOL_PORT;
}

/**
 * Post one task to the pool host. Resolves null when the host is not
 * listening (callers fall back to a fresh spawn); resolves a PoolTaskResponse
 * otherwise. No undici here: the host holds the connection for the whole task
 * (minutes), which Node's fetch would cut off with its 300 s headers timeout.
 */
export function postTaskToPool(
  port: number,
  task: PoolTaskRequest,
  timeoutMs: number,
  path: "/task" | "/claim" = "/task"
): Promise<PoolTaskResponse | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify(task);
    const req = httpRequest(
      {
        host: LOOPBACK_HOST,
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as PoolTaskResponse);
          } catch {
            resolve(null);
          }
        });
        res.on("error", () => resolve(null));
      }
    );
    // the timer bounds connect+send only; the response may take the whole task
    req.setTimeout(timeoutMs, () => {
      // a deadline firing here is the task's own limit: the host kills the
      // slot and answers on its own; abandoning the socket is the client's
      // best move and the fresh-spawn fallback is NOT taken mid-task
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end(body);
  });
}

/** Answer of one /healthz probe: `timeout` = connected or queued but no answer in time (a busy caller or host), `down` = refused, reset or not 200. */
export type HostProbe = "up" | "down" | "timeout";

export function poolHostProbe(port: number, timeoutMs = 500): Promise<HostProbe> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: LOOPBACK_HOST, port, path: "/healthz", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200 ? "up" : "down"));
      res.on("error", () => resolve("down"));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve("timeout");
    });
    req.on("error", () => resolve("down"));
    req.end();
  });
}

/** Cheap host probe for `pai worker pool status` and the on/off commands. */
export async function poolHostAlive(port: number, timeoutMs = 500): Promise<boolean> {
  return (await poolHostProbe(port, timeoutMs)) === "up";
}

// ---------------------------------------------------------------------------
// Host-side task execution (also exercised by the host tests through the
// createPoolHost deps hook — the same code path the detached process runs)
// ---------------------------------------------------------------------------

/** Spawning surface of a slot process; injectable so tests run a fake claude. */
export interface SlotProcess {
  pid: number;
  write(line: string): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

/** How the host obtains a slot process; the real impl spawns `claude`. */
export type SlotSpawner = (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => SlotProcess;

/** Hash of the identity a slot is pinned to: provider, model and its cwd. */
export function slotKey(provider: string, model: string, cwd: string): string {
  return `${provider}\u0000${model}\u0000${cwd}`;
}

/** Cached share of a first request's prompt tokens (null when it carried no numbers). */
export function firstRequestShare(u: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): number | null {
  const read = u.cache_read_input_tokens ?? 0;
  const total = (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0);
  return total > 0 ? read / total : null;
}

/** Cold prefill speed of the local server (measured), tokens per second. */
export const LOCAL_PREFILL_TOK_PER_S = 1100;

/**
 * Cached share of a local first request, inferred from a router usage row: the time to first token
 * against the time a full cold prefill of input_tokens would take. Null for short prompts (under 2000
 * tokens) or rows without numbers.
 */
export function routerRowShare(row: { input_tokens?: number; ttftMs?: number }): number | null {
  const n = row.input_tokens ?? 0;
  if (n < 2000 || row.ttftMs == null) return null;
  const coldMs = (n / LOCAL_PREFILL_TOK_PER_S) * 1000;
  const share = Math.min(1, Math.max(0, 1 - row.ttftMs / coldMs));
  return Math.round(share * 1000) / 1000;
}

/** The share of the FIRST router row (file order) of one claude session; lines are router-usage.jsonl lines. */
export function firstRouterShare(lines: string[], sessionId: string): number | null {
  for (const line of lines) {
    let row: { session_id?: string; input_tokens?: number; ttftMs?: number };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.session_id === sessionId) return routerRowShare(row);
  }
  return null;
}

/** "warm" when most of the first request came from the prefix cache. */
export function warmOrCold(share: number | null | undefined): "warm" | "cold" | null {
  return share == null ? null : share >= 0.8 ? "warm" : "cold";
}

/**
 * Decide which idle slot serves a task, or whether a new slot may spawn.
 * Pure over the slot list so tests can drive it directly.
 */
export function pickSlot(
  slots: PoolSlotRecord[],
  key: string,
  maxSlots: number,
  nowMs: number,
  idleSecs: number
): { slot: PoolSlotRecord | null; evict: PoolSlotRecord | null; canSpawn: boolean } {
  const alive = (s: PoolSlotRecord): boolean => {
    try {
      process.kill(s.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const fresh = slots.filter((s) => alive(s));
  const match = fresh.find((s) => slotKey(s.provider, s.model, s.cwd) === key && !s.busyWith);
  if (match) return { slot: match, evict: null, canSpawn: false };
  if (fresh.length < maxSlots) return { slot: null, evict: null, canSpawn: true };
  // at capacity: make room by evicting the longest-idle idle slot — capacity
  // is shared across keys, like connections in a DB pool. A fully busy pool
  // refuses, and the client falls back to a fresh spawn.
  const evict =
    fresh
      .filter((s) => !s.busyWith)
      .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt))[0] ?? null;
  return { slot: null, evict, canSpawn: evict !== null };
}

/** Whether a slot idled long enough to be reaped (idleSecs 0 = never). */
export function slotIdleFor(s: PoolSlotRecord, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - Date.parse(s.lastUsedAt)) / 1000));
}

export function slotShouldReap(s: PoolSlotRecord, nowMs: number, idleSecs: number): boolean {
  if (idleSecs <= 0 || s.busyWith) return false;
  return slotIdleFor(s, nowMs) >= idleSecs;
}

/**
 * Pure check: which usage numbers mark a task's first request as cache-carried.
 * The proof bar from the spec: a pooled task's first request should read the
 * bulk of its prompt from cache, where a fresh spawn reads ~13%.
 */
export function carriedShare(u: UsageBlock | undefined): number | null {
  if (!u) return null;
  const denom = inputSideTokens(u);
  if (!denom) return null;
  return (u.cache_read_input_tokens ?? 0) / denom;
}

// ---------------------------------------------------------------------------
// Spares — pre-started task-less workers, one task each
// ---------------------------------------------------------------------------

/** The identity a claim matches: repo root, provider, model. */
export function spareKey(repo: string, provider: string, model: string): string {
  return `${repo}\u0000${provider}\u0000${model}`;
}

/** A key stays warm for this long after a worker last ran on it. */
export const SPARE_WARM_WINDOW_MS = 60 * 60_000;

export interface WarmKey {
  provider: string;
  model: string;
  cwd: string;
}

/** (provider, model, cwd) triples of the workers that started within the warm window, newest first, from ledger text. */
export function recentWarmKeys(ledgerText: string, nowMs: number): WarmKey[] {
  const seen = new Map<string, WarmKey>();
  for (const l of parseLedger(ledgerText).reverse()) {
    if (l.event !== "WORKER-START" || l.fields.mode !== "headless") continue;
    const t = Date.parse(l.stamp.replace(" ", "T"));
    if (!Number.isFinite(t) || nowMs - t > SPARE_WARM_WINDOW_MS) continue;
    const { provider, model, cwd } = l.fields;
    if (!provider || !model || !cwd) continue;
    const k = `${provider}\u0000${model}\u0000${cwd}`;
    if (!seen.has(k)) seen.set(k, { provider, model, cwd });
  }
  return [...seen.values()];
}

export interface SpareStats {
  /** WORKER-END lines of workers that ran on a spare (setupMs and firstAnswerMs ride there). */
  hits: number;
  /** Starts that asked the pool and got a fresh spawn. */
  misses: number;
  missReasons: Record<string, number>;
  meanHitSetupMs: number | null;
  meanMissSetupMs: number | null;
  /** Mean fresh setup minus mean hit setup (null until both sides have data). */
  meanSavedMs: number | null;
}

/** Spare claim statistics from ledger text: setupMs of hits against the fresh spawns that asked the pool and missed. */
export function spareStats(ledgerText: string): SpareStats {
  const hit: number[] = [];
  const miss: number[] = [];
  const reasons: Record<string, number> = {};
  let hits = 0;
  let misses = 0;
  for (const l of parseLedger(ledgerText)) {
    if (l.event === "WORKER-POOL-MISS") {
      misses += 1;
      const r = l.fields.reason ?? "?";
      reasons[r] = (reasons[r] ?? 0) + 1;
      continue;
    }
    if (l.event !== "WORKER-END") continue;
    const ms = Number(l.fields.setupMs);
    if (l.fields.spare === "hit") {
      hits += 1;
      if (Number.isFinite(ms)) hit.push(ms);
    } else if (l.fields.spare === "miss" && Number.isFinite(ms)) {
      miss.push(ms);
    }
  }
  const mean = (a: number[]): number | null => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const h = mean(hit);
  const m = mean(miss);
  return { hits, misses, missReasons: reasons, meanHitSetupMs: h, meanMissSetupMs: m, meanSavedMs: h !== null && m !== null ? m - h : null };
}

/** Whether a spare idled long enough to be retired (idleKillSec 0 = never). */
export function spareShouldRetire(createdAtMs: number, nowMs: number, idleKillSec: number): boolean {
  return idleKillSec > 0 && nowMs - createdAtMs >= idleKillSec * 1000;
}
