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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invalidateParse } from "../config/parse-cache.js";
import { paiHomePath } from "../config/pai-home.js";
import { nowStamp, ownsPidCached } from "./status.js";
import { fmtElapsed } from "./plan-status.js";
import { paneTitle, writePaneTitle } from "./pane-title.js";
import { closeOwnPane, realPaneOps, type PaneOps } from "./pane.js";
import { PANE_EXEC_ENV, PANE_EXEC_PID_ENV, type OwnedPane } from "./pane-exec.js";
import { panePolicy } from "./pane-policy.js";

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
  /** The caller's session name (PAI_SESSION_NAME) at pane start: the queue table's session column. */
  session?: string;
  /** The command line as started (`$ <command>` in the run's log): lets the queue match a waiter to the job it waits on. */
  command?: string;
}

/** The worker id a `pai pane run` command waits on: its first `pai worker wait[-on] <id>` argument (none = not a waiter). */
export function paneWaitsOn(command?: string): string | undefined {
  if (!command) return undefined;
  const m = command.match(/\bpai\s+worker\s+wait(?:-on)?\s+(?:(?:--\S+\s+)*)(\S+)/);
  return m?.[1];
}

/** The env marker of a command running under `pai pane run`: nested pane/build runs then stay in it. */
export const PANE_RUN_ENV = "PAI_PANE_RUN";
/** Seconds the pane stays on screen after the command ended, then closes itself. */

export const paneRunStatusFile = (logDir: string, id: string): string => join(logDir, `${id}.panestatus`);
export const paneRunLogDir = (): string => paiHomePath("logs", "panes");
export const isPaneRunId = (id: string): boolean => /^pane-[A-Za-z0-9._-]+$/.test(id);

export function writePaneRunStatus(logDir: string, s: PaneRunStatus): void {
  mkdirSync(logDir, { recursive: true });
  const path = paneRunStatusFile(logDir, s.id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), "utf8");
  renameSync(tmp, path);
  invalidatePaneRunCache(logDir);
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

/** One pane-run entry's disk identity: ns mtime/ctime + inode (a rewrite in the same clock tick with the same byte count still changes one of them). */
interface PaneEntryId {
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: number;
}
function paneFileIdentity(path: string): PaneEntryId {
  const st = statSync(path, { bigint: true });
  return { mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, ino: Number(st.ino) };
}
const paneFresh = (hit: { id: PaneEntryId }, id: PaneEntryId): boolean => hit.id.mtimeNs === id.mtimeNs && hit.id.ctimeNs === id.ctimeNs && hit.id.ino === id.ino;

interface PaneCacheEntry {
  at: number;
  /** The list as built: every entry parsed from disk (no lost-marking), with its file identity. */
  raw: Array<{ s: PaneRunStatus; id: PaneEntryId }>;
  /** The served view: `raw` with a dead runner's entry copy-on-written to "lost"; shared, read-only. */
  out: PaneRunStatus[];
  /** Ids whose lost state was persisted this window (the on-disk rewrite happens once per run). */
  marked: Set<string>;
}
const paneCache = new Map<string, PaneCacheEntry>();
/** loadPaneRunStatuses recomputes at most this often per logDir: the cockpit polls every few seconds and an unchanged set costs one stat per entry. */
export const PANE_RUN_TTL_MS = 2_000;

/** Drop this dir's cached pane-run list (a writer in this process, or a test that moves the clock). */
export function invalidatePaneRunCache(logDir: string): void {
  paneCache.delete(logDir);
}

/**
 * Every pane-run entry. A run whose runner died without writing its end is recorded as lost on disk
 * (so the pane reaper sees it ended and closes its pane); entries ended for over a day are removed.
 * Cached per logDir for PANE_RUN_TTL_MS: within the window every caller (the cockpit queue, the queue
 * table, the audit) gets the same list, and an entry whose file did not change is not even re-parsed —
 * one stat each. The served objects are shared with the cache: read-only. A writer in this process
 * drops the window through writePaneRunStatus; a rewrite by another process lands on a new inode or a
 * changed ns time and fails the identity check on the next window.
 */
export function loadPaneRunStatuses(logDir: string, now = Date.now()): PaneRunStatus[] {
  if (!existsSync(logDir)) return [];
  const hit = paneCache.get(logDir);
  if (hit && now - hit.at < PANE_RUN_TTL_MS) {
    // the window is open: re-check liveness only for entries still believed running
    let changed = false;
    const out = hit.out.map((s, i) => {
      if (s.state !== "running" || ownsPidCached({ pid: s.pid, started: s.started })) return s;
      changed = true;
      return { ...hit.raw[i]!.s, state: "lost" as const };
    });
    if (changed) hit.out = out;
    persistLost(logDir, hit);
    return out;
  }
  let keepMs: number | undefined; // the policy reads the config: once per rebuild, and only when an entry has ended
  const raw: PaneCacheEntry["raw"] = [];
  for (const n of readdirSync(logDir).filter((x) => x.endsWith(".panestatus")).sort()) {
    const id = n.slice(0, -".panestatus".length);
    const path = paneRunStatusFile(logDir, id);
    try {
      let entry = hit?.raw.find((r) => r.s.id === id);
      const fid = paneFileIdentity(path);
      if (!entry || !paneFresh(entry, fid)) {
        const s = JSON.parse(readFileSync(path, "utf8")) as PaneRunStatus;
        entry = { s, id: fid };
      }
      if (entry.s.state !== "running" && now - entry.s.startedMs > (keepMs ??= panePolicy().runKeepMs)) {
        unlinkSync(path);
        continue;
      }
      raw.push(entry);
    } catch {
      /* a half-written or damaged entry is not worth a crash; a vanished file is simply gone */
    }
  }
  const fresh: PaneCacheEntry = { at: now, raw, out: [], marked: new Set() };
  fresh.out = raw.map(({ s }) => (s.state === "running" && !ownsPidCached({ pid: s.pid, started: s.started }) ? { ...s, state: "lost" as const } : s));
  persistLost(logDir, fresh);
  // only a rebuilt list is cached: a rebuild at `now` that the next call would still serve is stored, one landing on its expiry is not (a caller passing a future `now` never poisons the window)
  if (Date.now() - now < PANE_RUN_TTL_MS) paneCache.set(logDir, fresh);
  return fresh.out;
}

/** The cached list itself, without the lost-marking: for a caller that marks liveness itself (the queue table). */
export function loadPaneRunStatusesRawCached(logDir: string, now = Date.now()): PaneRunStatus[] {
  const e = paneCache.get(logDir);
  if (e && now - e.at < PANE_RUN_TTL_MS) return e.raw.map((r) => r.s);
  loadPaneRunStatuses(logDir, now); // rebuilds the window (and marks lost on disk)
  return (paneCache.get(logDir)?.raw ?? []).map((r) => r.s);
}

/** Record a lost run on disk once per window (the reaper then sees it ended and closes its pane). */
function persistLost(logDir: string, e: PaneCacheEntry): void {
  for (let i = 0; i < e.out.length; i++) {
    const s = e.out[i]!;
    if (s.state !== "lost" || e.marked.has(s.id)) continue;
    try {
      if ((JSON.parse(readFileSync(paneRunStatusFile(logDir, s.id), "utf8")) as PaneRunStatus).state === "running") {
        writePaneRunStatus(logDir, s);
        // the rewrite changed this entry's file: re-stamp its identity so the next window does not see it as new
        const r = e.raw[i];
        if (r) r.id = paneFileIdentity(paneRunStatusFile(logDir, s.id));
      }
      e.marked.add(s.id);
    } catch {
      /* the entry is a view; a failed rewrite is retried next window */
    }
  }
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
 * line stays visible, then close the pane itself (in iTerm or tmux) and return true. A run that did not end
 * cleanly keeps its pane: returns false without closing.
 */
export async function followPaneRun(
  logDir: string,
  id: string,
  write: (s: string) => void,
  lingerSecs = panePolicy().lingerSecs,
  pollMs = panePolicy().runPollMs,
  env: NodeJS.ProcessEnv = process.env,
  ops: PaneOps = realPaneOps
): Promise<boolean> {
  // the pane's purpose in the title bar before anything scrolls: a `pai pane
  // run` pane shows its label alone (no provider)
  writePaneTitle(paneTitle(loadPaneRunStatus(logDir, id)?.label ?? id), process.env);
  // mark this pane as one PAI created (pane.ts's pickSplit only ever splits
  // marked panes): the split script already sets the variable at birth, this
  // keeps the mark for a pane opened before the mark existed. Real terminal
  // only; the value is the run id.
  if (process.stdout.isTTY === true && !process.env.TMUX) {
    try {
      process.stdout.write(`\x1b]1337;SetUserVar=paiWorkerPane=${Buffer.from(id).toString("base64")}\x07`);
    } catch {
      /* unwritable pane: the mark stays as the split script set it */
    }
  }
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
        // a clean end closes the pane; a failed or lost run keeps it open showing the failure until the operator
        // closes it (false: the caller must keep the process, and so the pane, alive)
        if (st.state !== "done") return false;
        await closeOwnPane(env, ops).catch(() => false);
        return true;
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
   * the command runs directly. A rejection is not a failure: the pane did not come up, so the command runs
   * directly too — output to the same log and the caller's streams, exit code the command's own.
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
    ...((env.PAI_SESSION_NAME || env.AIBROKER_SESSION_NAME || env.AIBROKER_SESSION) ? { session: env.PAI_SESSION_NAME || env.AIBROKER_SESSION_NAME || env.AIBROKER_SESSION } : {}),
  };
  const commandLine = o.command.join(" ");
  writeFileSync(logFile, `$ ${commandLine}\n`, "utf8");
  writePaneRunStatus(o.logDir, { ...status, command: commandLine });
  let pane: OwnedPane | null;
  try {
    pane = await o.launch(id);
  } catch (e) {
    // a pane that will not open or connect never stops the command: it runs directly, output to the same
    // log and to the caller (2026-11-17: a wrapper that never connected failed `pai build lock` unseen).
    // The "a run does not start unseen" rule is for worker runs; a pane-run command is not refused here.
    const why = e instanceof Error ? e.message : String(e);
    err(`[pai pane] ${id}: pane did not connect (${why}); running directly`);
    appendFileSync(logFile, `[pane did not connect: ${why}; running directly]\n`, "utf8");
    pane = null;
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
      ? (await pane.start({ argv, cwd, env: childEnv, stdin: "ignore", render: "plain", title: paneTitle(label), statusLine: { kind: "run", label, startedMs: status.startedMs } })).asChild()
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
    tail = (tail + s).split("\n").slice(-(panePolicy().tailLines + 1)).join("\n");
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
    setTimeout(() => killGroup("SIGKILL"), o.killGraceMs ?? panePolicy().killGraceMs).unref();
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
  out(tail.replace(/\n+$/, "").split("\n").slice(-panePolicy().tailLines).join("\n") + `\n${footer}\n`);
  return signalled ? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as Record<string, number>)[signalled] : code;
}
