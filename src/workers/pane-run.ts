/**
 * pane-run.ts — `pai pane run`: a session's background command runs in a visible pane.
 *
 * The caller (the process Claude Code backgrounds) owns the command: it spawns it in its own
 * process group, tees the output to <PAI home>/logs/panes/<id>.log, and blocks until it ends, so
 * the harness's completion notification keeps working. The pane runs `pai worker follow <id>`,
 * which shows that log live and the exit code after, and leaves a short while later. Placement is
 * a worker pane's (split, else tab, never a window; an ended pane of the scope is reused).
 * Status lives in <logDir>/<id>.panestatus for `pai worker ps` and the cockpit.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { nowStamp, pidAlive } from "./status.js";
import { fmtElapsed } from "./plan-status.js";
import { paneTitle, writePaneTitle } from "./pane-title.js";

export interface PaneRunStatus {
  kind: "pane";
  id: string;
  label: string;
  cwd: string;
  pid: number;
  started: string;
  startedMs: number;
  state: "running" | "done" | "failed" | "lost";
  exit?: number;
  log: string;
}

/** The env marker of a command running under `pai pane run`: nested pane/build runs then stay in it. */
export const PANE_RUN_ENV = "PAI_PANE_RUN";
/** Seconds the pane stays on screen after the command ended. */
export const PANE_LINGER_SECS = 10;
const TAIL_LINES = 40;

export const paneRunStatusFile = (logDir: string, id: string): string => join(logDir, `${id}.panestatus`);
export const paneRunLogDir = (): string => paiHomePath("logs", "panes");
export const isPaneRunId = (id: string): boolean => /^pane-[A-Za-z0-9._-]+$/.test(id);

export function writePaneRunStatus(logDir: string, s: PaneRunStatus): void {
  mkdirSync(logDir, { recursive: true });
  const path = paneRunStatusFile(logDir, s.id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), "utf8");
  renameSync(tmp, path);
}

export function loadPaneRunStatus(logDir: string, id: string): PaneRunStatus | null {
  try {
    const s = JSON.parse(readFileSync(paneRunStatusFile(logDir, id), "utf8")) as PaneRunStatus;
    return s.state === "running" && !pidAlive(s.pid) ? { ...s, state: "lost" } : s;
  } catch {
    return null;
  }
}

export function loadPaneRunStatuses(logDir: string): PaneRunStatus[] {
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((n) => n.endsWith(".panestatus"))
    .sort()
    .map((n) => loadPaneRunStatus(logDir, n.slice(0, -".panestatus".length)))
    .filter((s): s is PaneRunStatus => !!s);
}

/** ps lines of the running pane commands: label, cwd, running time, log path. */
export function renderPaneRunLines(statuses: PaneRunStatus[], now = Date.now()): string[] {
  return statuses
    .filter((s) => s.state === "running")
    .map((s) => `pane ${s.label}  ${s.cwd}  ${fmtElapsed(now - s.startedMs)}  ${s.log}`);
}

/** Cockpit rows of the running pane commands. */
export function paneRunRows(statuses: PaneRunStatus[], now = Date.now()): Array<{ id: string; label: string; cwd: string; ageSec: number; log: string }> {
  return statuses
    .filter((s) => s.state === "running")
    .map((s) => ({ id: s.id, label: s.label, cwd: s.cwd, ageSec: Math.max(0, Math.round((now - s.startedMs) / 1000)), log: s.log }));
}

/** Show the log of a pane run live until it has ended, then `linger` more seconds. */
export async function followPaneRun(
  logDir: string,
  id: string,
  write: (s: string) => void,
  lingerSecs = PANE_LINGER_SECS,
  pollMs = 250
): Promise<void> {
  // the pane's purpose in the title bar before anything scrolls: a `pai pane
  // run` pane shows its label alone (no provider)
  writePaneTitle(paneTitle(loadPaneRunStatus(logDir, id)?.label ?? id), process.env);
  let at = 0;
  let endedAt = 0;
  for (;;) {
    const st = loadPaneRunStatus(logDir, id);
    try {
      const text = readFileSync(st?.log ?? join(paneRunLogDir(), `${id}.log`), "utf8");
      if (text.length > at) {
        write(text.slice(at));
        at = text.length;
      }
    } catch {
      /* not written yet */
    }
    if (st && st.state !== "running") {
      endedAt ||= Date.now();
      if (Date.now() - endedAt >= lingerSecs * 1000) return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export interface PaneRunOptions {
  command: string[];
  label?: string;
  cwd?: string;
  logDir: string;
  /** Opens the pane following `id`; a rejection is reported and the command runs anyway. */
  openPane: (id: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Process the signal handlers attach to (tests pass their own emitter). */
  proc?: NodeJS.Process;
  killGraceMs?: number;
}

const newId = (): string => `pane-${nowStamp().replace(/\D/g, "")}-${Math.random().toString(36).slice(2, 6)}`;

/** Run the command in the pane; resolves to its exit code (128+n for a signal). */
export async function runInPane(o: PaneRunOptions): Promise<number> {
  const env = o.env ?? process.env;
  const out = o.out ?? ((s: string) => process.stdout.write(s));
  const err = o.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const proc = o.proc ?? process;
  const cwd = o.cwd ?? process.cwd();
  const id = newId();
  const logFile = join(paneRunLogDir(), `${id}.log`);
  mkdirSync(paneRunLogDir(), { recursive: true });
  const status: PaneRunStatus = {
    kind: "pane",
    id,
    label: o.label || o.command.slice(0, 2).join(" "),
    cwd,
    pid: process.pid,
    started: nowStamp(),
    startedMs: Date.now(),
    state: "running",
    log: logFile,
  };
  writeFileSync(logFile, `$ ${o.command.join(" ")}\n`, "utf8");
  writePaneRunStatus(o.logDir, status);
  try {
    err(`[pai pane] ${id}: ${await o.openPane(id)}`);
  } catch (e) {
    err(`[pai pane] no visible pane (${e instanceof Error ? e.message : String(e)}); running without one, log ${logFile}`);
  }

  const argv = o.command.length === 1 ? ["/bin/sh", "-c", o.command[0]] : o.command;
  const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...env, [PANE_RUN_ENV]: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  const feed = (c: Buffer): void => {
    const s = c.toString("utf8");
    try {
      appendFileSync(logFile, s, "utf8");
    } catch {
      /* the log is a view */
    }
    tail = (tail + s).split("\n").slice(-(TAIL_LINES + 1)).join("\n");
  };
  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);

  let signalled: NodeJS.Signals | null = null;
  const killGroup = (sig: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* gone */
    }
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    if (signalled) return;
    signalled = sig;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), o.killGraceMs ?? 3000).unref();
  };
  const sigs: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  const handlers = sigs.map((s) => {
    const h = (): void => onSignal(s);
    proc.on(s, h);
    return h;
  });

  const code = await new Promise<number>((resolve) => {
    child.on("error", (e) => {
      feed(Buffer.from(`${e.message}\n`));
      resolve(127);
    });
    child.on("close", (c, sig) => resolve(c ?? (sig ? 128 + (({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[sig] ?? 0) : 1)));
  });
  sigs.forEach((s, i) => proc.off(s, handlers[i]));
  killGroup("SIGKILL"); // stragglers of the group

  const took = fmtElapsed(Date.now() - status.startedMs);
  const footer = `[exit ${code}${signalled ? ` (${signalled})` : ""} after ${took}]`;
  try {
    appendFileSync(logFile, `${tail.endsWith("\n") || !tail ? "" : "\n"}${footer}\n`, "utf8");
  } catch {
    /* as above */
  }
  writePaneRunStatus(o.logDir, { ...status, state: code === 0 ? "done" : "failed", exit: code });
  out(tail.replace(/\n+$/, "").split("\n").slice(-TAIL_LINES).join("\n") + `\n${footer}\n`);
  return signalled ? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as Record<string, number>)[signalled] : code;
}
