/**
 * viewer.ts — ps / follow / replay / status line over the worker logDir.
 *
 * Scoping: workers launched from this terminal's AIBroker session (or, as the
 * fallback, its iTerm tab) unless --all or an explicit worker id is given.
 * Outside iTerm, everything degrades to "all workers" — the Python behaviour.
 *
 * Transcripts render with a `HH:MM:SS │ ` gutter (2g): dim, taken from the
 * `_ts` stamp on every mirrored event, the worker tag in front when several
 * run at once, a date separator when the day changes, and — on a TTY — a
 * liveness line (`⋯ 12s since last event · Bash: npm test · ctx 84k/200k (42%)`)
 * that is rewritten in place between events. Following one worker also wires
 * this pane's stdin: every typed line is said to the worker while it runs and
 * resumes it (same Claude session) once it has finished.
 */

import { existsSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { eventsPath } from "./paths.js";
import { alive, loadStatuses, type WorkerStatus } from "./status.js";
import { currentTabKey, resolveSession, workerInScope } from "./scope.js";
import { sayToWorker } from "./operator.js";
import {
  contextMeter,
  gutterFor,
  headerLine,
  makeColor,
  renderEvent,
  renderStatusLine,
  renderTable,
  type StreamEventLike,
  type ToolUseBlock,
} from "./render.js";

// ---------------------------------------------------------------------------
// ps
// ---------------------------------------------------------------------------

export function psOutput(
  logDir: string,
  showAll: boolean,
  env: NodeJS.ProcessEnv = process.env,
  color = process.stdout.isTTY === true
): string {
  const c = makeColor(color);
  const term = env.ITERM_SESSION_ID ?? "";
  const statuses = loadStatuses(logDir);
  const scoped = showAll || !term ? statuses : statuses.filter((s) => workerInScope(s, term));
  const scopeLabel =
    showAll || !term
      ? "scope: all workers"
      : resolveSession(term)
        ? `scope: session ${resolveSession(term)!.name}`
        : `scope: tab ${currentTabKey(env)} (this iTerm tab)`;
  return renderTable(c, scoped, scopeLabel);
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

/** The rendered transcript of one worker, from the start, as one string. */
export function replayOutput(
  logDir: string,
  wid: string,
  color = process.stdout.isTTY === true,
  tailLines?: number
): string {
  const path = eventsPath(logDir, wid);
  if (!existsSync(path)) {
    throw new Error(`no event log for ${wid}`);
  }
  const c = makeColor(color);
  const st =
    loadStatuses(logDir).find((s) => s.id === wid) ??
    ({ id: wid, label: "", cwd: "", provider: "" } as WorkerStatus);
  const tools: Record<string, string> = {};
  const out: string[] = [headerLine(c, st)];
  const lines = readFileSync(path, "utf8").split("\n");
  let lastDay = "";
  for (const line of tailLines !== undefined ? lines.slice(-tailLines) : lines) {
    if (!line.trim()) continue;
    let e: StreamEventLike;
    try {
      e = JSON.parse(line) as StreamEventLike;
    } catch {
      continue;
    }
    if (typeof e._ts === "string" && e._ts.slice(0, 10) !== lastDay) {
      lastDay = e._ts.slice(0, 10);
      out.push(c("dim", `── ${lastDay} ──`));
    }
    const g = gutterFor(c, e);
    collectTools(e, tools);
    out.push(...renderEvent(c, g ? "" : "  ", e, st.cwd ?? "", tools, g));
  }
  return out.join("\n");
}

function collectTools(e: StreamEventLike, tools: Record<string, string>): void {
  if (e.type !== "assistant") return;
  for (const b of e.message?.content ?? []) {
    if (b.type === "tool_use" && b.id) tools[b.id] = b.name ?? "?";
  }
}

// ---------------------------------------------------------------------------
// follow
// ---------------------------------------------------------------------------

interface FollowHandle {
  fd: number;
  buf: string;
}

/**
 * The follow exit decision for one worker: it is over once its result event
 * was rendered, or once its status left "running" while its pid is gone — a
 * worker killed without writing a result still ends. A status never read
 * (undefined) means "not over": follow keeps waiting for the first event.
 */
export function workerEnded(
  resultRendered: boolean,
  state: WorkerStatus["state"] | undefined,
  pidAlive: boolean
): boolean {
  return resultRendered || (state !== undefined && state !== "running" && !pidAlive);
}

/**
 * Tail one worker (target) or the running workers of this scope, live.
 * Auto-exit: with a target, wait `autoExit` seconds after its end; without
 * one, exit once no worker in scope has run for that many seconds in a row,
 * never within the first 30 s. With a target on a TTY, typed stdin lines are
 * said to the worker (or resume it after it finished).
 */
export async function followWorkers(
  logDir: string,
  target: string | null,
  showAll: boolean,
  autoExit: number,
  env: NodeJS.ProcessEnv = process.env,
  color = process.stdout.isTTY === true
): Promise<void> {
  const c = makeColor(color);
  const tty = process.stdout.isTTY === true;
  const term = env.ITERM_SESSION_ID ?? "";
  const scopeTab = target || showAll ? "" : currentTabKey(env);
  const tools: Record<string, string> = {};
  const handles = new Map<string, FollowHandle>();
  const seenHeader = new Set<string>();
  const finished = new Set<string>();
  const lastDayBy = new Map<string, string>();
  const started = Date.now();
  let idleSince: number | null = null;
  let aborted = false;
  // liveness state (2g): rewritten in place between events, TTY only
  let lastEventAt = Date.now();
  let lastAction = "waiting for first event";
  let meterStatus: WorkerStatus | null = null;
  let livenessLen = 0;
  const onInt = () => {
    aborted = true;
  };
  process.once("SIGINT", onInt);

  // the plain-length twin of a coloured string (liveness must be erased by width)
  const plainOf = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
  const eraseLiveness = () => {
    if (livenessLen > 0) {
      process.stdout.write("\r" + " ".repeat(livenessLen) + "\r");
      livenessLen = 0;
    }
  };
  const writeLiveness = () => {
    if (!tty) return;
    eraseLiveness();
    const secs = Math.max(0, Math.floor((Date.now() - lastEventAt) / 1000));
    const meter = meterStatus ? contextMeter(c, meterStatus) : null;
    const plain = `⋯ ${secs}s since last event · ${lastAction}${meter ? ` · ${plainOf(meter)}` : ""}`;
    process.stdout.write("\r" + `⋯ ${c("dim", `${secs}s since last event`)} · ${lastAction}${meter ? ` · ${meter}` : ""}`);
    livenessLen = plain.length;
  };

  const runningIds = (): string[] =>
    loadStatuses(logDir)
      .filter(
        (s) =>
          s.state === "running" &&
          alive(s.pid) &&
          (target !== null || showAll || (scopeTab ? workerInScope(s, term) : true))
      )
      .map((s) => s.id);

  // --- operator input (2i): this pane's stdin drives say/resume
  const noteLine = (s: string) => {
    eraseLiveness();
    process.stdout.write(s + "\n");
  };
  const resumeTarget = (text: string, id: string) => {
    noteLine(c("dim", `» resuming ${id} …`));
    // SpawnOptions (not the stdio-tuple overload): we only read stdout and
    // want the plain ChildProcess shape
    const child = spawn(
      "pai",
      ["worker", "resume", id, text, "--print-id", "--no-pane"],
      { stdio: ["ignore", "pipe", "inherit"] } as import("node:child_process").SpawnOptions
    );
    let idOut = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      idOut += chunk.toString("utf8");
    });
    child.on("close", (rc: number | null) => {
      const newId = idOut.trim().split("\n").pop() ?? "";
      if (rc === 0 && /^[0-9]{8}-[0-9]{6}-[0-9]+$/.test(newId)) {
        noteLine(c("dim", `» resumed as ${newId}`));
        target = newId;
        finished.delete(newId);
        seenHeader.delete(newId);
        lastEventAt = Date.now();
        lastAction = "resumed";
      } else {
        noteLine(c("red", `» resume failed (rc=${rc})`));
      }
    });
  };
  const handleOperatorLine = (raw: string) => {
    const text = raw.trim();
    if (!text || target === null) return;
    const id = target; // narrowed copy for the async callbacks below
    sayToWorker(logDir, id, text).then(
      () => noteLine(c("dim", `» sent to ${id}`)),
      (e: Error) => {
        if (loadStatuses(logDir).some((s) => s.id === id)) resumeTarget(text, id);
        else noteLine(c("red", `» ${e.message}`));
      }
    );
  };
  // the readline interface keeps stdin flowing — without a close, the process
  // outlives follow itself (a pane then never closes, however long ago the
  // worker ended), so it is closed in the finally block below
  let rlIn: ReturnType<typeof createInterface> | null = null;
  if (target !== null && process.stdin.isTTY) {
    rlIn = createInterface({ input: process.stdin });
    rlIn.on("line", handleOperatorLine);
  }

  try {
    for (;;) {
      if (aborted) return;
      for (const wid of target ? [target] : runningIds()) {
        if (handles.has(wid) || finished.has(wid)) continue;
        const path = eventsPath(logDir, wid);
        if (existsSync(path)) handles.set(wid, { fd: openSync(path, "r"), buf: "" });
      }
      const statuses = new Map(loadStatuses(logDir).map((s) => [s.id, s]));
      const multi = handles.size > 1 || target === null;
      let progressed = false;

      for (const [wid, h] of [...handles.entries()]) {
        const st = statuses.get(wid) ?? ({ id: wid, label: "", cwd: "", provider: "" } as WorkerStatus);
        const prefix = multi ? c("cyan", wid.slice(-4)) + c("dim", " ┃ ") : "  ";
        // read everything appended since the last poll (fd position advances)
        const buffer = Buffer.alloc(65536);
        for (;;) {
          let n: number;
          try {
            n = readSync(h.fd, buffer, 0, buffer.length, null);
          } catch {
            n = 0;
          }
          if (n <= 0) break;
          h.buf += buffer.toString("utf8", 0, n);
        }
        const lines = h.buf.split("\n");
        h.buf = lines.pop() ?? "";
        for (const line of lines) {
          progressed = true;
          if (!seenHeader.has(wid)) {
            eraseLiveness();
            process.stdout.write(headerLine(c, st) + "\n");
            seenHeader.add(wid);
          }
          if (!line.trim()) continue;
          let e: StreamEventLike;
          try {
            e = JSON.parse(line) as StreamEventLike;
          } catch {
            continue;
          }
          const day = typeof e._ts === "string" ? e._ts.slice(0, 10) : "";
          if (day && day !== lastDayBy.get(wid)) {
            eraseLiveness();
            process.stdout.write(`${multi ? prefix : ""}${c("dim", `── ${day} ──`)}\n`);
            lastDayBy.set(wid, day);
          }
          collectTools(e, tools);
          const g = gutterFor(c, e, multi ? c("cyan", wid.slice(-4)) : undefined);
          eraseLiveness();
          for (const ln of renderEvent(c, g ? "" : prefix, e, st.cwd ?? "", tools, g)) {
            process.stdout.write(ln + "\n");
          }
          lastEventAt = Date.now();
          if (e.type === "operator") {
            lastAction = "operator message";
          } else if (e.type === "assistant") {
            const tool = (e.message?.content ?? []).find((b) => b.type === "tool_use");
            lastAction = tool ? `${tool.name ?? "?"} running` : "thinking";
          } else if (e.type === "result") {
            lastAction = "finished";
          }
          meterStatus = st;
          if (e.type === "result") finished.add(wid);
        }
        const ended = workerEnded(finished.has(wid), st.state, alive(st.pid));
        if (ended) {
          if (!finished.has(wid)) {
            eraseLiveness();
            process.stdout.write(`${prefix}${c("red", "✗ " + (st.state || "ended"))} · ${st.last ?? ""}\n`);
            finished.add(wid);
          }
          closeSync(h.fd);
          handles.delete(wid);
        }
      }

      const lingerOn = target; // resume swaps `target` under us (see above)
      if (lingerOn !== null && finished.has(lingerOn)) {
        if (autoExit) {
          const until = Date.now() + autoExit * 1000;
          while (Date.now() < until && !aborted && target === lingerOn) {
            writeLiveness();
            await sleep(250);
          }
          // interrupted, or the worker was resumed inside the window: follow on
          if (aborted || target !== lingerOn) continue;
          eraseLiveness();
          process.stdout.write(c("dim", "closing") + "\n");
          return;
        }
        // no auto-exit: only a terminal follow with no wired stdin is done —
        // an interactive one stays up for say / resume input
        if (rlIn === null) return;
      }
      if (autoExit && !target) {
        if (runningIds().length) {
          idleSince = null;
        } else if (idleSince === null) {
          idleSince = Date.now();
        } else if (Date.now() - started >= 30_000 && Date.now() - idleSince >= autoExit * 1000) {
          eraseLiveness();
          process.stdout.write(c("dim", "closing") + "\n");
          return;
        }
      }
      if (!progressed) {
        writeLiveness();
        await sleep(500);
      }
    }
  } finally {
    // close before anything else: an open readline keeps the process (and the
    // iTerm pane running it) alive long after follow has decided to end
    rlIn?.close();
    process.removeListener("SIGINT", onInt);
    for (const h of handles.values()) {
      try {
        closeSync(h.fd);
      } catch {
        /* already closed */
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// status line
// ---------------------------------------------------------------------------

/** Workers of this terminal for the status bar; "" when there are none. */
export function statusLineOutput(
  logDir: string,
  term: string,
  cwd: string,
  now: Date = new Date()
): string {
  const statuses = loadStatuses(logDir);
  const mine = statuses.filter((s) => {
    const sameScope = term && workerInScope(s, term);
    const sameDir = cwd && s.cwd.startsWith(cwd);
    return sameScope || (!term && sameDir);
  });
  return renderStatusLine(mine, now);
}
