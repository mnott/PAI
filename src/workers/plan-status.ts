/**
 * plan-status.ts — the live status entry of a plan run (kind "plan").
 *
 * The runner's own work between two workers (merge, gate, unit check,
 * bookkeeping) has no worker to show it. This entry carries the current phase
 * and its start time so `pai worker ps`, the cockpit and plan_status can; the
 * live log beside it feeds the plan pane (`pai worker follow plan-<job>`).
 * Kept apart from the worker `.status` files: nothing that walks workers has
 * to know about it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowStamp, pidAlive } from "./status.js";

export interface PlanRunStatus {
  kind: "plan";
  /** `plan-<slug of job>`: also the id the plan pane follows. */
  id: string;
  job: string;
  pid: number;
  started: string;
  updated: string;
  state: "running" | "done" | "failed" | "stopped" | "lost";
  phase: string;
  /** Epoch ms the current phase began. */
  phaseSince: number;
  parts: { merged: number; total: number };
  /** Ids of the parts whose worker runs now. */
  running: string[];
  /** Worker id per part id, for every worker the run started: the run's workers (each in its own pane). */
  workers?: Record<string, string>;
  /** True once the runner's own pane is open (its workers each open theirs). */
  hasPane?: boolean;
  /** Tests the plan gate counted last time: the denominator of "tests 214/2600". */
  testTotal?: number;
}

export const planRunId = (job: string): string => `plan-${job.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "job"}`;
export const planStatusFile = (logDir: string, id: string): string => join(logDir, `${id}.planstatus`);
export const planLiveFile = (logDir: string, id: string): string => join(logDir, `${id}.planlog`);

export function writePlanStatus(logDir: string, s: PlanRunStatus): void {
  s.updated = nowStamp();
  mkdirSync(logDir, { recursive: true });
  const path = planStatusFile(logDir, s.id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), "utf8");
  renameSync(tmp, path);
}

export function loadPlanStatus(logDir: string, id: string): PlanRunStatus | null {
  try {
    const s = JSON.parse(readFileSync(planStatusFile(logDir, id), "utf8")) as PlanRunStatus;
    return s.state === "running" && !pidAlive(s.pid) ? { ...s, state: "lost" } : s;
  } catch {
    return null;
  }
}

export function loadPlanStatuses(logDir: string): PlanRunStatus[] {
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((n) => n.endsWith(".planstatus"))
    .sort()
    .map((n) => loadPlanStatus(logDir, n.slice(0, -".planstatus".length)))
    .filter((s): s is PlanRunStatus => !!s);
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** ps lines of the running plans: one per plan, phase and how long it has lasted. */
export function renderPlanLines(statuses: PlanRunStatus[], now = Date.now()): string[] {
  return statuses
    .filter((s) => s.state === "running")
    .map((s) => `plan ${s.job}  ${s.parts.merged}/${s.parts.total} merged  ${s.phase} (${fmtElapsed(now - s.phaseSince)})${s.running.length ? `  workers: ${s.running.join(", ")}` : ""}`);
}

/** Cockpit rows of the running plans. */
export function planRows(statuses: PlanRunStatus[], now = Date.now()): Array<{ id: string; job: string; phase: string; phaseSec: number; ageSec: number; merged: number; total: number; running: string[] }> {
  return statuses
    .filter((s) => s.state === "running")
    .map((s) => ({
      id: s.id,
      job: s.job,
      phase: s.phase,
      phaseSec: Math.max(0, Math.round((now - s.phaseSince) / 1000)),
      ageSec: Math.max(0, Math.round((now - Date.parse(s.started.replace(" ", "T"))) / 1000)) || 0,
      merged: s.parts.merged,
      total: s.parts.total,
      running: s.running,
    }));
}

/** The phase a gate command is shown as: "tsc", "build", "tests", else its first words. */
export function gatePhaseName(cmd: string): string {
  if (/\btsc\b/.test(cmd)) return "tsc";
  if (/\b(tsdown|build)\b/.test(cmd)) return "build";
  if (/\b(vitest|jest|test)\b/.test(cmd)) return "tests";
  return cmd.trim().split(/\s+/).slice(0, 3).join(" ").slice(0, 30);
}

/** Owns the status entry and the live log of one run; every change goes to both. */
export class PlanTracker {
  private status: PlanRunStatus;
  private lastWrite = 0;

  constructor(private logDir: string, job: string, total: number, merged: number, private now: () => number = Date.now) {
    const id = planRunId(job);
    const prev = loadPlanStatus(logDir, id);
    this.status = {
      kind: "plan",
      id,
      job,
      pid: process.pid,
      started: nowStamp(new Date(now())),
      updated: "",
      state: "running",
      phase: "starting",
      phaseSince: now(),
      parts: { merged, total },
      running: [],
      ...(prev?.testTotal ? { testTotal: prev.testTotal } : {}),
    };
    mkdirSync(logDir, { recursive: true });
    writeFileSync(planLiveFile(logDir, id), "", "utf8");
    this.log(`plan ${job} started: ${merged}/${total} parts already merged`);
    this.save();
  }

  get id(): string {
    return this.status.id;
  }

  get testTotal(): number | undefined {
    return this.status.testTotal;
  }

  /** One timestamped line in the live log. */
  log(line: string): void {
    const t = new Date(this.now()).toTimeString().slice(0, 8);
    try {
      appendFileSync(planLiveFile(this.logDir, this.status.id), line.split("\n").map((l) => `${t} ${l}`).join("\n") + "\n", "utf8");
    } catch {
      /* the log is a view: never fail the run over it */
    }
  }

  private save(): void {
    try {
      writePlanStatus(this.logDir, this.status);
    } catch {
      /* same */
    }
  }

  /** A new phase: written to the status entry and the live log. */
  phase(text: string): void {
    if (text === this.status.phase) return;
    this.status.phase = text;
    this.status.phaseSince = this.now();
    this.lastWrite = this.now();
    this.log(`phase: ${text}`);
    this.save();
  }

  /** A progress refinement of the current phase (e.g. test counts): status only, at most once a second. */
  progress(text: string): void {
    if (text === this.status.phase || this.now() - this.lastWrite < 1000) return;
    this.status.phase = text;
    this.lastWrite = this.now();
    this.save();
  }

  setRunning(ids: string[]): void {
    this.status.running = ids;
    this.save();
  }

  /** True once the runner's own pane is open (its workers each open theirs). */
  get hasPane(): boolean {
    return this.status.hasPane === true;
  }

  set hasPane(v: boolean) {
    this.status.hasPane = v;
    this.save();
  }

  setWorker(part: string, wid: string): void {
    this.status.workers = { ...this.status.workers, [part]: wid };
    this.save();
  }

  merged(n: number): void {
    this.status.parts.merged = n;
    this.save();
  }

  setTestTotal(n: number): void {
    if (n > 0) this.status.testTotal = n;
  }

  end(state: "done" | "failed" | "stopped"): void {
    this.status.state = state;
    this.status.phase = state;
    this.status.phaseSince = this.now();
    this.status.running = [];
    this.log(`plan ${this.status.job} ${state}`);
    this.save();
  }
}

/** The last `n` lines of a plan's live log. */
export function planLogTail(logDir: string, id: string, n = 40): string {
  try {
    return readFileSync(planLiveFile(logDir, id), "utf8").trimEnd().split("\n").slice(-n).join("\n");
  } catch {
    return `no live log for ${id}`;
  }
}

/** True once the plan's runner has ended, been killed or vanished: its status is not "running" any more. */
export function planRunEnded(logDir: string, id: string): boolean {
  const s = loadPlanStatus(logDir, id);
  return !s || s.state !== "running";
}

/** Stream the live log into `write` until `stop()` is true; the file's whole content first, then what is appended. */
export async function followPlanLog(logDir: string, id: string, write: (s: string) => void, stop: () => boolean = () => false, pollMs = 500): Promise<void> {
  let at = 0;
  for (;;) {
    const done = stop(); // asked before the read, so the last lines are still shown
    try {
      const text = readFileSync(planLiveFile(logDir, id), "utf8");
      if (text.length > at) {
        write(text.slice(at));
        at = text.length;
      }
    } catch {
      /* not written yet */
    }
    if (done) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
