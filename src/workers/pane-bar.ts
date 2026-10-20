/**
 * pane-bar.ts — the bottom of a launcher pane (`pai pane exec`): the transcript scrolls in a region
 * above a separator, the prompt row and the live status line, the layout `worker follow` had
 * (chatui.ts). One implementation: the status text is renderer's paneStatusRow / paneRunStatusRow,
 * the typed lines go through makeOperatorInput → sayToWorker like the old follow pane.
 */

import { createInterface } from "node:readline";
import { chatEnter, chatInsertLine, chatLeave, chatPromptRow, chatTickerRow, parseChatLine } from "./chatui.js";
import { paneRunStatusRow, paneStatusRow } from "./render.js";
import type { WorkerStatus } from "./status.js";

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
  say?: (logDir: string, id: string, text: string) => Promise<string>;
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
    status = (d.loadStatus ?? (() => null))(d.spec.logDir, d.spec.id) ?? status;
    return status ? paneStatusRow(status, new Date(now()), d.columns()) : d.spec.id;
  };
  const rl = d.spec.kind === "worker" && d.input ? createInterface({ input: d.input, output: silent(), terminal: d.input.isTTY === true }) : null;
  const col = (): number => 3 + Math.min((rl as unknown as { cursor?: number } | null)?.cursor ?? 0, rl?.line.length ?? 0);
  const prompt = (): void => {
    if (rl) d.write(chatPromptRow(rows, rl.line, dim, (rl as unknown as { cursor?: number }).cursor));
  };
  const tick = (): void => d.write(chatTickerRow(text(), rows, rl ? col() : 1));
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
  const timer = setInterval(tick, d.tickMs ?? 1000);
  timer.unref();
  if (rl && d.spec.kind === "worker") {
    const { id, logDir } = d.spec;
    rl.on("line", (raw) => {
      const act = parseChatLine(raw);
      if (act.kind !== "message" || !act.text) return prompt();
      prompt();
      (d.say ?? (() => Promise.reject(new Error("no say"))))(logDir, id, act.text).then(
        () => line(dim(`» ${act.text}`)),
        (e: Error) => line(`» ${e.message}`)
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
