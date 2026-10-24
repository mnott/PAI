/**
 * pane-bar.ts — the bottom of a launcher pane (`pai pane exec`): the transcript scrolls in a region
 * above a separator, the prompt row and the live status line, the layout `worker follow` had
 * (chatui.ts). One implementation: the status text is renderer's paneStatusRow / paneRunStatusRow,
 * the typed lines go through makeOperatorInput → sayToWorker like the old follow pane.
 */

import { createInterface } from "node:readline";
import { chatEnter, chatInsertLine, chatLeave, chatPromptRow, parseChatLine } from "./chatui.js";
import { paneRunStatusRow, paneStatusRow } from "./render.js";
import { readQueued as readQueuedFile, type QueuedFile } from "./capacity.js";
import { paneExecDir } from "./pane-exec.js";
import { isLive, type WorkerStatus } from "./status.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { panePolicy } from "./pane-policy.js";

/** What the wrapper is told to show at the bottom of the pane. */
export type StatusLineSpec =
  | { kind: "worker"; id: string; logDir: string }
  | { kind: "run"; label: string; startedMs: number };

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
    if (w + 1 > max) return out + "\x1b[0m";
    if (w + 1 === max && i + cp.length < text.length) return out + "…";
    out += cp;
    w += 1;
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
  let fill = 0;
  const region = (): number => Math.max(1, rows - 3);
  const retained: string[] = [];
  let status: WorkerStatus | null = null;
  const text = (): string => {
    if (d.spec.kind === "run") return paneRunStatusRow(d.spec.label, d.spec.startedMs, new Date(now()));
    // while the run waits for a provider slot the row is the queue line,
    // refreshed in place; the command's own row takes over once it starts
    const queued = (d.readQueued ?? readQueuedFile)(d.queuedDir ?? paneExecDir(), d.spec.id);
    if (queued) return paneStatusRow(status ?? ({} as WorkerStatus), new Date(now()), d.columns(), queued);
    status = (d.loadStatus ?? (() => null))(d.spec.logDir, d.spec.id) ?? status;
    return status ? paneStatusRow(status, new Date(now()), d.columns()) : d.spec.id;
  };
  const rl = d.spec.kind === "worker" && d.input ? createInterface({ input: d.input, output: silent(), terminal: d.input.isTTY === true }) : null;
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
  const tick = (): void => {
    d.write(paneStatusFrame(text(), rows, d.columns()));
    settle();
  };
  const line = (s: string, keep = true): void => {
    if (keep) {
      retained.push(s);
      if (retained.length > 500) retained.shift();
    }
    const r = chatInsertLine(s, fill, region());
    d.write(r.seq);
    fill = r.fill;
  };
  d.write(chatEnter(rows, d.columns() ?? 0, dim));
  prompt();
  tick();
  const timer = setInterval(tick, d.tickMs ?? panePolicy().statusTickMs);
  timer.unref();
  if (rl && d.spec.kind === "worker") {
    const { id, logDir } = d.spec;
    rl.on("line", (raw) => {
      const act = parseChatLine(raw);
      if (act.kind !== "message" || !act.text) return prompt();
      prompt();
      const turn = (d.loadStatus ?? (() => null))(logDir, id)?.turns ?? 0;
      (d.say ?? (() => Promise.reject(new Error("no say"))))(logDir, id, act.text).then(
        (reply) => {
          line(dim(`» ${act.text} — queued`));
          queued.push({ text: act.text, turn, pooled: reply.startsWith("queued") });
        },
        (e: Error) => line(`» ${act.text} — not delivered: ${e.message}`)
      );
    });
    (d.input as NodeJS.ReadableStream).on("keypress", () => {
      prompt();
      tick();
    });
  }
  d.onResize?.(() => {
    rows = d.rows();
    fill = 0;
    d.write(chatEnter(rows, d.columns() ?? 0, dim));
    for (const l of retained.slice(-region())) line(l, false);
    prompt();
    tick();
  });
  return {
    line: (s) => line(s),
    stop: () => {
      clearInterval(timer);
      rl?.close();
      d.write(chatLeave(rows));
    },
  };
}

/** readline edits silently; the bar draws the prompt row itself. */
function silent(): NodeJS.WriteStream {
  const s: Record<string, unknown> = { write: () => true, emit: () => false };
  for (const m of ["on", "once", "off", "removeListener"]) s[m] = () => s;
  return s as unknown as NodeJS.WriteStream;
}
