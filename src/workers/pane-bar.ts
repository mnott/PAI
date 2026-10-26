/**
 * pane-bar.ts — a launcher pane (`pai pane exec`): the pane switches to the alternate screen and keeps its
 * own scrollback (pane-viewport.ts); the transcript viewport sits above a separator, the prompt row and the
 * live status line, which stay on screen however far the operator scrolls (wheel, PageUp/PageDown,
 * Shift+Up/Down, End to follow). One implementation: the status text is renderer's paneStatusRow / paneRunStatusRow,
 * the typed lines go through makeOperatorInput → sayToWorker like the old follow pane.
 */

import { createInterface } from "node:readline";
import { cellWidth, chatBlankRow, chatPromptRow, parseChatLine, wrapText } from "./chatui.js";
import { PassThrough } from "node:stream";
import { applyScroll, PANE_ENTER, PANE_LEAVE, parseScrollInput, Viewport } from "./pane-viewport.js";
import { paneRunStatusRow, paneStatusRow } from "./render.js";
import { readQueued as readQueuedFile, type QueuedFile } from "./capacity.js";
import { reorderQueue } from "./capacity.js";
import { setWorkerPriority } from "./engine-control.js";
import { escalationLine } from "./reroute.js";
import { paneExecDir } from "./pane-exec.js";
import { isLive, type WorkerStatus } from "./status.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLedger } from "./ledger.js";
import { ledgerPath, statusPath } from "./paths.js";
import { panePolicy } from "./pane-policy.js";

/** What the wrapper is told to show at the bottom of the pane. */
export type StatusLineSpec =
  | { kind: "worker"; id: string; logDir: string }
  | { kind: "run"; label: string; startedMs: number };

/**
 * The deliberate-close marker: a pane the operator closed itself (pane-bar's /quit, the same way a worker's
 * own end closes its pane) records the worker id here, and the audit leaves that pane closed — it neither
 * reopens it (pane gone → reopen) nor kills the worker.
 */
export const paneClosedByFile = (logDir: string): string => join(logDir, "pane-closed-by.json");

/** Record (and read) the deliberate closes; a damaged file reads empty. */
export function readPaneClosedBy(logDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(paneClosedByFile(logDir), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Mark this worker's pane as deliberately closed (idempotent; a missing file is created). */
export function markPaneClosedBy(logDir: string, id: string, by = "pane command"): void {
  const all = readPaneClosedBy(logDir);
  if (all[id]) return;
  all[id] = by;
  try {
    writeFileSync(paneClosedByFile(logDir), JSON.stringify(all), "utf8");
  } catch {
    /* the pane is gone anyway: the audit then judges nothing */
  }
}

/** The pane's own slash commands, handled here and never forwarded to the model. */
const PANE_COMMANDS = ["/quit", "/exit", "/stop", "/help", "/now", "/cloud", "/local"];

/** The pane's own commands, listed by /help. */
export const PANE_HELP = [
  "/quit (or /exit)  close this pane only — the worker keeps running, reopen with pai worker pane <id>",
  "/stop [reason]    stop the worker (as pai worker kill <id> --reason)",
  "/pause            the worker stops working on its task and only talks; /continue resumes it",
  "/continue         clear the pause: resume the task where you stopped",
  "/now              go first: a queued worker moves to the front of its provider's queue, a running one gets high priority",
  "/cloud            run this job on the session's cloud provider (a queued job is re-routed, a running one is stopped, its commits kept, and continued there)",
  "/local            the reverse: run this job on the local model",
  "/help             this list",
  "scrolling         mouse wheel, PageUp/PageDown or Shift+Up/Down; End (or typing) follows the output again",
  "selecting text    mouse reporting is on: hold Option while dragging in iTerm",
];

/** The note a paused worker gets: it answers the operator and waits for /continue. */
export const PAUSE_NOTE =
  "The operator paused you. Stop working on the task: no edits, no commands, no further tool calls except to answer the operator. Answer the operator's messages, then wait for /continue.";

/** The note that clears the pause. */
export const CONTINUE_NOTE = "The operator says continue: resume the task where you stopped.";

/** The pause reason the worker guard answers with. */
export const PAUSE_DENY = "paused by the operator — answer, then wait for /continue";

/**
 * The worker's pause, read straight from its status file (the pane bar and the worker guard share it):
 * `pai worker pause|resume` and /pause|/continue write it, the guard reads it per tool call.
 */
export function workerPaused(logDir: string, id: string): boolean {
  try {
    const s = JSON.parse(readFileSync(statusPath(logDir, id), "utf8")) as { paused?: boolean };
    return s.paused === true;
  } catch {
    return false;
  }
}

/** Write the pause into the status file (a missing worker is left alone). */
function setWorkerPausedStatus(logDir: string, id: string, paused: boolean): void {
  try {
    const path = statusPath(logDir, id);
    const s = JSON.parse(readFileSync(path, "utf8")) as { paused?: boolean };
    s.paused = paused;
    writeFileSync(path, JSON.stringify(s), "utf8");
  } catch {
    /* no status: nothing to pause */
  }
}

export interface PaneBarDeps {
  spec: StatusLineSpec;
  write: (s: string) => void;
  rows: () => number;
  columns: () => number | null;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  loadStatus?: (logDir: string, id: string) => WorkerStatus | null;
  /** The caller's queue file (capacity.ts): what the pane shows while the run waits for a slot. */
  readQueued?: (dir: string, id: string) => QueuedFile | null;
  /** Queue-file dir (tests); default the pane-exec dir beside the launch record. */
  queuedDir?: string;
  say?: (logDir: string, id: string, text: string) => Promise<string>;
  /** Close this pane only (default: the pane-exec wrapper's own close). */
  closePane?: () => Promise<unknown>;
  /** Stop the worker the way `pai worker kill` does (default: killWorker with the pane's reason). */
  kill?: (logDir: string, id: string, reason: string) => Promise<unknown>;
  /** Move this worker to the front of its provider's queue (default: reorderQueue, as worker_queue next). */
  moveFront?: (logDir: string, id: string, provider: string) => unknown;
  /** Raise a running worker's priority (default: setWorkerPriority, as worker_priority). */
  setPriority?: (logDir: string, id: string, level: "high") => unknown;
  /** Move the worker to cloud/local (default: rerouteWorker, as pai worker reroute and worker_reroute). */
  reroute?: (logDir: string, id: string, where: "cloud" | "local") => Promise<{ provider: string }>;
  /** Record the deliberate close (default: markPaneClosedBy). */
  markClosed?: (logDir: string, id: string) => void;
  /** Write the pause into the worker's status (default: its own status file). */
  setPaused?: (logDir: string, id: string, paused: boolean) => void;
  /** Ledger hook for a delivered pane line (default: WORKER-NOTE-DELIVERED in the logDir's ledger). */
  delivered?: (logDir: string, id: string, count: number) => void;
  /** Whether the worker process still runs (default: status.isLive). */
  live?: (s: WorkerStatus) => boolean;
  now?: () => number;
  tickMs?: number;
  paint?: (color: string, s: string) => string;
  onResize?: (cb: () => void) => void;
}

export interface PaneBar {
  /** one transcript line above the fixed rows */
  line(s: string): void;
  stop(): void;
}

/** Visible-width truncation (ANSI sequences count 0); a cut line ends in "…". */
function fit(text: string, max: number): string {
  let out = "";
  let w = 0;
  for (let i = 0; i < text.length; ) {
    const m = /^\x1b\[[0-9;]*m/.exec(text.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    const cw = cellWidth(cp.codePointAt(0)!);
    if (w + cw > max) return out + "\x1b[0m";
    if (w + cw === max && i + cp.length < text.length) return out + "…";
    out += cp;
    w += cw;
    i += cp.length;
  }
  return out;
}

/**
 * One redraw of the status row: save the cursor, go to the row, clear the whole line, write the text cut to
 * columns-1 (a write into the last column wraps and scrolls the pane, which stacked every redraw), restore.
 */
export function paneStatusFrame(text: string, rows: number, columns: number | null): string {
  const body = columns ? fit(text, Math.max(1, columns - 1)) : text;
  return `\x1b7\x1b[${Math.max(1, rows)};1H\x1b[2K${body}\x1b8`;
}

export function startPaneBar(d: PaneBarDeps): PaneBar {
  const now = d.now ?? Date.now;
  const dim = (s: string): string => (d.paint ? d.paint("dim", s) : s);
  let rows = d.rows();
  const region = (): number => Math.max(1, rows - 3);
  const view = new Viewport(region());
  let status: WorkerStatus | null = null;
  const text = (): string => {
    if (d.spec.kind === "run") return paneRunStatusRow(d.spec.label, d.spec.startedMs, new Date(now()));
    // while the run waits for a provider slot the row is the queue line,
    // refreshed in place; the command's own row takes over once it starts
    const { id, logDir } = d.spec;
    const queued = (d.readQueued ?? readQueuedFile)(d.queuedDir ?? paneExecDir(), id);
    if (queued) return paneStatusRow(status ?? ({} as WorkerStatus), new Date(now()), d.columns(), queued);
    status = (d.loadStatus ?? (() => null))(logDir, id) ?? status;
    if (!status) return id;
    const row = paneStatusRow(status, new Date(now()), d.columns());
    // the pause shows in the bar whether the status came from disk or from a test seam
    return (status.paused === true || workerPaused(logDir, id)) ? `paused · ${row}` : row;
  };
  // stdin goes through a filter: wheel reports and scroll keys move the viewport, the rest feeds readline
  const src = d.input;
  const feed = src ? Object.assign(new PassThrough(), { isTTY: src.isTTY === true }) : null;
  const rawSet = src?.isTTY === true && typeof (src as unknown as { setRawMode?: unknown }).setRawMode === "function";
  if (rawSet) (src as unknown as { setRawMode: (m: boolean) => void }).setRawMode(true);
  const onData = (chunk: Buffer | string): void => {
    const { actions, rest } = parseScrollInput(chunk.toString());
    for (const a of actions) applyScroll(view, a);
    if (rest && !view.following) {
      view.toEnd(); // typing follows the output again
      actions.push("end");
    }
    if (actions.length) redraw();
    if (rest) feed?.write(rest);
  };
  src?.on("data", onData);
  const rl = d.spec.kind === "worker" && feed ? createInterface({ input: feed, output: silent(), terminal: feed.isTTY }) : null;
  const prompt = (): void => {
    if (rl) d.write(chatPromptRow(rows, rl.line, dim, (rl as unknown as { cursor?: number }).cursor));
  };
  // lines the worker accepted but has not yet answered: delivered once its turn counter moves past the queue-time turn
  // (headless: the line sits in claude's stdin queue; pooled: the note file is drained by the PostToolUse hook)
  const queued: { text: string; turn: number; pooled: boolean }[] = [];
  const settle = (): void => {
    if (!queued.length || d.spec.kind !== "worker") return;
    const { id, logDir } = d.spec;
    const st = (d.loadStatus ?? (() => null))(logDir, id);
    if (!st) return;
    const gone = !(d.live ?? isLive)(st);
    for (let i = queued.length - 1; i >= 0; i--) {
      const q = queued[i];
      const done = q.pooled ? !st.notePending?.includes(q.text) : st.turns > q.turn;
      if (!done && !gone) continue;
      queued.splice(i, 1);
      if (done) {
        line(dim(`» ${q.text} — delivered at turn ${st.turns}`));
        (d.delivered ?? ((l, w, n) => appendLedger(ledgerPath(l), "WORKER-NOTE-DELIVERED", { id: w, count: n })))(logDir, id, 1);
      } else line(`» ${q.text} — not delivered: worker ended (${st.state}) before its next turn`);
    }
  };
  // a reroute (the operator's /cloud or the supervision tick's escalation) leaves its mark in the status: say it once
  let rerouteShown = false;
  const announceReroute = (): void => {
    if (rerouteShown || d.spec.kind !== "worker") return;
    const r = (d.loadStatus ?? (() => null))(d.spec.logDir, d.spec.id)?.rerouted;
    if (!r || r.startsWith("skipped")) return;
    rerouteShown = true;
    line(dim(escalationLine(r)));
  };
  const tick = (): void => {
    announceReroute();
    const mark = view.indicator();
    d.write(paneStatusFrame(mark ? `${mark} · ${text()}` : text(), rows, d.columns()));
    settle();
  };
  const line = (s: string): void => {
    const cols = d.columns();
    // a row wider than the pane (unrendered command output) folds here; rendered rows already fit
    for (const row of cols ? wrapText(s, cols) : [s]) view.push(row);
    if (view.following) d.write(view.frame());
    else tick(); // the "↑ N lines" count moved
  };
  const enter = (): string => PANE_ENTER + chatBlankRow(rows, d.columns() ?? 0, dim) + `\x1b[${Math.max(1, rows - 1)};3H`;
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    d.write(PANE_LEAVE);
  };
  const redraw = (): void => {
    d.write(view.frame());
    tick();
    prompt();
  };
  d.write(enter());
  prompt();
  tick();
  const timer = setInterval(tick, d.tickMs ?? panePolicy().statusTickMs);
  timer.unref();
  if (rl && d.spec.kind === "worker") {
    const { id, logDir } = d.spec;
    rl.on("line", (raw) => {
      const act = parseChatLine(raw);
      prompt();
      // pane-local commands: handled here, never forwarded to the model
      const trimmed = raw.trim();
      if (trimmed.startsWith("/")) {
        const [word, ...rest] = trimmed.split(/\s+/);
        const arg = rest.join(" ");
        switch (word.toLowerCase()) {
          case "/quit":
          case "/exit":
            line(dim(`» ${id}: pane closed, the worker keeps running — reopen with pai worker pane ${id}`));
            (d.markClosed ?? markPaneClosedBy)(logDir, id);
            void (d.closePane?.() ?? Promise.resolve()).catch(() => undefined);
            return;
          case "/stop": {
            const reason = arg || "operator /stop in pane";
            line(dim(`» stopping ${id}: ${reason}`));
            const kill =
              d.kill ??
              (async (ld, wid, r) => {
                const { killWorker } = await import("./kill-tree.js");
                return killWorker(ld, wid, { by: "pane command", reason: r });
              });
            void kill(logDir, id, reason).catch((e: Error) => line(`» ${id} — not stopped: ${e.message}`));
            return;
          }
          case "/pause":
            line(dim("» paused: the worker answers the operator and waits for /continue"));
            (d.setPaused ?? setWorkerPausedStatus)(logDir, id, true);
            void (d.say ?? (() => Promise.reject(new Error("no say"))))(logDir, id, PAUSE_NOTE).catch((e: Error) =>
              line(`» pause note — not delivered: ${e.message}`)
            );
            return;
          case "/continue":
            line(dim("» continued: the worker resumes the task"));
            (d.setPaused ?? setWorkerPausedStatus)(logDir, id, false);
            void (d.say ?? (() => Promise.reject(new Error("no say"))))(logDir, id, CONTINUE_NOTE).catch((e: Error) =>
              line(`» continue note — not delivered: ${e.message}`)
            );
            return;
          case "/now": {
            const q = (d.readQueued ?? readQueuedFile)(d.queuedDir ?? paneExecDir(), id);
            try {
              if (q) {
                (d.moveFront ?? ((ld, wid, prov) => reorderQueue(ld, prov, wid, "front")))(logDir, id, q.provider);
                line(dim(`» ${id}: first in line on ${q.provider}`));
              } else {
                (d.setPriority ?? ((ld, wid, lvl) => setWorkerPriority(ld, wid, lvl, "pane")))(logDir, id, "high");
                line(dim(`» ${id}: priority high`));
              }
            } catch (e) {
              line(`» ${id} — /now failed: ${(e as Error).message}`);
            }
            return;
          }
          case "/cloud":
          case "/local": {
            const where = word.toLowerCase() === "/cloud" ? "cloud" : "local";
            line(dim(`» moving ${id} to ${where}…`));
            const move =
              d.reroute ??
              (async (ld, wid, w) => {
                const { rerouteWorker } = await import("./reroute.js");
                return rerouteWorker(wid, w, { logDir: ld, by: "pane command" });
              });
            void move(logDir, id, where).then(
              (r) => line(dim(`» ${id}: started again on ${r.provider}`)),
              (e: Error) => line(`» ${id} — not moved: ${e.message}`)
            );
            return;
          }
          case "/help":
            for (const h of PANE_HELP) line(dim(h));
            return;
          default:
            if (PANE_COMMANDS.includes(word.toLowerCase())) return;
            line(dim(`unknown pane command: ${word} — /help lists them`));
            return;
        }
      }
      if (act.kind !== "message" || !act.text) return;
      const turn = (d.loadStatus ?? (() => null))(logDir, id)?.turns ?? 0;
      (d.say ?? (() => Promise.reject(new Error("no say"))))(logDir, id, act.text).then(
        (reply) => {
          line(dim(`» ${act.text} — queued`));
          queued.push({ text: act.text, turn, pooled: reply.startsWith("queued") });
        },
        (e: Error) => line(`» ${act.text} — not delivered: ${e.message}`)
      );
    });
    feed?.on("keypress", () => {
      prompt();
      tick();
    });
  }
  d.onResize?.(() => {
    rows = d.rows();
    view.resize(region());
    d.write(enter());
    redraw();
  });
  process.once("exit", leave);
  return {
    line: (s) => line(s),
    stop: () => {
      clearInterval(timer);
      rl?.close();
      src?.off("data", onData);
      (src as unknown as { pause?: () => void } | undefined)?.pause?.();
      if (rawSet) (src as unknown as { setRawMode?: (m: boolean) => void }).setRawMode?.(false);
      process.off("exit", leave);
      leave();
      // a one-shot command's output must outlive the alternate screen
      if (d.spec.kind === "run" && view.length) d.write(view.all().join("\n") + "\n");
    },
  };
}

/** readline edits silently; the bar draws the prompt row itself. */
function silent(): NodeJS.WriteStream {
  const s: Record<string, unknown> = { write: () => true, emit: () => false };
  for (const m of ["on", "once", "off", "removeListener"]) s[m] = () => s;
  return s as unknown as NodeJS.WriteStream;
}
