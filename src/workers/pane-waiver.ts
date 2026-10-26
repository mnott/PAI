/**
 * pane-waiver.ts — the one typed exception to "no command runs without a visible pane".
 *
 * Daemon-internal jobs that are not operator-visible work (session keepalive heartbeat, session summaries, the UHP server's workers,
 * knowledge-graph extraction) may start headless. Each start is ledgered `PANE-WAIVED kind=system reason=<job>`;
 * a session, the operator, a plan, queue, chain, MCP call or rerun never qualifies (a `noPane` request is ignored).
 */
import { readWorkersSection } from "./config.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath, workersLogDir } from "./paths.js";

/** The named system jobs; the reason on the ledger line. */
export type SystemJob = "keepalive" | "session-summary" | "kg-extraction" | "uhp";

export function recordSystemWaiver(ledger: string, job: SystemJob, id?: string): void {
  appendLedger(ledger, "PANE-WAIVED", { id, kind: "system", reason: job });
}

/** Ledger a daemon job's headless start; never throws (the job must not fail on bookkeeping). */
export function recordSystemJobStart(job: SystemJob): void {
  try {
    const { workers } = readWorkersSection();
    recordSystemWaiver(ledgerPath(workersLogDir(workers)), job);
  } catch {
    /* no readable config: nothing to ledger into */
  }
}

/**
 * Workers started by the UHP server (`pai uhp serve`) carry this env value. They run headless under a typed
 * waiver (`uhp`), are marked `origin: "uhp"` in their status, and send no session notices: the result belongs to
 * the UHP client that asked, through the API.
 */
export const WORKER_ORIGIN_ENV = "PAI_WORKER_ORIGIN";

export const isUhpOrigin = (env: NodeJS.ProcessEnv = process.env): boolean => env[WORKER_ORIGIN_ENV] === "uhp";

/** The status `origin` of a headless spawned run. */
export const spawnOrigin = (env: NodeJS.ProcessEnv = process.env): "spawn" | "uhp" => (isUhpOrigin(env) ? "uhp" : "spawn");
