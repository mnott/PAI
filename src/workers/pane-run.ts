/**
 * pane-run.ts — `pai pane run`: a session's background command runs in a visible pane.
 *
 * The pane is opened first and owns the command (pane-exec.ts: the pane runs `pai pane exec <id>`, the
 * command is its child, the pane closes when it ends). The caller (the process Claude Code backgrounds)
 * tees the output to <PAI home>/logs/panes/<id>.log and blocks until the command ends, so the harness's
 * completion notification keeps working. With no terminal the command runs directly as the caller's child,
 * in its own process group.
 * Status lives in <logDir>/<id>.panestatus for `pai worker ps` and the cockpit.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { nowStamp, ownsPidCached } from "./status.js";
import { fmtElapsed } from "./plan-status.js";
import { paneTitle, writePaneTitle } from "./pane-title.js";
import { closeOwnPane, realPaneOps, type PaneOps } from "./pane.js";
import { PANE_EXEC_ENV, PANE_EXEC_PID_ENV, type OwnedPane } from "./pane-exec.js";

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
/** Seconds the pane stays on screen after the command ended, then closes itself. */
export const PANE_LINGER_SECS = 5;
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
    // running only while the recorded pid is alive AND is the process that started the run (a reused pid is not)
    return s.state === "running" && !ownsPidCached({ pid: s.pid, started: s.started }) ? { ...s, state: "lost" } : s;
  } catch {
    return null;
  }
}

/** Ended entries are kept this long (for ps and the audit), then removed. */
export const PANE_RUN_KEEP_MS = 24 * 3600_000;

/**
 * Every pane-run entry. A run whose runner died without writing its end is recorded as lost on disk
 * (so the pane reaper sees it ended and closes its pane); entries ended for over a day are removed.
 */
export function loadPaneRunStatuses(logDir: string, now = Date.now()): PaneRunStatus[] {
  if (!existsSync(logDir)) return [];
  const out: PaneRunStatus[] = [];
  for (const n of readdirSync(logDir).filter((x) => x.endsWith(".panestatus")).sort()) {
    const id = n.slice(0, -".panestatus".length);
    const s = loadPaneRunStatus(logDir, id);
    if (!s) continue;
    try {
      if (s.state !== "running" && now - s.startedMs > PANE_RUN_KEEP_MS) {
        unlinkSync(paneRunStatusFile(logDir, id));
        continue;
      }
      if (s.state === "lost" && (JSON.parse(readFileSync(paneRunStatusFile(logDir, id), "utf8")) as PaneRunStatus).state === "running") writePaneRunStatus(logDir, s);
    } catch {
      /* the entry is a view; a failed rewrite is retried next tick */
    }
    out.push(s);
  }
  return out;
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

/**
 * Show the log of a pane run live until it has ended, linger `linger` seconds so the last
 * line stays visible, then close the pane itself (in iTerm or tmux) and return.
 */
export async function followPaneRun(
  logDir: string,
  id: string,
  write: (s: string) => void,
  lingerSecs = PANE_LINGER_SECS,
  pollMs = 250,
  env: NodeJS.ProcessEnv = process.env,
  ops: PaneOps = realPaneOps
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
      if (Date.now() - endedAt >= lingerSecs * 1000) {
        // the pane closes itself whatever the exit code; the full output stays in the log
        await closeOwnPane(env, ops).catch(() => false);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export interface PaneRunOptions {
  command: string[];
  label?: string;
  cwd?: string;
  logDir: string;
  /**
   * Opens the pane that owns the run `id` (the launcher). null: no pane (no terminal, or already inside one),
   * the command runs directly. A rejection fails the run: the command does not run unseen.
   */
  launch: (id: string) => Promise<OwnedPane | null>;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Process the signal handlers attach to (tests pass their own emitter). */
  proc?: NodeJS.Process;
  killGraceMs?: number;
}

const newId = (): string => `pane-${nowStamp().replace(/\D/g, "")}-${Math.random().toString(36).slice(2, 6)}`;

/** Run the command in the pane that owns it; resolves to its exit code (128+n for a signal). */
export async function runInPane(o: PaneRunOptions): Promise<number> {
  const env = o.env ?? process.env;
  const out = o.out ?? ((s: string) => process.stdout.write(s));
  const err = o.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const proc = o.proc ?? process;
  const cwd = o.cwd ?? process.cwd();
  const id = newId();
  const logFile = join(paneRunLogDir(), `${id}.log`);
  mkdirSync(paneRunLogDir(), { recursive: true });
  const label = o.label || o.command.slice(0, 2).join(" ");
  const status: PaneRunStatus = {
    kind: "pane",
    id,
    label,
    cwd,
    pid: process.pid,
    started: nowStamp(),
    startedMs: Date.now(),
    state: "running",
    log: logFile,
  };
  writeFileSync(logFile, `$ ${o.command.join(" ")}\n`, "utf8");
  writePaneRunStatus(o.logDir, status);
  let pane: OwnedPane | null;
  try {
    pane = await o.launch(id);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    err(`[pai pane] ${id}: pane could not be opened (${why}); the command did not run`);
    appendFileSync(logFile, `[not run: ${why}]\n`, "utf8");
    writePaneRunStatus(o.logDir, { ...status, state: "failed", exit: 1 });
    return 1;
  }
  err(`[pai pane] ${id}: ${pane ? pane.where : "no pane (no terminal or already in one); running directly"}`);

  const argv = o.command.length === 1 ? ["/bin/sh", "-c", o.command[0]] : o.command;
  // a stale pane marker from the caller's own pane must not reach the child: the launcher sets its own
  const childEnv: NodeJS.ProcessEnv = { ...env, [PANE_RUN_ENV]: "1" };
  delete childEnv[PANE_EXEC_ENV];
  delete childEnv[PANE_EXEC_PID_ENV];
  let child: ChildProcess;
  try {
    child = pane
      ? (await pane.start({ argv, cwd, env: childEnv, stdin: "ignore", render: "plain", title: paneTitle(label) })).asChild()
      : spawn(argv[0], argv.slice(1), { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    err(`[pai pane] ${id}: ${e instanceof Error ? e.message : String(e)}`);
    writePaneRunStatus(o.logDir, { ...status, state: "failed", exit: 127 });
    return 127;
  }
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
    if (pane) {
      child.kill(sig);
      return;
    }
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
  if (!pane) killGroup("SIGKILL"); // stragglers of the group (the wrapper does the same for a pane)

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
