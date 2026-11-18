/**
 * load-watch.ts — the daemon's runaway-load watchdog.
 *
 * 2026-11-17/18: 36 leaked busy loops ran at load average 160 from 21:15 to 07:27; the router starved,
 * every worker failed and nobody was told, because the alert path ran through the same starved router.
 * The daemon is a separate process, so it watches the machine itself.
 *
 * Every minute: the 5-min load average and one async `ps -Ao pid,ppid,%cpu,etime,command` (no lsof, no sync
 * spawn). When the load stays above workers.loadWatch.maxLoadPerCore x ncpu (default 3) for
 * workers.loadWatch.minutes (default 10) the episode starts:
 *   1. `pai freeze` equivalent (freezeAll: holds worker trees and the local model, kills nothing);
 *   2. suspects are listed: orphans (ppid 1) whose command line points into a worker scratch dir, a worker
 *      worktree or the worker logs dir, and busy shells (sh/bash/zsh, %CPU > 50, ppid 1). Only a suspect tied
 *      to a worker whose status is terminal is killed, by exact pid, ledgered as LOADWATCH-KILL. The rest is
 *      reported, never killed;
 *   3. the operator is told once per episode straight through AIBroker's PAILot channel (not the router);
 *   4. once the load has been back under the threshold for 5 minutes the freeze is thawed.
 * The last reading is kept in <PAI home>/load-watch.json for `pai daemon status`.
 *
 * `ps` has no cwd column and lsof is off limits, so "points into" is judged on the command line.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { appendLedger } from "../workers/ledger.js";
import { ledgerPath } from "../workers/paths.js";
import { isTerminal, loadStatuses } from "../workers/status.js";
import type { WorkerStatus } from "../workers/status.js";

export interface LoadWatchConfig {
  enabled: boolean;
  /** 5-min load per core above which the machine counts as overloaded. Default 3. */
  maxLoadPerCore: number;
  /** Minutes the load must stay above before the episode starts. Default 10. */
  minutes: number;
  /** Minutes back under the threshold before the thaw. Default 5. */
  thawMinutes: number;
  /** Seconds between readings. Default 60. */
  intervalSecs: number;
}

export const LOAD_WATCH_DEFAULTS: LoadWatchConfig = { enabled: true, maxLoadPerCore: 3, minutes: 10, thawMinutes: 5, intervalSecs: 60 };

export function loadWatchConfig(workers: unknown): LoadWatchConfig {
  const b = ((workers as { loadWatch?: Record<string, unknown> } | undefined)?.loadWatch ?? {}) as Record<string, unknown>;
  const num = (k: keyof LoadWatchConfig, d: number): number => (typeof b[k] === "number" && (b[k] as number) > 0 ? (b[k] as number) : d);
  return {
    enabled: typeof b.enabled === "boolean" ? b.enabled : LOAD_WATCH_DEFAULTS.enabled,
    maxLoadPerCore: num("maxLoadPerCore", LOAD_WATCH_DEFAULTS.maxLoadPerCore),
    minutes: num("minutes", LOAD_WATCH_DEFAULTS.minutes),
    thawMinutes: num("thawMinutes", LOAD_WATCH_DEFAULTS.thawMinutes),
    intervalSecs: num("intervalSecs", LOAD_WATCH_DEFAULTS.intervalSecs),
  };
}

// ---------------------------------------------------------------------------
// ps parsing and suspect selection (pure)
// ---------------------------------------------------------------------------

export interface PsRow {
  pid: number;
  ppid: number;
  cpu: number;
  etime: string;
  command: string;
}

export function parsePsCpu(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), etime: m[4], command: m[5] });
  }
  return rows;
}

export interface Suspect extends PsRow {
  reason: "orphan-in-worker-path" | "busy-shell";
  /** The worker id the process is tied to, when its command line names one. */
  workerId?: string;
  /** True only when that worker's status is terminal: the one case that is killed. */
  workerEnded: boolean;
}

const SHELL = /(^|\/)(sh|bash|zsh)(\s|$)/;
const SCRATCH = /pai-scratch|\/worktrees\/|\/logs\/workers\//;

export function selectSuspects(rows: PsRow[], statuses: WorkerStatus[], logDir: string, self: number): Suspect[] {
  const out: Suspect[] = [];
  for (const r of rows) {
    if (r.pid === self || r.ppid !== 1) continue;
    const inPath = SCRATCH.test(r.command) || r.command.includes(logDir);
    const busyShell = SHELL.test(r.command) && r.cpu > 50;
    if (!inPath && !busyShell) continue;
    const tied = statuses.find((s) => s.id && (r.command.includes(s.id) || (s.worktreeDir ? r.command.includes(s.worktreeDir) : false)));
    out.push({
      ...r,
      reason: inPath ? "orphan-in-worker-path" : "busy-shell",
      workerId: tied?.id,
      workerEnded: tied !== undefined && isTerminal(tied.state),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// State machine (pure)
// ---------------------------------------------------------------------------

export interface LoadWatchState {
  /** ms the load first went over the threshold in the current run of readings, null = not over. */
  overSince: number | null;
  /** ms the load first came back under while an episode is open. */
  underSince: number | null;
  episode: boolean;
  frozenByUs: boolean;
}

export const freshLoadWatchState = (): LoadWatchState => ({ overSince: null, underSince: null, episode: false, frozenByUs: false });

export type LoadWatchStep = "none" | "start" | "thaw";

/** One reading in; the next state and what to do. */
export function stepLoadWatch(s: LoadWatchState, load: number, threshold: number, cfg: LoadWatchConfig, now: number): { state: LoadWatchState; step: LoadWatchStep } {
  const over = load > threshold;
  if (!s.episode) {
    if (!over) return { state: { ...s, overSince: null }, step: "none" };
    const since = s.overSince ?? now;
    if (now - since >= cfg.minutes * 60_000) return { state: { ...s, overSince: since, episode: true, underSince: null }, step: "start" };
    return { state: { ...s, overSince: since }, step: "none" };
  }
  if (over) return { state: { ...s, underSince: null }, step: "none" };
  const since = s.underSince ?? now;
  if (now - since >= cfg.thawMinutes * 60_000) return { state: freshLoadWatchState(), step: "thaw" };
  return { state: { ...s, underSince: since }, step: "none" };
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export interface LoadWatchReading {
  at: string;
  load5: number;
  threshold: number;
  cores: number;
  over: boolean;
  episode: boolean;
  top: { pid: number; cpu: number; command: string }[];
  lastAction?: string;
}

export interface LoadWatchDeps {
  load5: () => number;
  cores: () => number;
  ps: () => Promise<PsRow[]>;
  statuses: () => WorkerStatus[];
  freeze: () => Promise<string>;
  thaw: () => Promise<string>;
  kill: (pid: number) => void;
  alert: (text: string) => Promise<void>;
  ledger: (event: string, kv: Record<string, string | number>) => void;
  write: (r: LoadWatchReading) => void;
  now: () => number;
  self: number;
  logDir: string;
}

export async function loadWatchTick(state: LoadWatchState, cfg: LoadWatchConfig, d: LoadWatchDeps): Promise<LoadWatchState> {
  const load = d.load5();
  const cores = d.cores();
  const threshold = cfg.maxLoadPerCore * cores;
  const { state: next, step } = stepLoadWatch(state, load, threshold, cfg, d.now());
  let rows: PsRow[] = [];
  try {
    rows = await d.ps();
  } catch {
    /* a failed ps leaves the load decision intact */
  }
  const top = [...rows].sort((a, b) => b.cpu - a.cpu).slice(0, 5).map((r) => ({ pid: r.pid, cpu: r.cpu, command: r.command.slice(0, 160) }));
  const reading: LoadWatchReading = { at: new Date(d.now()).toISOString(), load5: load, threshold, cores, over: load > threshold, episode: next.episode, top };

  if (step === "start") {
    const suspects = selectSuspects(rows, d.statuses(), d.logDir, d.self);
    let frozen: string;
    try {
      frozen = await d.freeze();
      next.frozenByUs = true;
    } catch (e) {
      frozen = `freeze failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    const killed: Suspect[] = [];
    for (const s of suspects) {
      if (!s.workerEnded) continue;
      try {
        d.kill(s.pid);
        killed.push(s);
        d.ledger("LOADWATCH-KILL", { pid: s.pid, worker: s.workerId ?? "?", cmd: s.command.slice(0, 200) });
      } catch {
        /* already gone */
      }
    }
    const reported = suspects.filter((s) => !killed.includes(s));
    const text =
      `PAI load watchdog: load ${load.toFixed(1)} on ${cores} cores (limit ${threshold}) for ${cfg.minutes} min. ${frozen}. ` +
      `Killed ${killed.length} orphan(s) of ended workers${killed.length ? ": " + killed.map((s) => `${s.pid} ${s.command.slice(0, 60)}`).join("; ") : ""}. ` +
      `Not killed, reported ${reported.length}${reported.length ? ": " + reported.slice(0, 5).map((s) => `${s.pid} ${s.command.slice(0, 60)}`).join("; ") : ""}. ` +
      `Top: ${top.slice(0, 3).map((t) => `${t.pid} ${t.cpu}% ${t.command.slice(0, 50)}`).join("; ")}. Thaws after ${cfg.thawMinutes} min under the limit.`;
    reading.lastAction = `episode: froze, killed ${killed.length}, reported ${reported.length}`;
    try {
      await d.alert(text);
    } catch {
      /* the alert is best effort; the ledger and the status file still carry it */
    }
  } else if (step === "thaw" && state.frozenByUs) {
    try {
      reading.lastAction = `thawed: ${await d.thaw()}`;
      try {
        await d.alert(`PAI load watchdog: load ${load.toFixed(1)} is back under ${threshold} for ${cfg.thawMinutes} min; ${reading.lastAction}.`);
      } catch {
        /* best effort */
      }
    } catch (e) {
      reading.lastAction = `thaw failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  d.write(reading);
  return next;
}

// ---------------------------------------------------------------------------
// Live deps and status file
// ---------------------------------------------------------------------------

const readingFile = (): string => paiHomePath("load-watch.json");

export function readLoadWatch(): LoadWatchReading | null {
  try {
    return JSON.parse(readFileSync(readingFile(), "utf8")) as LoadWatchReading;
  } catch {
    return null;
  }
}

export function loadWatchStatusLine(r: LoadWatchReading | null): string | null {
  if (!r) return null;
  const when = r.at.slice(11, 19);
  return `Load watch:   ${when} load5 ${r.load5.toFixed(1)} / limit ${r.threshold} (${r.cores} cores)${r.episode ? " EPISODE" : ""}${r.lastAction ? " — " + r.lastAction : ""}`;
}

function psAsync(): Promise<PsRow[]> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-Ao", "pid,ppid,%cpu,etime,command"], { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 }, (err, stdout) =>
      err ? reject(err) : resolve(parsePsCpu(stdout))
    );
  });
}

export function liveLoadWatchDeps(logDir: string): LoadWatchDeps {
  return {
    load5: () => loadavg()[1],
    cores: () => cpus().length,
    ps: psAsync,
    statuses: () => loadStatuses(logDir),
    freeze: async () => {
      const { freezeAll, realFreezeDeps } = await import("../workers/freeze.js");
      const r = await freezeAll(logDir, "load-watch", undefined, realFreezeDeps());
      return `Froze all workers (${r.total} processes held, nothing killed)`;
    },
    thaw: async () => {
      const { thawAll, realFreezeDeps } = await import("../workers/freeze.js");
      const r = thawAll(logDir, realFreezeDeps());
      return `${r.continued} continued`;
    },
    kill: (pid) => process.kill(pid, "SIGKILL"),
    alert: async (text) => {
      // PAI's operator-notification path (run-events aibrokerMessenger.toPailot): the PAILot rate/dedup guard, then
      // AIBroker's socket `pailot_send` with an 8 s timeout. No router, no session in the path.
      const { guardedPailot } = await import("../workers/pailot-guard.js");
      await guardedPailot(logDir, text, async (t) => {
        try {
          const { callAiBroker } = await import("../cli/lib/aibroker-client.js");
          await callAiBroker("pailot_send", { text: t }, 8_000);
          return true;
        } catch {
          return false;
        }
      });
    },
    ledger: (event, kv) => appendLedger(ledgerPath(logDir), event, kv),
    write: (r) => {
      try {
        mkdirSync(join(readingFile(), ".."), { recursive: true });
        writeFileSync(readingFile(), JSON.stringify(r), "utf8");
      } catch {
        /* status file is a courtesy */
      }
    },
    now: () => Date.now(),
    self: process.pid,
    logDir,
  };
}
