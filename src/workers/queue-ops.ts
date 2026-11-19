/**
 * queue-ops.ts — reads the one queue table of the machine and runs its per-job / per-session actions.
 * Shared by `pai worker queue` and the cockpit router (/cockpit/queue, /cockpit/queue/act) so both do the same.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadStatus, loadStatusesCached, ownsPidCached, saveStatus, isLive, pausedFree, type WorkerStatus } from "./status.js";
import { isLocalProvider, type WorkersConfig } from "./config.js";
import { capacityOf, providerCap, queueDir, queueRows, reorderQueue, reorderQueueTo, liveQueue, writeTicket } from "./capacity.js";
import { loadPaneRunStatuses } from "./pane-run.js";
import { ownerSessionName } from "./scope.js";
import { frozenSince, freezeAll, thawSome, realFreezeDeps } from "./freeze.js";
import { setWorkerPaused } from "./engine-control.js";
import { applyPriority, resumeWorker, type PriorityLevel } from "./preempt.js";
import { deepFreeze, deepResume, deepfrozenIds, realDeepFreezeDeps, realDeepResumeDeps, realRepoOf, type DeepSelect } from "./deepfreeze.js";
import { buildQueueTable, readTaskText, taskSummary, type RowAction, type TableRow } from "./queue-table.js";
import { cachedTldr } from "./helper-uses.js";
import { readSchedFile, type SchedSnapshot } from "../router/scheduler.js";

/** The table of the machine's workers right now. `deepFrozen` stays empty until `pai stop` records its jobs.
 *  `sched` is the router's local-scheduler snapshot (the activity word reads it for in-flight / in-line);
 *  absent = read from disk, null when the router cannot be reached (then the word falls back to the status file). */
export function readQueueTable(logDir: string, workers: WorkersConfig, now = Date.now(), deepFrozen?: (id: string) => boolean, owns: (s: { pid: number; started: string; id?: string }) => boolean = ownsPidCached, sched: SchedSnapshot | null | undefined = readSchedFile(logDir, now)): TableRow[] {
  const caps: Record<string, number | undefined> = {};
  for (const name of Object.keys(workers.providers)) caps[name] = providerCap(workers, name);
  const statuses = loadStatusesCached(logDir);
  const local = (p: string): boolean => {
    const prov = workers.providers[p];
    return !!prov && isLocalProvider(prov.baseUrl);
  };
  const deep = deepFrozen ?? ((id: string) => deepFrozenSet.has(id));
  const deepFrozenSet = deepfrozenIds();
  const live = statuses.filter((s) => s.state === "queued" || (s.state === "running" && owns(s)) || (s.state === "deepfrozen" && deep(s.id)));
  return buildQueueTable({
    statuses: live,
    queue: queueRows(logDir, caps, undefined, statuses),
    panes: loadPaneRunStatuses(logDir, now),
    now,
    isLocal: local,
    sessionOf: (s) => {
      const n = ownerSessionName(s);
      return n.startsWith("tab ") || n === "?" ? "other" : n;
    },
    // the task cell's tooltip: a cached local-model TL;DR, else the first lines of the prompt copy the run kept
    summaryOf: (s) => {
      const text = readTaskText(logDir, s);
      // cached 2-sentence TL;DR from the small local model; generated in the background, the rule-based first sentences meanwhile
      return cachedTldr(logDir, s.id, text) ?? taskSummary(text);
    },
    caps,
    idleExtraMax: workers.capacity?.idleExtraMax,
    isAlive: (pid) => owns({ pid, started: "" }),
    frozen: (id) => frozenSince(id) !== undefined,
    deepFrozen: deep,
    sched,
  });
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** The row's state after the action (the row shows its effect at once). */
  state?: string;
}

export interface OpsDeps {
  logDir: string;
  workers: WorkersConfig;
  by: string;
  /** Test seam: whether a running status's process is alive (default: the pid/start check). */
  owns?: (s: { pid: number; started: string; id?: string }) => boolean;
  /** Moves a job to cloud/local (reroute); injected so tests and the router pick the starter. */
  reroute?: (id: string, where: "cloud" | "local") => Promise<string>;
  /** Deep-freeze / resume (default: the `pai stop` / `pai resume` engine, workers/deepfreeze.ts); injected by tests. */
  deepFreeze?: (logDir: string, by: string, sel: DeepSelect | undefined, resume: boolean) => Promise<string>;
}

/** `pai stop [<id>|--session <name>]` / `pai resume [...]` itself; no selection = everything. */
async function realDeep(logDir: string, by: string, sel: DeepSelect | undefined, resume: boolean): Promise<string> {
  if (resume) {
    const r = await deepResume(logDir, await realDeepResumeDeps(), { only: sel });
    if (r.failed.length) throw new Error(r.lines.filter((l) => l.includes("failed")).join("; "));
    return r.lines.join("; ");
  }
  const deps = await realDeepFreezeDeps();
  return (await deepFreeze(logDir, by, deps, { repoOf: (s) => realRepoOf(s, deps.git), only: sel })).lines.join("; ");
}

const stateOf = (d: OpsDeps, id: string): string | undefined => readQueueTable(d.logDir, d.workers, Date.now(), undefined, d.owns).find((r) => r.id === id)?.stateText;

/** Started jobs on a provider right now — the same accounting the capacity gate uses (running, live, not an operator pause that freed its slot). */
function startedOn(d: OpsDeps, s: WorkerStatus): number {
  return loadStatusesCached(d.logDir).filter((x) => x.provider === s.provider && x.state === "running" && !pausedFree(x) && isLive(x, d.owns ?? ownsPidCached)).length;
}

/**
 * "start now": admit this waiting job at once, over the provider's nominal cap. The ceiling is the one engine-idle
 * admission uses — cap + idleExtraMax started jobs — and beyond it nothing starts (the row shows the reason).
 * A run already queued at the gate takes its grant on the next poll; a paused resumed worker gets its ticket at
 * the head of the line and the waiting loop picks the wait up. Nothing else moves.
 */
function startNow(d: OpsDeps, id: string, s: WorkerStatus): string {
  const cap = providerCap(d.workers, s.provider);
  if (cap !== undefined && cap > 0) {
    const extraMax = capacityOf(d.workers.capacity).idleExtraMax;
    const started = startedOn(d, s);
    if (started >= cap + extraMax) throw new Error(`the limit of started jobs on ${s.provider} is reached (${started} of ${cap} slots + ${extraMax} over)`);
  }
  if (s.state === "queued") return `starting now${cap !== undefined ? `, over the cap of ${cap}` : ""}: takes its slot at once`;
  // a paused resumed worker waiting for its turn: mark it started-over-cap and put its ticket at the head; with no queue file (no wait loop alive), start it outright
  if (!existsSync(join(queueDir(d.logDir, s.provider), s.id))) {
    const r = setWorkerPaused(d.logDir, s.id, false, `${d.by}:start-now`);
    return r ? `started now${cap !== undefined && startedOn(d, s) > cap ? ", over the cap" : ""}` : "was not paused";
  }
  reorderQueue(d.logDir, s.provider, s.id, "front");
  const fresh = loadStatus(d.logDir, id) ?? s;
  if (cap !== undefined && startedOn(d, fresh) >= cap) {
    fresh.overCapBy = d.by;
    saveStatus(d.logDir, fresh);
  }
  return `first in line and past the cap: starts at once${cap !== undefined ? ` (over the cap of ${cap}, up to ${cap + capacityOf(d.workers.capacity).idleExtraMax})` : ""}`;
}

/** One action on one job. Throws nothing: an error is the result's message. */
export async function runRowAction(d: OpsDeps, action: RowAction, id: string): Promise<ActionResult> {
  try {
    let message: string;
    const st = loadStatus(d.logDir, id);
    const needJob = (): NonNullable<typeof st> => {
      if (!st) throw new Error(`no worker named "${id}"`);
      return st;
    };
    switch (action) {
      case "next":
      case "up":
      case "down": {
        const s = needJob();
        const order =
          action === "down"
            ? reorderQueueTo(d.logDir, s.provider, id, Math.min(liveQueue(d.logDir, s.provider).length, liveQueue(d.logDir, s.provider).indexOf(id) + 2))
            : reorderQueue(d.logDir, s.provider, id, action === "next" ? "front" : "up");
        message = `now position ${order.indexOf(id) + 1} of ${order.length}`;
        break;
      }
      case "pause": {
        // a resumed worker that waits for its turn: pausing it again just leaves the queue (nobody else is touched)
        const tp = join(queueDir(d.logDir, needJob().provider), id);
        if (existsSync(tp) && st?.paused && !st.pausedBy) {
          rmSync(tp, { force: true });
          message = "paused again; left the queue";
          break;
        }
        message = setWorkerPaused(d.logDir, id, true, d.by) ? "paused; its slot is free for the next job" : "already paused";
        break;
      }
      case "back-to-queue": {
        // running → the front of its provider's waiting list: parked like a pause (slot freed, process and context kept), plus a ticket at position 1
        const s = needJob();
        if (!setWorkerPaused(d.logDir, id, true, d.by)) throw new Error(s.paused ? "already paused" : `worker ${id} is ${s.state}; only a running worker can go back to the queue`);
        mkdirSync(queueDir(d.logDir, s.provider), { recursive: true });
        writeTicket(join(queueDir(d.logDir, s.provider), id), `${s.runPid ?? s.pid} front @${Date.now()}`);
        message = "back to the queue: first in line, slot free for the next job, its work kept";
        break;
      }
      case "start-now": {
        const s = needJob();
        if (!(s.paused || s.state === "queued")) throw new Error(`worker ${id} is ${s.state}; only a waiting job can start now`);
        message = startNow(d, id, s);
        break;
      }
      case "resume":
        message = resumeWorker(d.logDir, id, d.by) ? "resumed" : "was not paused";
        break;
      case "freeze": {
        const r = await freezeAll(d.logDir, d.by, undefined, (() => { const x = realFreezeDeps(); x.servers = async () => []; return x; })(), [id]);
        message = r.lines.join("; ");
        break;
      }
      case "thaw":
        message = thawSome(d.logDir, realFreezeDeps(), { ids: [id] }).lines.join("; ");
        break;
      case "deep-freeze":
      case "deep-resume":
        message = await (d.deepFreeze ?? realDeep)(d.logDir, d.by, { ids: [id] }, action === "deep-resume");
        break;
      case "to-cloud":
      case "to-local":
        if (!d.reroute) return { ok: false, message: "moving a job needs the router's starter" };
        message = await d.reroute(id, action === "to-cloud" ? "cloud" : "local");
        break;
      case "prio-low":
      case "prio-normal":
      case "prio-high":
      case "prio-now": {
        const level = action.slice(5) as PriorityLevel;
        const r = applyPriority(d.logDir, id, level, d.by);
        message = `priority ${level}${r.paused.length ? `; paused ${r.paused.length} other local job(s)` : ""}`;
        break;
      }
      case "stop":
      {
        const pane = loadPaneRunStatuses(d.logDir).find((x) => x.id === id && x.state === "running");
        if (!pane) throw new Error(`no running command ${id}`);
        process.kill(pane.pid, "SIGTERM");
        message = "stopped";
        break;
      }
      default:
        throw new Error(`unknown action "${String(action)}"`);
    }
    return { ok: true, message, state: stateOf(d, id) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** One action on every job of a session (commands included where the action fits them). */
export async function runSessionAction(d: OpsDeps, action: RowAction, session: string): Promise<ActionResult> {
  if (action === "deep-freeze" || action === "deep-resume") {
    try {
      return { ok: true, message: await (d.deepFreeze ?? realDeep)(d.logDir, d.by, { session }, action === "deep-resume") };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
  const rows = readQueueTable(d.logDir, d.workers, Date.now(), undefined, d.owns).filter((r) => r.session === session && r.kind === "job");
  if (!rows.length) return { ok: false, message: `no jobs of session ${session}` };
  const res: string[] = [];
  let ok = true;
  for (const r of rows) {
    const x = await runRowAction(d, action, r.id);
    ok = ok && x.ok;
    res.push(`${r.id}: ${x.message}`);
  }
  return { ok, message: `${session}: ${rows.length} job(s) — ${res.join("; ")}` };
}

/** Global deep freeze / resume: `pai stop` / `pai resume` for the whole machine. */
export async function runGlobalDeep(d: OpsDeps, resume: boolean): Promise<ActionResult> {
  try {
    return { ok: true, message: await (d.deepFreeze ?? realDeep)(d.logDir, d.by, undefined, resume) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
