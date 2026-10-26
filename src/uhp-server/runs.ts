/**
 * The bridge between a UHP response and a PAI worker. A response is a normal
 * `pai worker run` (or `resume`) in its own session, so it keeps the caps,
 * routing, test slot, urgency and keyless env of every worker and survives a
 * restart of this server. The worker's `.jsonl` is the only source of output.
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { parseAg2Report } from "../workers/agentish.js";
import { eventsPath } from "../workers/paths.js";
import { spawnSession } from "../workers/reroute.js";
import { WORKER_ID_ENV } from "../workers/tree.js";
import { WORKER_ORIGIN_ENV } from "../workers/pane-waiver.js";
import { loadStatus, pidAlive, type WorkerStatus } from "../workers/status.js";
import { redactSecrets } from "../utils/redact.js";
import { Assembler, splitLines, type UhpEventBody } from "./events.js";
import { loadRecord, saveRecord, type FinalState, type ResponseRecord, type UhpStatus } from "./store.js";

export interface RunsDeps {
  logDir: string;
  /** Directory the workers run in. */
  cwd: string;
  /** Binary that starts the detached worker (default: PAI_BIN, else `pai`). */
  bin?: string;
  /** Test seam for the detached start. */
  start?: typeof spawnSession;
}

export interface WorkerLaunch {
  /** `run` args after `pai worker run`, or `resume` args after `pai worker resume`. */
  args: string[];
  verb: "run" | "resume";
}

/** Start the worker in its own session; its pid is what finds the worker id later. */
export function launch(d: RunsDeps, rec: ResponseRecord, l: WorkerLaunch): number {
  const runs = join(d.logDir, "runs");
  mkdirSync(runs, { recursive: true });
  const env = { ...process.env };
  delete env[WORKER_ID_ENV]; // a UHP response is a top-level worker, not a child of whatever started this server
  env[WORKER_ORIGIN_ENV] = "uhp"; // headless under the typed waiver, no session notices (pane-waiver.ts)
  return (d.start ?? spawnSession)(d.bin ?? process.env.PAI_BIN ?? "pai", ["worker", l.verb, ...l.args], {
    cwd: d.cwd,
    env,
    outPath: join(runs, `uhp-${rec.id}.out`),
  });
}

/** The worker id minted by the process with this pid (ids end in `-<pid>`, optionally `-NN`). */
export function workerIdOfPid(logDir: string, pid: number): string | null {
  if (!existsSync(logDir)) return null;
  const re = new RegExp(`-${pid}(?:-\\d\\d)?\\.status$`);
  const hit = readdirSync(logDir).filter((n) => re.test(n)).sort();
  return hit.length ? hit[hit.length - 1].slice(0, -".status".length) : null;
}

export type Phase = "pending" | "live" | "ended";

export interface Observed {
  phase: Phase;
  status: WorkerStatus | null;
}

/** Where the worker is: not started yet, running (or queued), or over. */
export function observe(d: RunsDeps, rec: ResponseRecord): Observed {
  if (!rec.workerId) {
    const id = workerIdOfPid(d.logDir, rec.pid);
    if (id) {
      rec.workerId = id;
      const fresh = loadRecord(rec.id);
      if (fresh && !fresh.workerId) saveRecord({ ...fresh, workerId: id, rootWorkerId: fresh.rootWorkerId ?? id });
    }
  }
  if (!rec.workerId) return { phase: pidAlive(rec.pid) ? "pending" : "ended", status: null };
  const status = loadStatus(d.logDir, rec.workerId);
  if (!status) return { phase: pidAlive(rec.pid) ? "pending" : "ended", status: null };
  if (status.state === "queued" || status.state === "running") {
    const alive = pidAlive(rec.pid) || pidAlive(status.pid);
    return { phase: alive ? "live" : "ended", status };
  }
  return { phase: "ended", status };
}

/** Incremental reader of the worker's `.jsonl`. */
export class Tail {
  private offset = 0;
  private rest = "";
  constructor(private readonly logDir: string, private workerId: string | null) {}

  setWorker(id: string | null): void {
    this.workerId = id;
  }

  read(): unknown[] {
    if (!this.workerId) return [];
    const path = eventsPath(this.logDir, this.workerId);
    if (!existsSync(path)) return [];
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return [];
      const buf = Buffer.alloc(size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      const { lines, rest } = splitLines(this.rest + buf.subarray(0, n).toString("utf8"));
      this.rest = rest;
      return lines;
    } finally {
      closeSync(fd);
    }
  }
}

/** Error text safe to show a client: no secrets, hosts, paths or stack frames. */
export function sanitise(text: string): string {
  const first = redactSecrets(text).split("\n")[0] ?? "";
  return first
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/(?:~|\.{0,2})?(?:\/[\w.@+-]+){2,}\/?/g, "[path]")
    .replace(/\s+at\s+\S+:\d+.*$/, "")
    .slice(0, 300)
    .trim();
}

const AG2_STATUS: Record<string, UhpStatus> = { "+": "completed", "~": "incomplete", "-": "failed", "!": "cancelled", "?": "incomplete" };

/** UHP status from the AG2 `r` outcome of the worker's report. */
export function resultToUhpStatus(r: string | undefined): UhpStatus | null {
  return r ? (AG2_STATUS[r.trim()[0] ?? ""] ?? null) : null;
}

const failure = (code: string, message: string): FinalState["error"] => ({ type: "harness_error", code, message, param: null, detail: null });

/** Freeze what the worker produced into the response's terminal state. */
export function finalState(rec: ResponseRecord, asm: Assembler, ws: WorkerStatus | null, now = Date.now()): FinalState {
  const base = {
    output: asm.items,
    usage: asm.result?.usage ?? null,
    model: rec.requestedModel ?? ws?.model ?? rec.model,
    completedAt: Math.floor(now / 1000),
  };
  const done = (status: UhpStatus, error: FinalState["error"] = null, reason?: string): FinalState => ({
    ...base,
    status,
    error,
    incompleteDetails: reason ? { reason } : null,
  });
  if (ws?.endReason === "deadline") return done("incomplete", null, "timeout");
  if (!ws) return done("failed", failure("harness_unavailable", "The worker could not be started"));
  if (ws.state === "killed") return done("failed", failure("harness_error", "The worker was stopped before it finished"));
  if (ws.state === "failed" || ws.state === "lost") {
    return done("failed", failure(ws.state === "lost" ? "harness_unavailable" : "harness_error", sanitise(ws.last || "") || "The worker failed"));
  }
  if (asm.result?.subtype === "error_max_turns") return done("incomplete", null, "max_step");
  const ag2 = parseAg2Report(asm.finalText());
  const st = ag2?.kind === "R" ? resultToUhpStatus(ag2.fields.r) : null;
  if (st === "failed") return done("failed", failure("harness_error", sanitise(ag2?.fields.y || ag2?.fields.z || "") || "The worker reported a failure"));
  if (st === "incomplete") return done("incomplete", null, "budget");
  if (st) return done(st);
  return ws.rc === 0 || ws.rc === null ? done("completed") : done("failed", failure("harness_error", "The worker exited with an error"));
}

export interface FollowHooks {
  event(ev: UhpEventBody): void;
  keepAlive(): void;
  /** True when the consumer went away; the worker keeps running. */
  gone(): boolean;
}

export const POLL_MS = 200;
export const KEEPALIVE_MS = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive one consumer from the start of the run to its end: every `.jsonl` line
 * goes through the assembler (events to `hooks`), then the terminal state is
 * frozen into the record. A cancel freezes the record first; that wins.
 */
export async function follow(d: RunsDeps, rec: ResponseRecord, hooks: FollowHooks): Promise<{ rec: ResponseRecord; asm: Assembler; final: FinalState } | null> {
  const asm = new Assembler();
  const tail = new Tail(d.logDir, rec.workerId);
  let lastBeat = Date.now();
  const pump = () => {
    for (const line of tail.read()) for (const ev of asm.push(line)) hooks.event(ev);
  };
  for (;;) {
    if (hooks.gone()) return null;
    const cur = loadRecord(rec.id) ?? rec;
    const obs = observe(d, cur);
    tail.setWorker(cur.workerId);
    pump();
    if (cur.final) {
      pump();
      return { rec: cur, asm, final: cur.final };
    }
    if (obs.phase === "ended") {
      pump();
      const again = loadRecord(rec.id);
      if (again?.final) return { rec: again, asm, final: again.final };
      const final = finalState(cur, asm, obs.status);
      const saved = { ...(again ?? cur), workerId: cur.workerId, final };
      saveRecord(saved);
      return { rec: saved, asm, final };
    }
    if (Date.now() - lastBeat >= KEEPALIVE_MS) {
      hooks.keepAlive();
      lastBeat = Date.now();
    }
    await sleep(POLL_MS);
  }
}

/** The output so far, read from the worker's log in one go. */
export function snapshot(d: RunsDeps, rec: ResponseRecord): Assembler {
  const asm = new Assembler();
  for (const line of new Tail(d.logDir, rec.workerId).read()) asm.push(line);
  return asm;
}
