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
 * Cwd: a slot process has ONE cwd (fixed at spawn, the host's neutral
 * directory, workers.logDir). Tasks are pooled only when their own cwd is
 * that same directory — i.e. specs written against absolute paths; anything
 * else falls through to a fresh spawn rather than run in the wrong tree.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { ANTHROPIC_NATIVE, type WorkersConfig, type WorkerProvider } from "./config.js";
import { grantsChrome, mcpServersFromToolGrants } from "./mcp.js";
import type { ParsedRunnerArgs } from "./args.js";
import type { StreamEvent, UsageBlock } from "./run.js";
import type { WorkerReport } from "./report.js";
import type { WorkerStatus } from "./status.js";
import { workersLogDir } from "./paths.js";

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
}

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  enabled: false,
  maxSlots: 3,
  idleSecs: 900,
  port: 8798,
};

export function poolSettings(config: WorkersConfig): PoolSettings {
  const p = config.pool;
  return {
    enabled: p?.enabled === true,
    maxSlots: p?.maxSlots ?? DEFAULT_POOL_SETTINGS.maxSlots,
    idleSecs: p?.idleSecs ?? DEFAULT_POOL_SETTINGS.idleSecs,
    port: p?.port ?? DEFAULT_POOL_SETTINGS.port,
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

// ---------------------------------------------------------------------------
// Eligibility — which runs may go through the pool at all
// ---------------------------------------------------------------------------

export interface PoolEligibilityInput {
  headless: boolean;
  prompt: string | null;
  /** Resolved provider name ("anthropic" for the built-in). */
  providerName: string;
  provider: Pick<WorkerProvider, "native" | "engine" | "protocol">;
  worktreeFlag: boolean | undefined;
  resumeOf: string | undefined;
  printCmd: boolean | undefined;
  parsed: Pick<ParsedRunnerArgs, "callerSystemPrompt" | "callerMcpConfig" | "mcp" | "allowedTools">;
  /** Caller's --mcp flag value, when given. */
  mcpFlag: string | undefined;
  noBrowser: boolean;
  outputFormat: ParsedRunnerArgs["outputFormat"];
  /** Resolved cwd of the run (undefined = caller's own process cwd). */
  cwd: string | undefined;
  /** The cwd pooled slots run in. */
  slotCwd: string;
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
  | "cwd";

/**
 * Why this run may not use the pool, or null when it may. Every reason is a
 * hard incompatibility with a slot whose system prompt, MCP config, tool
 * grants and cwd were fixed at spawn — the run would silently get a
 * different setup than the fresh spawn it asked for.
 */
export function poolIneligibleReason(input: PoolEligibilityInput): PoolIneligibleReason | null {
  if (!input.headless || input.prompt === null) return "interactive";
  if (input.providerName === ANTHROPIC_NATIVE || input.provider.native) return "native-provider";
  if ((input.provider.engine ?? "claude") !== "claude") return "engine";
  if (input.worktreeFlag !== false) return "worktree";
  if (input.resumeOf !== undefined) return "resume";
  if (input.printCmd === true) return "print-cmd";
  if (input.parsed.callerSystemPrompt) return "system-prompt";
  if (input.parsed.callerMcpConfig || input.mcpFlag || input.parsed.mcp.length) return "mcp";
  if (mcpServersFromToolGrants(input.parsed.allowedTools).length) return "mcp";
  if (!input.noBrowser && grantsChrome(input.parsed.allowedTools)) return "browser";
  if (input.outputFormat === "stream-json") return "stream-json";
  if (input.cwd !== undefined && input.cwd !== input.slotCwd) return "cwd";
  return null;
}

/**
 * The pool host's cwd: a neutral directory no spec should depend on. The
 * workers logDir keeps slots out of every repo; the boundary line tells the
 * model where it runs so absolute-path specs stay correct.
 */
export function poolSlotCwd(config: WorkersConfig): string {
  return workersLogDir(config);
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
    `directory is ${cwd}; the task spec uses absolute paths. Work only on the task ` +
    `below.</system-reminder>`
  );
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
  className?: string;
  capability?: string;
  specPath?: string;
  parent?: string;
  stage?: string;
  reportFormat: "json" | "ag2";
  outputFormat: "text" | "json";
  /** Task time limit in minutes; null/0 = none. */
  maxMinutes: number | null;
  trailer: string;
}

/** What the host answers: either the finished task or a refusal to pool it. */
export interface PoolTaskResponse {
  pooled: boolean;
  reason?: PoolIneligibleReason | "busy" | "host-error";
  rc?: number;
  resultEvent?: StreamEvent | null;
  report?: WorkerReport | null;
  status?: WorkerStatus | null;
}

/** The pool host's HTTP health shape. */
export function poolPort(config: WorkersConfig): number {
  return config.pool?.port ?? 8798;
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
  timeoutMs: number
): Promise<PoolTaskResponse | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify(task);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/task",
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

/** Cheap host probe for `pai worker pool status` and the on/off commands. */
export function poolHostAlive(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/healthz", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200));
      res.on("error", () => resolve(false));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Host-side task execution (also exercised by the host tests through the
// createPoolHost deps hook — the same code path the detached process runs)
// ---------------------------------------------------------------------------

export interface PooledRunResult {
  rc: number;
  resultEvent: StreamEvent | null;
  report: WorkerReport | null;
  status: WorkerStatus;
}

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

export interface PoolHostDeps {
  spawner: SlotSpawner;
  /** Slot env builder — buildRunEnv in production. */
  envFor: (providerName: string, provider: WorkerProvider) => NodeJS.ProcessEnv;
  /** Argv head of the claude binary — claudeCommand in production. */
  cmdHead: (env: NodeJS.ProcessEnv, caveman: boolean) => string[];
  now: () => Date;
}

/** Hash of the identity a slot is pinned to: provider, model and its cwd. */
export function slotKey(provider: string, model: string, cwd: string): string {
  return `${provider}\u0000${model}\u0000${cwd}`;
}

export function shortSlotKey(key: string): string {
  return key.replaceAll("\u0000", "/");
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

/** Input the host needs to execute one pooled task. Rebuilt per task. */
export interface PoolHostTask extends PoolTaskRequest {
  providerObj: WorkerProvider;
  noBrowser: boolean;
  proxyUrl?: string;
  contract: string | null;
  addendum: string | null;
}

/**
 * Pure check: which usage numbers mark a task's first request as cache-carried.
 * The proof bar from the spec: a pooled task's first request should read the
 * bulk of its prompt from cache, where a fresh spawn reads ~13%.
 */
export function carriedShare(u: UsageBlock | undefined): number | null {
  if (!u) return null;
  const denom =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  if (!denom) return null;
  return (u.cache_read_input_tokens ?? 0) / denom;
}
