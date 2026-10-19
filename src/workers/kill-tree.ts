/**
 * kill-tree.ts — end a worker together with every live descendant.
 *
 * The tree is the one `pai worker ps` draws: status files linked by `parent`.
 * Leaves are stopped first, then their parents, each with SIGTERM, a wait for
 * the run's own terminal status, and SIGKILL when the process is still there.
 * `pai worker kill`, the deadline and the loop watch all go through here.
 */

import { appendLedger } from "./ledger.js";
import { callerDescription, requestKill } from "./endreason.js";
import {
  loadStatus,
  loadStatuses,
  ownsPid,
  pidAlive,
  saveStatus,
  waitForTerminalStatus,
  type WorkerStatus,
} from "./status.js";
import { ledgerPath } from "./paths.js";
import { buildsDir, releaseBuildsOf } from "../builds/queue.js";

export interface KillTreeDeps {
  signal: (pid: number, sig: NodeJS.Signals) => void;
  owns: (s: WorkerStatus) => boolean;
  isAlive: (pid: number) => boolean;
  waitTerminal: (logDir: string, id: string) => Promise<WorkerStatus | null>;
  request: (logDir: string, ledger: string, id: string) => void;
  /** Wait after SIGKILL is not needed; this is the grace between SIGTERM and SIGKILL. */
  graceMs: number;
}

const defaultDeps = (): KillTreeDeps => ({
  signal: (pid, sig) => void process.kill(pid, sig),
  owns: ownsPid,
  isAlive: (pid) => pidAlive(pid),
  waitTerminal: (dir, id) => waitForTerminalStatus(dir, id),
  request: (dir, ledger, id) => requestKill(dir, ledger, id, callerDescription()),
  graceMs: 1000,
});

/** Live descendants of `id`, deepest first (leaves before their parents). */
export function descendantsLeavesFirst(statuses: WorkerStatus[], id: string): WorkerStatus[] {
  const out: { s: WorkerStatus; depth: number }[] = [];
  const seen = new Set<string>([id]);
  let level = [id];
  for (let depth = 1; level.length; depth++) {
    const next: string[] = [];
    for (const s of statuses) {
      if (!s.parent || !level.includes(s.parent) || seen.has(s.id)) continue;
      seen.add(s.id);
      next.push(s.id);
      if (s.state === "running" || s.state === "queued") out.push({ s, depth });
    }
    level = next;
  }
  return out.sort((a, b) => b.depth - a.depth).map((x) => x.s);
}

async function killOne(logDir: string, recorded: WorkerStatus, d: KillTreeDeps): Promise<string> {
  const id = recorded.id;
  // A pooled task's `pid` is the shared slot process; the process to end is its `pai worker run` client,
  // whose disconnect makes the pool host cancel the task and write the terminal status.
  const clientPid = recorded.pool?.clientPid;
  const status: WorkerStatus = clientPid ? { ...recorded, pid: clientPid } : recorded;
  if (!status.pid || status.pid <= 0) return `skipped worker ${id}: no pid recorded`;
  if (!d.owns(status)) {
    recorded.state = "lost";
    recorded.last = `pid ${status.pid} no longer belongs to this worker (reused); marked lost`;
    recorded.rc = null;
    saveStatus(logDir, recorded);
    return `worker ${id}: pid ${status.pid} is not this worker any more (started ${status.started}); marked lost, nothing signalled`;
  }
  d.request(logDir, ledgerPath(logDir), id);
  // a worker holding the machine-wide build lock frees it and its build tree dies with it
  await releaseBuildsOf(buildsDir(), id).catch(() => []);
  try {
    d.signal(status.pid, "SIGTERM");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH" || String(e).includes("ESRCH")) {
      return `worker ${id}: process ${status.pid} not found (already exited?)`;
    }
    throw e;
  }
  // The run's own SIGTERM handler writes the terminal status; only write ours if it never did.
  const selfReported = await d.waitTerminal(logDir, id);
  let how = "SIGTERM";
  if (!selfReported && d.isAlive(status.pid)) {
    await new Promise((r) => setTimeout(r, d.graceMs));
    if (d.isAlive(status.pid)) {
      try {
        d.signal(status.pid, "SIGKILL");
        how = "SIGKILL";
      } catch {
        /* gone between the probe and the signal */
      }
    }
  }
  if (!selfReported) {
    const latest = loadStatus(logDir, id) ?? recorded;
    if (latest.state === "running" || latest.state === "queued") {
      latest.state = "killed";
      latest.rc = latest.rc ?? (how === "SIGKILL" ? 137 : 143);
      latest.last = latest.last || `killed by signal ${how}`;
      latest.endReason = "pai-worker-kill";
      latest.endBy = callerDescription();
      saveStatus(logDir, latest);
    }
  }
  return `sent ${how} to worker ${id} (pid ${status.pid})`;
}

/**
 * Kill `id` and every live descendant, leaves first. `only` keeps the single
 * worker; `skipRoot` ends just the descendants (the deadline path, where the
 * runner stops itself). Returns one line per worker handled, in kill order.
 */
export async function killTree(
  logDir: string,
  id: string,
  opts: { only?: boolean; skipRoot?: boolean; deps?: Partial<KillTreeDeps> } = {}
): Promise<string[]> {
  const d = { ...defaultDeps(), ...opts.deps };
  const root = loadStatus(logDir, id);
  if (!root) throw new Error(`no worker named "${id}"`);
  const order = opts.only ? [] : descendantsLeavesFirst(loadStatuses(logDir), id);
  if (!opts.skipRoot) order.push(root);
  const lines: string[] = [];
  for (const s of order) {
    try {
      lines.push(await killOne(logDir, s, d));
    } catch (e) {
      if (s.id === id) throw e;
      lines.push(`worker ${s.id}: kill failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (order.length > 1) appendLedger(ledgerPath(logDir), "WORKER-KILL-TREE", { id, killed: order.map((s) => s.id).join(",") });
  return lines;
}
