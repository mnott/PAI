/**
 * stale-requeue.ts — a waiter whose process runs an older PAI release is restarted by the daemon: stopped and started
 * again from its spec, keeping its place in the queue (since, front, rank, priority). A waiter has no work yet, so
 * nothing is lost. While it happens the row says "restarting on new version" (status.restarting); the operator does nothing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentBuildId, queueDir, queueRows, writeTicket, type QueueRow } from "./capacity.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { defaultSpawn, taskText, type SpawnSpec } from "./reroute.js";
import { loadStatus, saveStatus } from "./status.js";

export interface RequeueDeps {
  logDir: string;
  /** Start the task again on the same provider (default: reroute.ts defaultSpawn, a detached `pai worker run`). */
  spawn?: (s: SpawnSpec) => void | Promise<void>;
  /** Stop the old waiter (default: killWorker). */
  kill?: (id: string, reason: string) => Promise<unknown>;
  /** Id of the restart, once announced (default: the rerun id file defaultSpawn writes). */
  newIdOf?: (oldId: string) => string | undefined;
  /** The new run's ticket text is rewritten once it exists; tests pass 0 to skip the wait. */
  ticketWaitMs?: number;
  rows?: QueueRow[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Restart every stale waiter once. Returns the ids restarted. */
export async function requeueStaleWaiters(d: RequeueDeps): Promise<string[]> {
  const rows = d.rows ?? queueRows(d.logDir);
  const done: string[] = [];
  for (const r of rows) {
    if (!r.stale || !r.status || r.status.state !== "queued" || r.status.restarting || r.status.rerouted) continue;
    const old = r.status;
    const ticketPath = join(queueDir(d.logDir, r.provider), r.id);
    let ticket = "";
    try {
      ticket = readFileSync(ticketPath, "utf8").trim();
    } catch {
      continue;
    }
    try {
      const text = taskText(d.logDir, old);
      const specFile = join(d.logDir, `${r.id}.restart.prompt`);
      writeFileSync(specFile, text, "utf8");
      old.restarting = true;
      saveStatus(d.logDir, old, new Date(), true);
      await (d.spawn ?? defaultSpawn(d.logDir))({ id: r.id, why: "restarted on the new PAI version", provider: old.provider, ...(old.model ? { model: old.model } : {}), specFile });
      const newId = (d.newIdOf ?? ((x: string) => { try { return readFileSync(join(d.logDir, "runs", `rerun-${x}.id`), "utf8").trim() || undefined; } catch { return undefined; } }))(r.id);
      if (newId) await keepPlace(d.logDir, r.provider, newId, ticket, d.ticketWaitMs ?? 8000);
      const { markHandover } = await import("./run/follow-reroute.js");
      markHandover(d.logDir, r.id, "restarted on the new PAI version");
      await (d.kill ?? (async (x: string, why: string) => (await import("./kill-tree.js")).killWorker(d.logDir, x, { by: "stale-requeue", reason: why })))(r.id, "restarted on the new PAI version");
      appendLedger(ledgerPath(d.logDir), "WORKER-REQUEUED", { id: r.id, ...(newId ? { by: newId } : {}), position: String(r.position) });
      done.push(r.id);
    } catch (e) {
      // the old waiter keeps its place; try again at the next sweep
      const st = loadStatus(d.logDir, r.id);
      if (st?.restarting) {
        delete st.restarting;
        saveStatus(d.logDir, st, new Date(), true);
      }
      appendLedger(ledgerPath(d.logDir), "WORKER-REQUEUE-SKIPPED", { id: r.id, reason: (e as Error).message.slice(0, 200) });
    }
  }
  return done;
}

/** Give the restart the old ticket's place: its marks (front, rank, @since, priority) with the new run's own pid and build. */
async function keepPlace(logDir: string, provider: string, newId: string, oldTicket: string, waitMs: number): Promise<void> {
  const path = join(queueDir(logDir, provider), newId);
  const until = Date.now() + waitMs;
  while (!existsSync(path) && Date.now() < until) await sleep(100);
  if (!existsSync(path)) return;
  const [newPid] = readFileSync(path, "utf8").trim().split(/\s+/);
  const build = currentBuildId();
  const marks = oldTicket.split(/\s+/).slice(1).filter((m) => !m.startsWith("b:"));
  writeTicket(path, [newPid, ...marks, ...(build ? [`b:${build}`] : [])].join(" "));
}
