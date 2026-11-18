/**
 * queue-ops.ts — reads the one queue table of the machine and runs its per-job / per-session actions.
 * Shared by `pai worker queue` and the cockpit router (/cockpit/queue, /cockpit/queue/act) so both do the same.
 */
import { loadStatus, loadStatusesCached, ownsPidCached } from "./status.js";
import { isLocalProvider, type WorkersConfig } from "./config.js";
import { providerCap, queueRows, reorderQueue, reorderQueueTo, liveQueue } from "./capacity.js";
import { loadPaneRunStatuses } from "./pane-run.js";
import { ownerSessionName } from "./scope.js";
import { frozenSince, freezeAll, thawSome, realFreezeDeps } from "./freeze.js";
import { setWorkerPaused } from "./engine-control.js";
import { applyPriority, resumeWorker, type PriorityLevel } from "./preempt.js";
import { buildQueueTable, type RowAction, type TableRow } from "./queue-table.js";

/** The table of the machine's workers right now. `deepFrozen` stays empty until `pai stop` records its jobs. */
export function readQueueTable(logDir: string, workers: WorkersConfig, now = Date.now(), deepFrozen?: (id: string) => boolean, owns: (s: { pid: number; started: string; id?: string }) => boolean = ownsPidCached): TableRow[] {
  const caps: Record<string, number | undefined> = {};
  for (const name of Object.keys(workers.providers)) caps[name] = providerCap(workers, name);
  const statuses = loadStatusesCached(logDir);
  const local = (p: string): boolean => {
    const prov = workers.providers[p];
    return !!prov && isLocalProvider(prov.baseUrl);
  };
  const live = statuses.filter((s) => s.state === "queued" || (s.state === "running" && owns(s)));
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
    frozen: (id) => frozenSince(id) !== undefined,
    deepFrozen,
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
  /** Deep-freeze / resume: wired to `pai stop` / `pai resume` when they exist. */
  deepFreeze?: (id: string, resume: boolean) => Promise<string>;
}

const stateOf = (d: OpsDeps, id: string): string | undefined => readQueueTable(d.logDir, d.workers, Date.now(), undefined, d.owns).find((r) => r.id === id)?.stateText;

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
      case "pause":
        message = setWorkerPaused(d.logDir, id, true, d.by) ? "paused; its slot is free for the next job" : "already paused";
        break;
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
        if (!d.deepFreeze) return { ok: false, message: "coming with pai stop/resume" };
        message = await d.deepFreeze(id, action === "deep-resume");
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
