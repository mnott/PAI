/**
 * ops — the MCP tools for the service and maintenance verbs the CLI and the
 * cockpit already have: daemon_service, router_service, model_runtime,
 * memory_run, worker_kill, worker_gc, pool_status.
 *
 * Extracted like worker-model.ts (index.ts starts its transport on import).
 * Every handler is a thin wrapper over the function the CLI / cockpit action
 * calls; nothing is re-implemented here.
 */

import { workersLogDir } from "../../workers/paths.js";
import { readWorkersSection } from "../../workers/config.js";
import { cliEntry } from "../../daemon/pass-priority.js";
import type { WorkerToolResult } from "./worker-model.js";

const text = (s: string): WorkerToolResult => ({ content: [{ type: "text", text: s }] });
const error = (e: unknown): WorkerToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Run a CLI implementation that prints with console.*, return what it printed (stdout is the MCP transport). */
async function captured(fn: () => number | Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const push = (...a: unknown[]): void => void lines.push(stripAnsi(a.map(String).join(" ")));
  console.log = push;
  console.error = push;
  console.warn = push;
  try {
    return { code: await fn(), lines };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    console.warn = saved.warn;
  }
}

const logDir = (): string => workersLogDir(readWorkersSection().workers);

export interface DaemonServiceArgs {
  action?: "status" | "start" | "stop" | "restart";
}

/** pai daemon status|start|stop|restart. */
export async function daemonService(args: DaemonServiceArgs): Promise<WorkerToolResult> {
  try {
    const action = args.action ?? "status";
    const impl = await import("../../cli/impl/daemon.js");
    const fn = { status: impl.daemonStatusCmd, start: impl.daemonStartCmd, stop: impl.daemonStopCmd, restart: impl.daemonRestartCmd }[action];
    if (!fn) return error(new Error(`unknown action "${String(action)}" (expected: status, start, stop, restart)`));
    const r = await captured(fn);
    const body = r.lines.join("\n").trim() || `daemon ${action}: exit ${r.code}`;
    return r.code === 0 ? text(body) : error(new Error(body));
  } catch (e) {
    return error(e);
  }
}

export interface RouterServiceArgs {
  action?: "status" | "start" | "stop" | "restart";
}

/** pai router status|start|stop|restart. */
export async function routerService(args: RouterServiceArgs): Promise<WorkerToolResult> {
  try {
    const action = args.action ?? "status";
    const svc = await import("../../router/service-control.js");
    if (action === "status") return text(svc.routerStatusText());
    if (action === "start") return text(svc.routerStartText(cliEntry()));
    if (action === "stop") return text(svc.routerStopText());
    if (action === "restart") return text(await svc.routerRestartText(cliEntry()));
    return error(new Error(`unknown action "${String(action)}" (expected: status, start, stop, restart)`));
  } catch (e) {
    return error(e);
  }
}

export interface ModelRuntimeArgs {
  runtime?: string;
  action?: "status" | "start" | "stop";
  /** start/stop: the model to load or unload (docker model run|unload). */
  model?: string;
}

/** pai models start|stop <runtime> (the cockpit's runtime action); status reads the runtime's inventory row. */
export async function modelRuntime(args: ModelRuntimeArgs): Promise<WorkerToolResult> {
  try {
    const action = args.action ?? "status";
    if (action === "status") {
      const { currentInventory } = await import("../../workers/model-inventory.js");
      const inv = await currentInventory();
      const rows = args.runtime ? inv.runtimes.filter((r) => r.name === args.runtime) : inv.runtimes;
      if (args.runtime && !rows.length) return error(new Error(`no runtime "${args.runtime}" (known: ${inv.runtimes.map((r) => r.name).join(", ") || "none"})`));
      return text(rows.map((r) => `${r.name}: ${r.status}${r.port != null ? ` port ${r.port}` : ""}; models ${r.models.map((m) => `${m.model}${m.loaded ? "*" : ""}`).join(", ") || "none"}`).join("\n") || "no runtimes");
    }
    if (action !== "start" && action !== "stop") return error(new Error(`unknown action "${String(action)}" (expected: status, start, stop)`));
    if (!args.runtime) return error(new Error(`runtime is required for action "${action}"`));
    const { defaultDeps, runtimeStartStop } = await import("../../router/cockpit-actions.js");
    const r = await runtimeStartStop(args.runtime, action, defaultDeps(), { model: args.model });
    return r.ok ? text(r.message) : error(new Error(r.message));
  } catch (e) {
    return error(e);
  }
}

export interface MemoryRunArgs {
  action?: "status" | "embed" | "index" | "stop";
}

/** The cockpit's memory.embed / memory.index / memory.stop; status reads the run marker and the embed backlog. */
export async function memoryRun(args: MemoryRunArgs): Promise<WorkerToolResult> {
  try {
    const action = args.action ?? "status";
    const ca = await import("../../router/cockpit-actions.js");
    const deps = ca.defaultDeps();
    if (action === "status") {
      const { readRun } = await import("../../memory/run-state.js");
      const { fetchDaemonMemory } = await import("../../router/cockpit-memory.js");
      const run = readRun(deps.home);
      const backlog = (await fetchDaemonMemory())?.embedBacklog;
      return text(`${run ? `${run.kind} running (started by ${run.by}, pid ${run.pid})` : "no memory run active"}; embed backlog ${backlog ?? "unknown"}`);
    }
    if (action === "stop") {
      const r = ca.stopMemoryRun(deps);
      return r.ok ? text(r.message) : error(new Error(r.message));
    }
    if (action !== "embed" && action !== "index") return error(new Error(`unknown action "${String(action)}" (expected: status, embed, index, stop)`));
    const refused = await ca.memoryRunRefusal(deps);
    if (refused) return error(new Error(refused));
    const { fetchDaemonMemory } = await import("../../router/cockpit-memory.js");
    if (action === "embed" && (await fetchDaemonMemory())?.embedBacklog === 0) return text("nothing to embed (backlog 0)");
    ca.writeLedgerLine(deps, `memory.${action}`, action, "started (mcp)");
    void ca.spawnMemoryRun(action, "", deps.home, undefined, cliEntry()).catch(() => undefined);
    return text(action === "embed" ? "embedding the backlog (memory_run status to follow it, memory_run stop to end it)" : "indexing (memory_run status to follow it, memory_run stop to end it)");
  } catch (e) {
    return error(e);
  }
}

export interface WorkerKillArgs {
  id: string;
  only?: boolean;
  force?: boolean;
  reason: string;
}

/** pai worker kill (pooled workers stop through the pool host). */
export async function workerKill(args: WorkerKillArgs): Promise<WorkerToolResult> {
  try {
    const { killWorker } = await import("../../workers/kill-tree.js");
    const lines = await killWorker(logDir(), args.id, { only: args.only === true, caller: { env: process.env, force: args.force === true }, reason: args.reason });
    return text(lines.join("\n") || `${args.id}: stopped`);
  } catch (e) {
    return error(e);
  }
}

export interface WorkerGcArgs {
  older_than_hours?: number;
  all_finished?: boolean;
  pool?: boolean;
  foreign?: boolean;
  kill_orphans?: boolean;
  dry_run?: boolean;
}

/** pai worker gc. Defaults to a dry run: the MCP caller must pass dry_run=false to archive anything. */
export async function workerGc(args: WorkerGcArgs): Promise<WorkerToolResult> {
  try {
    const { runWorkerGc } = await import("../../workers/gc-run.js");
    const lines: string[] = [];
    await runWorkerGc(
      logDir(),
      {
        olderThanHours: args.older_than_hours,
        allFinished: args.all_finished,
        pool: args.pool,
        foreign: args.foreign,
        killOrphans: args.kill_orphans,
        dryRun: args.dry_run !== false,
      },
      (l) => void lines.push(l)
    );
    return text(lines.join("\n"));
  } catch (e) {
    return error(e);
  }
}

/** pai worker pool status. */
export async function poolStatus(): Promise<WorkerToolResult> {
  try {
    const { poolStatusText } = await import("../../workers/pool-cli.js");
    return text(await poolStatusText(logDir()));
  } catch (e) {
    return error(e);
  }
}

export interface WorkerMergeArgs {
  id: string;
  no_commit?: boolean;
  verify?: string;
  no_verify?: boolean;
  no_verify_tests?: boolean;
  no_build?: boolean;
}

/** pai worker merge: same function, same gates (verify, stub scan, related tests, dist rebuild). */
export async function workerMerge(args: WorkerMergeArgs): Promise<WorkerToolResult> {
  try {
    const { mergeWorker, RelatedTestsFailedError } = await import("../../workers/worktree.js");
    const { readMergeVerify } = await import("../../workers/workers-config.js");
    const verify = args.verify ?? (args.no_verify ? undefined : readMergeVerify());
    const r = await captured(() => {
      try {
        console.log(mergeWorker(logDir(), args.id, { noCommit: args.no_commit === true, verify, verifyTests: args.no_verify_tests !== true, rebuild: args.no_build !== true }));
        return 0;
      } catch (e) {
        if (e instanceof RelatedTestsFailedError) {
          console.log(`${e.message}\nthe merge was kept; fix forward or revert it`);
          return 3;
        }
        throw e;
      }
    });
    const body = r.lines.join("\n").trim();
    return r.code === 0 ? text(body) : error(new Error(body));
  } catch (e) {
    return error(e);
  }
}

/** The battery guard's state: last reading, gate (pause/stop, benchmark stop) and the benchmark marker. */
export async function batteryStatus(args: { window_hours?: number } = {}): Promise<WorkerToolResult> {
  try {
    const g = await import("../../daemon/battery-guard.js");
    const hours = Math.min(Math.max(args.window_hours ?? 12, 1 / 60), 14 * 24);
    const tel = g.summarizeTelemetry(hours * 3600_000);
    const w = (s: { max: number; avg: number } | null): string => (s ? `max ${s.max} W, avg ${s.avg} W` : "no data");
    const w0 = (v: number | null | undefined): string => (typeof v === "number" ? `${v} W` : "n/a");
    const telLines = tel
      ? [
          `latest telemetry (${tel.ageS} s ago): adapter ${w0(tel.latest.adapterWatts)}, system power in ${w0(tel.latest.systemPowerInW)}, system load ${w0(tel.latest.systemLoadW)}, battery ${w0(tel.latest.batteryW)}, ${tel.latest.pct ?? "n/a"} %`,
          `last ${hours} h (${tel.samples} samples): system power in ${w(tel.systemPowerInW)}; system load ${w(tel.systemLoadW)}; max battery drain ${tel.maxDrainW === null ? "no data" : `${tel.maxDrainW} W`}; min charge ${tel.minPct === null ? "no data" : `${tel.minPct} %`}`,
        ]
      : ["no telemetry yet"];
    const line = g.batteryCockpitLine();
    const gate = g.readBatteryGate();
    const marker = g.liveBenchmarkMarker();
    return text(
      [
        `battery: ${line || "no recent reading (guard off, not macOS, or daemon not running)"}`,
        `gate: ${gate ? `${gate.phase}${gate.reason ? ` — ${gate.reason}` : ""}${gate.benchStop ? ` · benchmark stop: ${gate.benchReason ?? "battery low"}` : ""}` : "no gate file"}`,
        `benchmark marker: ${marker ? `${marker.label} (pid ${marker.pid})` : "none"}`,
        ...telLines,
      ].join("\n")
    );
  } catch (e) {
    return error(e);
  }
}
