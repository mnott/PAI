/**
 * cockpit-job-recovery.ts — cockpit jobs (<home>/cockpit-jobs/<id>.json) record the pid and
 * start time of the process that runs them. A restart of that process (daemon restart, its
 * self-restart on a new build) cuts the job off with nothing left to write its end, so the
 * file stays "running" and the cockpit gave up after its poll budget. On daemon start every
 * job whose runner is gone is set to "interrupted"; an index/embed pass is never auto-resumed
 * (the operator re-runs it). The same liveness test tells the self-restart a job is running.
 */
import { processStartMs as psStartMs } from "../workers/proc-start.js";
import { readdirSync } from "node:fs";
import { readCockpitJob, writeCockpitJob, type LocalJobState } from "./cockpit-actions.js";

/** A job's runner is alive: its pid answers and the process started no later than the job did (a reused pid started after it). */
export type RunnerAlive = (pid: number, startedAtMs: number) => boolean;

/** Slack between the job's own timestamp and the runner's start time (ps has whole seconds). */
const START_SLACK_MS = 5_000;

/** Start time of a process in ms (ps etime), null when unreadable. */
function processStartMs(pid: number): number | null {
  return psStartMs(pid) ?? null;
}

export const runnerAlive: RunnerAlive = (pid, startedAtMs) => {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const started = processStartMs(pid);
  return started === null || started <= startedAtMs + START_SLACK_MS;
};

function runningJobs(home: string): LocalJobState[] {
  let files: string[] = [];
  try {
    files = readdirSync(`${home}/cockpit-jobs`);
  } catch {
    return [];
  }
  const out: LocalJobState[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const j = readCockpitJob(home, f.slice(0, -5));
    if (j?.state === "running") out.push(j);
  }
  return out;
}

const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 19) + "Z";

/** Daemon start: every job still "running" whose runner is gone (no pid recorded counts as gone) becomes "interrupted".
 *  Returns the ids it changed. */
export function interruptStaleJobs(home: string, daemonStartedAtMs: number, alive: RunnerAlive = runnerAlive): string[] {
  const changed: string[] = [];
  for (const j of runningJobs(home)) {
    const started = Date.parse(j.startedAt ?? j.at);
    if (j.pid !== undefined && alive(j.pid, Number.isNaN(started) ? daemonStartedAtMs : started)) continue;
    writeCockpitJob(home, { ...j, state: "interrupted", message: `interrupted: the daemon restarted at ${hhmm(daemonStartedAtMs)} — run it again`, at: new Date().toISOString() });
    changed.push(j.id);
  }
  return changed;
}

/** True while a cockpit job is running in a live process: the self-restart waits for it. */
export function cockpitJobRunning(home: string, alive: RunnerAlive = runnerAlive): boolean {
  return runningJobs(home).some((j) => {
    const started = Date.parse(j.startedAt ?? j.at);
    return j.pid !== undefined && alive(j.pid, Number.isNaN(started) ? Date.now() : started);
  });
}
