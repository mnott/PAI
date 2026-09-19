/**
 * viewer.ts — ps / follow / replay / status line over the worker logDir.
 *
 * Scoping: workers launched from this terminal's AIBroker session (or, as the
 * fallback, its iTerm tab) unless --all or an explicit worker id is given.
 * Outside iTerm, everything degrades to "all workers" — the Python behaviour.
 *
 * Transcripts render with a `HH:MM:SS │ ` gutter (2g): dim, taken from the
 * `_ts` stamp on every mirrored event (local wall clock — stamps carry a local
 * offset and old UTC stamps are converted), the worker tag in front when
 * several run at once, a date separator when the day changes, and — on a TTY —
 * a liveness line (`⋯ 12s · run tests before the fix · $ bun run test`) that
 * is rewritten in place between events. Attaching to a worker that is already
 * running first replays its last events (backfill), then continues live.
 *
 * Following one worker turns the pane into a small chat (see chatui.ts): the
 * transcript scrolls in a region that ends two rows above the bottom, the
 * prompt row (`› `, readline editing) and the ticker row stay fixed, and every
 * submitted line is said to the worker while it runs and resumes it (same
 * Claude session) once it has finished. Lines the pane wraps itself keep the
 * `│` bar on continuation rows, so no content ever lands left of the bar.
 * Non-TTY output keeps the plain scrolling behaviour.
 */

import { existsSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn, type SpawnOptions } from "node:child_process";
import { eventsPath } from "./paths.js";
import { alive, loadStatuses, type WorkerStatus } from "./status.js";
import { currentTabKey, resolveSession, workerInScope } from "./scope.js";
import { readInbox } from "./handoff.js";
import { sayToWorker } from "./operator.js";
import {
  CHAT_HELP,
  chatBlankRow,
  chatEnter,
  chatInsertLine,
  chatLeave,
  chatPromptRow,
  chatScrollRegion,
  chatTickerRow,
  holdAutoExit,
  parseChatLine,
  wrapText,
} from "./chatui.js";
import {
  blankBetween,
  contextMeter,
  dayOf,
  gutterFor,
  headerLine,
  intentOf,
  makeColor,
  paneStatusRow,
  renderEvent,
  renderStatusLine,
  renderTable,
  tickerText,
  tickerTool,
  type Gutter,
  type Paint,
  type StatusRow,
  type StreamEventLike,
} from "./render.js";

/** How many existing events a fresh follow pane replays before going live. */
export const BACKFILL_EVENTS = 200;

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
  const inbox = inboxCounts(logDir, scoped);
  return renderTable(c, scoped, scopeLabel, new Date(), inbox);
}

/** Handoffs waiting in each listed worker's inbox: id → count. */
export function inboxCounts(logDir: string, statuses: WorkerStatus[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of statuses) {
    const n = readInbox(logDir, s.id).length;
    if (n) out[s.id] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// one event → rendered lines (shared by replay, backfill and the live tail)
// ---------------------------------------------------------------------------

/** What applyEvent() carries between the events of one transcript. */
export interface FollowState {
  /** day separator already printed ("" before the first stamped event). */
  lastDay: string;
  /** tool_use id → tool name (Edit previews and Read trimming need it). */
  tools: Record<string, string>;
  /** the worker's last stated intent — its last assistant text, ≤60 chars. */
  intent: string;
  /** the ticker's tool part of the last tool_use ("$ bun run test"). */
  tool: string;
  /** the last event seen, for the blank line between turns. */
  prev: StreamEventLike | null;
}

export function initialFollowState(intent = "waiting for first event"): FollowState {
  return { lastDay: "", tools: {}, intent, tool: "", prev: null };
}

/** One applied event: what to print, and how the ticker changes. */
export interface FollowStep {
  /** rendered lines ("" among them marks the blank line between turns). */
  lines: string[];
  /** day separator to print first, when the stamp's local day changed. */
  day: string | null;
  /** the event produced visible output — the ticker clock restarts. */
  activity: boolean;
  state: FollowState;
}

/**
 * Gutter the rendered body of one event, wrapping when the pane width is
 * known. Unwrapped (null `wrapWidth`, e.g. piped output): the first row gets
 * the stamped gutter, later rows of the event blanks — exactly the pre-chat
 * rendering. Wrapped: every row is folded at `wrapWidth` columns and each
 * continuation row carries the blank gutter with the `│` bar, so the bar runs
 * unbroken down the pane and no content ever lands left of it.
 */
export function gutterBody(
  body: string[],
  gutter: Gutter | null,
  wrapWidth: number | null
): string[] {
  if (!gutter) return body;
  if (wrapWidth === null || wrapWidth <= gutter.width) {
    return body.map((ln, i) => (i === 0 ? gutter.first : gutter.cont) + ln);
  }
  const out: string[] = [];
  for (const ln of body) {
    for (const piece of wrapText(ln, wrapWidth - gutter.width)) {
      out.push((out.length === 0 ? gutter.first : gutter.barCont) + piece);
    }
  }
  return out;
}

/**
 * Render one event and advance the follow state. Everything the viewer shows
 * between events of one worker comes from here: replay, the backfill on
 * attach and the live tail all use it, so they space identically — events
 * back to back, one blank line between turns. `activity` is false for events
 * that render nothing (stream noise, empty tool results): they leave the
 * ticker's "since last event" clock running. `wrapWidth` (the pane's column
 * count, re-read on resize) makes the viewer wrap rows itself; null keeps
 * the terminal's own wrapping.
 */
export function applyEvent(
  c: Paint,
  s: FollowState,
  e: StreamEventLike,
  cwd: string,
  tag?: string,
  offMin?: number,
  wrapWidth?: number | null
): FollowStep {
  const tools = { ...s.tools };
  if (e.type === "assistant") {
    for (const b of e.message?.content ?? []) {
      if (b.type === "tool_use" && b.id) tools[b.id] = b.name ?? "?";
    }
  }
  const day = typeof e._ts === "string" ? (dayOf(e._ts, offMin) ?? rawDay(e._ts)) : "";
  const state: FollowState = {
    lastDay: day && day !== s.lastDay ? day : s.lastDay,
    tools,
    intent: s.intent,
    tool: s.tool,
    prev: e,
  };
  if (e.type === "assistant") {
    for (const b of e.message?.content ?? []) {
      if (b.type === "text" && (b.text ?? "").trim()) state.intent = intentOf(b.text ?? "");
      else if (b.type === "tool_use") state.tool = tickerTool(b.name ?? "?", b.input);
    }
  }
  const gutter = gutterFor(c, e, tag, offMin);
  const prefix = "";
  const body = gutterBody(renderEvent(c, prefix, e, cwd, tools), gutter, wrapWidth ?? null);
  // the turn separator carries the gutter's bar (barCont) so the │ runs
  // unbroken down the pane; "" only when the event has no stamp/gutter
  const lines = blankBetween(s.prev, e) ? [gutter ? gutter.barCont : "", ...body] : body;
  return {
    lines,
    day: day && day !== s.lastDay ? day : null,
    activity: lines.some((ln) => ln !== ""),
    state,
  };
}

/** `YYYY-MM-DD` straight out of an unparsable stamp, "" when it has none. */
function rawDay(ts: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : "";
}

/**
 * The events a fresh follow replays before going live: the last `cap`
 * non-empty log lines, oldest first.
 */
export function backfillLines(raw: string, cap = BACKFILL_EVENTS): string[] {
  return raw.split("\n").filter((l) => l.trim()).slice(-cap);
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
  const wrapWidth = typeof process.stdout.columns === "number" ? process.stdout.columns : null;
  const out: string[] = [headerLine(c, st)];
  const raw = readFileSync(path, "utf8");
  const lines = tailLines !== undefined ? raw.split("\n").slice(-tailLines) : raw.split("\n");
  // the worker's inbox handoffs join the transcript where they happened (_ts)
  const handoffs: StreamEventLike[] = readInbox(logDir, wid).map((h) => ({
    type: "handoff",
    from: h.from,
    kind: h.kind,
    text: h.text,
    _ts: h._ts,
  }));
  let state = initialFollowState("");
  const events: StreamEventLike[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: StreamEventLike;
    try {
      e = JSON.parse(line) as StreamEventLike;
    } catch {
      continue;
    }
    events.push(e);
  }
  const stamp = (e: StreamEventLike): number => {
    const t = e._ts ? Date.parse(e._ts) : NaN;
    return Number.isNaN(t) ? 0 : t;
  };
  const merged = [...events, ...handoffs].sort((a, b) => stamp(a) - stamp(b));
  for (const e of merged) {
    const step = applyEvent(c, state, e, st.cwd ?? "", undefined, undefined, wrapWidth);
    if (step.day) out.push(c("dim", `── ${step.day} ──`));
    out.push(...step.lines);
    state = step.state;
  }
  return out.join("\n");
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

// ---------------------------------------------------------------------------
// operator input (2i): this pane's stdin drives say / resume
// ---------------------------------------------------------------------------

/** What makeOperatorInput() needs from the follow around it. */
export interface OperatorInputDeps {
  /** the worker typed lines go to right now (null: none, lines are ignored). */
  target: () => string | null;
  /** forwards one message to a running worker. */
  say: (id: string, text: string) => Promise<string>;
  /** whether a status file exists for the id (say failed → resume, or note). */
  workerKnown: (id: string) => boolean;
  /** continues a finished worker (same Claude session). */
  resume: (text: string, id: string) => void;
  /** one line of feedback in the pane. */
  note: (s: string) => void;
  paint: Paint;
  /** chat mode only: the echoed line replaces the "» sent" note. */
  sent?: (id: string) => void;
}

/**
 * One typed stdin line → say (worker running) or resume (worker finished):
 * the operator channel of a `follow <id>` pane. Trimmed; empty lines and a
 * missing target are ignored.
 */
export function makeOperatorInput(d: OperatorInputDeps): (raw: string) => void {
  return (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const id = d.target();
    if (id === null) return;
    d.say(id, text).then(
      () => (d.sent ? d.sent(id) : d.note(d.paint("dim", `» sent to ${id}`))),
      (e: Error) => {
        if (d.workerKnown(id)) d.resume(text, id);
        else d.note(d.paint("red", `» ${e.message}`));
      }
    );
  };
}

/** What followWorkers writes to (process.stdout, or a fake in tests). */
export interface FollowStream {
  write(s: string): boolean;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  on?(event: "resize", fn: () => void): unknown;
  removeListener?(event: "resize", fn: () => void): unknown;
}

/** The child of a `pai worker resume` spawn (tests inject a fake). */
export interface ResumeChild {
  stdout?: { on(event: "data", cb: (chunk: Buffer) => void): unknown };
  on(event: "close", cb: (code: number | null) => void): unknown;
}

/** Test seams for followWorkers: the streams, the resume spawn, the prompt. */
export interface FollowIO {
  stdin?: NodeJS.ReadableStream;
  stdout?: FollowStream;
  /** replaces the `pai worker resume` spawn (tests record instead of run). */
  spawnResume?: (id: string, text: string) => ResumeChild;
  /** current unsent prompt text (tests force a draft to hold the countdown). */
  promptLine?: () => string;
}

/**
 * Tail one worker (target) or the running workers of this scope, live.
 * Workers whose event log already exists are first replayed (last
 * BACKFILL_EVENTS events), then tailed. Auto-exit: with a target, wait
 * `autoExit` seconds after its end; without one, exit once no worker in
 * scope has run for that many seconds in a row, never within the first 30 s.
 *
 * With a target on a TTY the pane becomes a chat (chatui.ts): transcript in
 * a scroll region, fixed prompt and ticker rows, submitted lines said to the
 * worker (or resuming it after it finished) and echoed as `»` rows. A draft
 * in the prompt holds the auto-exit countdown. Non-TTY output keeps the
 * plain scrolling behaviour; FORCE_TTY=1 emits the chat layout over a pipe.
 */
export async function followWorkers(
  logDir: string,
  target: string | null,
  showAll: boolean,
  autoExit: number,
  env: NodeJS.ProcessEnv = process.env,
  color = process.stdout.isTTY === true,
  io?: FollowIO
): Promise<void> {
  const c = makeColor(color);
  const out_ = io?.stdout ?? process.stdout;
  const in_ = io?.stdin ?? process.stdin;
  // FORCE_TTY=1: the TTY layout over a pipe (tests, recorded panes)
  const tty = out_.isTTY === true || env.FORCE_TTY === "1";
  const term = env.ITERM_SESSION_ID ?? "";
  const scopeTab = target || showAll ? "" : currentTabKey(env);
  const handles = new Map<string, FollowHandle>();
  const seenHeader = new Set<string>();
  const finished = new Set<string>();
  // handoffs already rendered per worker (id → inbox lines shown so far)
  const inboxSeen = new Map<string, number>();
  const states = new Map<string, FollowState>();
  const started = Date.now();
  let idleSince: number | null = null;
  let aborted = false;
  // liveness state: rewritten in place between events, TTY only
  let lastEventAt = Date.now();
  let meterStatus: WorkerStatus | null = null;
  // the pane's bottom line (chat mode): the target's current status, kept
  // fresh every loop tick (not only on a new event) so a `pai worker goal`
  // relabel shows up on the pane's next refresh, not its next tool call
  let paneStatus: WorkerStatus | undefined;
  const onInt = () => {
    aborted = true;
  };
  process.once("SIGINT", onInt);

  // --- the chat layout (target + TTY): transcript region, a blank separator
  // row, then the two fixed rows (prompt, ticker)
  const chat = tty && target !== null;
  let rows = out_.rows ?? 24;
  const columns = (): number | null => (typeof out_.columns === "number" ? out_.columns : null);
  let fill = 0; // transcript rows filled since the region was (re)set
  const regionRows = () => Math.max(1, rows - 3);
  // the rendered transcript, kept so a resize can replay it onto the cleared
  // pane (chat mode only; capped so a long run cannot grow without bound)
  const retained: string[] = [];
  const RETAIN_CAP = 500;
  /** Every line the pane shows goes through here: plain newline, or a row
   *  inserted above the fixed prompt/ticker rows (chatui.chatInsertLine). */
  const out = (line: string, keep = true) => {
    if (!chat) {
      out_.write(line + "\n");
      return;
    }
    if (keep) {
      retained.push(line);
      if (retained.length > RETAIN_CAP) retained.splice(0, retained.length - RETAIN_CAP);
    }
    const r = chatInsertLine(line, fill, regionRows());
    out_.write(r.seq);
    fill = r.fill;
  };

  // The ticker redraws its line in place: in the chat layout that is its own
  // bottom row (save-cursor, draw, restore-cursor); the plain mode writes
  // CR + erase-to-end-of-line, never a newline. The control bytes live in
  // their own string literals — bundling them onto a template literal makes
  // the bundler fold them in as raw chars, and a raw CR inside a template
  // literal is normalised to LF by the language, which is how the ticker
  // once scrolled a blank line per tick.
  const eraseLiveness = () => {
    if (chat) return;
    if (tty) out_.write("\r\x1b[K");
  };
  let ticker = initialFollowState();
  // the chat ticker row doubles as the worker's status line: provider/model,
  // context meter, turns, tools, runtime — frozen with ✓/✗ once it finished
  const statusRowOf = (st: WorkerStatus, secs: number): StatusRow => {
    const fin = finished.has(st.id);
    const startedAt = Date.parse((st.started ?? "").replace(" ", "T"));
    const elapsed =
      fin && st.secs !== null
        ? st.secs
        : Number.isNaN(startedAt)
          ? 0
          : Math.floor((Date.now() - startedAt) / 1000);
    return {
      provider: st.provider,
      model: st.model,
      contextTokens: st.contextTokens,
      contextWindow: st.contextWindow,
      turns: st.turns,
      tools: st.tools,
      elapsed,
      idle: secs,
      intent: ticker.intent,
      tool: ticker.tool,
      state: fin ? (st.state === "running" ? "done" : st.state) : null,
    };
  };
  const writeLiveness = () => {
    if (!tty) return;
    const secs = Math.max(0, Math.floor((Date.now() - lastEventAt) / 1000));
    if (chat) {
      // the pane's bottom line: goal · model · started · age, never the tool
      // call this second (see paneStatusRow) — before the first status file
      // exists there is nothing to show it from yet, so the plain ticker
      // covers that brief startup window only
      const text = paneStatus
        ? paneStatusRow(paneStatus, new Date(), columns())
        : tickerText(secs, ticker.intent, ticker.tool);
      out_.write(chatTickerRow(text, rows, promptCursorCol()));
    } else {
      const meter = meterStatus ? contextMeter(c, meterStatus) : null;
      out_.write("\r\x1b[K");
      out_.write(tickerText(secs, ticker.intent, ticker.tool, meter));
    }
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

  // --- one rendered event, shared by the backfill and the live tail
  const emitEvent = (e: StreamEventLike, wid: string, st: WorkerStatus, multi: boolean) => {
    if (e.type === "operator" && chat && suppressMirror(String(e.text ?? ""))) return;
    if (!seenHeader.has(wid)) {
      eraseLiveness();
      out(headerLine(c, st));
      seenHeader.add(wid);
    }
    const state = states.get(wid) ?? initialFollowState();
    const step = applyEvent(
      c,
      state,
      e,
      st.cwd ?? "",
      multi ? c("cyan", wid.slice(-4)) : undefined,
      undefined,
      columns()
    );
    if (step.day) {
      out(c("dim", `── ${step.day} ──`));
    }
    states.set(wid, step.state);
    if (wid === target) ticker = step.state;
    eraseLiveness();
    for (const ln of step.lines) {
      out(ln);
    }
    if (step.activity) lastEventAt = Date.now();
    if (e.type === "result") {
      meterStatus = st;
      finished.add(wid);
    } else if (wid === target || target === null) {
      meterStatus = st;
    }
  };

  // --- attach: replay what is already in the log, then tail from its end
  const attachHandle = (wid: string, path: string, st: WorkerStatus, multi: boolean): FollowHandle => {
    const handle = { fd: openSync(path, "r"), buf: "" };
    try {
      const existing = readFileSync(path, "utf8");
      if (existing.trim()) {
        for (const line of backfillLines(existing)) {
          let e: StreamEventLike;
          try {
            e = JSON.parse(line) as StreamEventLike;
          } catch {
            continue;
          }
          emitEvent(e, wid, st, multi);
        }
      } else {
        // no event yet: show the header now, not at the first event
        if (!seenHeader.has(wid)) {
          out(headerLine(c, st));
          seenHeader.add(wid);
        }
      }
      // the backfill already rendered the file; the live tail starts at EOF
      const sink = Buffer.alloc(65536);
      for (;;) {
        let n: number;
        try {
          n = readSync(handle.fd, sink, 0, sink.length, null);
        } catch {
          break;
        }
        if (n <= 0) break;
      }
    } catch {
      // unreadable log: tail from wherever the fd happens to be
    }
    return handle;
  };

  // --- say / resume from this pane's stdin
  const noteLine = (s: string) => {
    eraseLiveness();
    out(s);
  };
  // SpawnOptions (not the stdio-tuple overload): we only read stdout and
  // want the plain ChildProcess shape; tests inject a fake that records
  const spawnResume =
    io?.spawnResume ??
    ((id: string, text: string): ResumeChild =>
      spawn("pai", ["worker", "resume", id, text, "--print-id", "--no-pane"], {
        stdio: ["ignore", "pipe", "inherit"],
      } as SpawnOptions) as unknown as ResumeChild);
  const resumeTarget = (text: string, id: string) => {
    noteLine(c("dim", `» resuming ${id} …`));
    const child = spawnResume(id, text);
    let idOut = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      idOut += chunk.toString("utf8");
    });
    child.on("close", (rc: number | null) => {
      const newId = idOut.trim().split("\n").pop() ?? "";
      if (rc === 0 && /^\d{8}-\d{6}-\d+$/.test(newId)) {
        noteLine(c("dim", `» resumed as ${newId}`));
        target = newId;
        finished.delete(newId);
        seenHeader.delete(newId);
        states.delete(newId);
        ticker = initialFollowState("resumed");
        lastEventAt = Date.now();
      } else {
        noteLine(c("red", `» resume failed (rc=${rc})`));
      }
    });
  };
  const handleOperatorLine = makeOperatorInput({
    target: () => target,
    say: (id, text) => sayToWorker(logDir, id, text),
    workerKnown: (id) => loadStatuses(logDir).some((s) => s.id === id),
    resume: resumeTarget,
    note: noteLine,
    paint: c,
    ...(chat ? { sent: () => undefined } : {}), // the echo replaces the note
  });

  // --- the chat line: readline editing on the prompt row
  // the readline interface keeps stdin flowing — without a close, the process
  // outlives follow itself (a pane then never closes, however long ago the
  // worker ended), so it is closed in the finally block below
  const terminalIn = (in_ as { isTTY?: boolean }).isTTY === true;
  let rlIn: ReturnType<typeof createInterface> | null = null;
  let onResize: (() => void) | null = null;
  // an echoed line comes back as a mirrored operator event within moments —
  // remember what was echoed and swallow the twin, so the pane shows what
  // was typed exactly once
  const echoed = new Map<string, { n: number; until: number }>();
  const suppressMirror = (text: string): boolean => {
    const g = echoed.get(text);
    if (!g || Date.now() > g.until) return false;
    g.n -= 1;
    if (g.n <= 0) echoed.delete(text);
    return true;
  };
  /** Column the prompt row's cursor parks at: right after the draft's cursor. */
  const promptCursorCol = (): number => {
    const line = rlIn?.line ?? "";
    const cur = (rlIn as unknown as { cursor?: number } | null)?.cursor;
    return 3 + Math.max(0, Math.min(typeof cur === "number" ? cur : line.length, line.length));
  };
  /**
   * The pane owns the prompt row's rendering: `› `, the buffer — or the dim
   * placeholder while the buffer is empty — and the cursor parked after it.
   */
  const drawPrompt = () => {
    if (!chat) return;
    const line = rlIn?.line ?? "";
    const cur = (rlIn as unknown as { cursor?: number } | null)?.cursor;
    out_.write(chatPromptRow(rows, line, (s) => c("dim", s), cur));
  };
  if (chat) {
    const echoOperator = (text: string) => {
      const id = target;
      if (id === null) return;
      echoed.set(text, { n: 1, until: Date.now() + 10_000 });
      const st = states.get(id) ?? initialFollowState();
      const step = applyEvent(
        c,
        st,
        { type: "operator", _ts: new Date().toISOString(), text },
        "",
        undefined,
        undefined,
        columns()
      );
      if (step.day) out(c("dim", `── ${step.day} ──`));
      for (const ln of step.lines) out(ln);
      states.set(id, step.state);
    };
    const handleChatLine = (raw: string) => {
      const act = parseChatLine(raw);
      let redrew = false;
      switch (act.kind) {
        case "message":
          if (!act.text) break;
          handleOperatorLine(act.text); // send the line …
          drawPrompt(); // … placeholder back before the » echo is written
          redrew = true;
          echoOperator(act.text);
          break;
        case "resume":
          if (!act.text) {
            out(c("dim", "usage: /resume <text>"));
            break;
          }
          if (target !== null) resumeTarget(act.text, target);
          drawPrompt();
          redrew = true;
          echoOperator(act.text);
          break;
        case "help":
          for (const ln of CHAT_HELP) out(c("dim", ln));
          break;
        case "status": {
          const s =
            target !== null ? loadStatuses(logDir).find((x) => x.id === target) : undefined;
          out(c("dim", s ? `${s.id} · ${s.state} · ${s.last}` : `${target ?? "?"} · no status`));
          break;
        }
        case "quit":
          aborted = true;
          break;
      }
      if (!redrew) drawPrompt(); // on a pipe readline does not repaint the row
    };
    // readline edits silently (its output is a mute stream); the pane draws
    // the prompt row itself from the live buffer, so the placeholder yields
    // to the first keystroke and returns when the buffer empties again.
    // The emitter no-ops matter: with terminal:true readline attaches a
    // resize listener on its output, and a bare { write } object crashes
    // follow in a real terminal ("output.on is not a function").
    const silent = {
      write: () => true,
      on: () => silent,
      once: () => silent,
      off: () => silent,
      removeListener: () => silent,
      emit: () => false,
    } as unknown as NodeJS.WriteStream;
    rlIn = createInterface({ input: in_, output: silent, terminal: terminalIn });
    rlIn.on("line", handleChatLine);
    // Ctrl-C: an empty prompt leaves, a draft clears; Ctrl-D (close) leaves
    rlIn.on("SIGINT", () => {
      if ((rlIn?.line ?? "").trim() === "") aborted = true;
      else {
        rlIn?.write(null, { ctrl: true, name: "u" });
        drawPrompt();
      }
    });
    rlIn.on("close", () => {
      aborted = true;
    });
    // the separator rule above the prompt row needs the pane's width and the
    // pane's dim colour — chatEnter without cols leaves the row blank
    out_.write(chatEnter(rows, columns() ?? 0, (s) => c("dim", s)));
    drawPrompt();
    if (terminalIn) {
      // every keystroke re-renders the row (and re-parks the cursor) from
      // the buffer readline now holds
      (in_ as NodeJS.ReadableStream).on("keypress", () => drawPrompt());
    }
    // resize: re-read the geometry, rebuild the region, fill it afresh
    onResize = () => {
      if (typeof out_.rows === "number") rows = out_.rows;
      fill = 0;
      // clear first: the refill lands rows top-down and must not overwrite
      // the stale transcript left under the old geometry
      out_.write(
        "\x1b[2J" + chatScrollRegion(rows) + chatBlankRow(rows, columns() ?? 0, (s) => c("dim", s))
      );
      // the retained transcript replays in order, newest regionRows() lines
      // only - a shrunken pane shows its newest rows, not a scroll replay
      for (const ln of retained.slice(-regionRows())) out(ln, false);
      drawPrompt();
    };
    out_.on?.("resize", onResize);
  } else if (target !== null && (in_ as { isTTY?: boolean }).isTTY) {
    // plain operator channel: TTY stdin, non-TTY stdout
    rlIn = createInterface({ input: in_ });
    rlIn.on("line", handleOperatorLine);
  }

  /** The prompt's unsent text — a draft holds the auto-exit countdown. */
  const promptText = () => (io?.promptLine ? io.promptLine() : (rlIn?.line ?? ""));

  try {
    for (;;) {
      if (aborted) return;
      const statuses = new Map(loadStatuses(logDir).map((s) => [s.id, s]));
      if (target) paneStatus = statuses.get(target) ?? paneStatus;
      const wanted = target ? [target] : runningIds();
      for (const wid of wanted) {
        if (handles.has(wid) || finished.has(wid)) continue;
        const path = eventsPath(logDir, wid);
        const st = statuses.get(wid) ?? ({ id: wid, label: "", cwd: "", provider: "" } as WorkerStatus);
        if (existsSync(path)) {
          const multi = target === null || handles.size > 0;
          handles.set(wid, attachHandle(wid, path, st, multi));
          states.set(wid, states.get(wid) ?? initialFollowState());
        } else if (!seenHeader.has(wid)) {
          // worker just started, no event yet: name it instead of a blank pane
          out(headerLine(c, st));
          seenHeader.add(wid);
        }
      }
      const multi = handles.size > 1 || target === null;
      let progressed = false;

      for (const [wid, h] of [...handles.entries()]) {
        const st = statuses.get(wid) ?? ({ id: wid, label: "", cwd: "", provider: "" } as WorkerStatus);
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
          if (!line.trim()) continue;
          progressed = true;
          let e: StreamEventLike;
          try {
            e = JSON.parse(line) as StreamEventLike;
          } catch {
            continue;
          }
          emitEvent(e, wid, st, multi);
        }
        const ended = workerEnded(finished.has(wid), st.state, alive(st.pid));
        if (ended) {
          if (!finished.has(wid)) {
            eraseLiveness();
            out(
              `${multi ? c("cyan", wid.slice(-4)) + c("dim", " ┃ ") : "  "}${c("red", "✗ " + (st.state || "ended"))} · ${st.last ?? ""}`
            );
            finished.add(wid);
          }
          closeSync(h.fd);
          handles.delete(wid);
        }
      }

      // inbox tail: new handoffs render as ◆ lines in the recipient's pane
      // (they may also arrive via the say mirror — the durable copy is here)
      for (const wid of [...handles.keys()]) {
        const st = statuses.get(wid) ?? ({ id: wid, label: "", cwd: "", provider: "" } as WorkerStatus);
        const msgs = readInbox(logDir, wid);
        const seenN = inboxSeen.get(wid) ?? 0;
        if (msgs.length > seenN) {
          for (const m of msgs.slice(seenN)) {
            emitEvent(
              { type: "handoff", from: m.from, kind: m.kind, text: m.text, _ts: m._ts },
              wid,
              st,
              multi
            );
          }
          inboxSeen.set(wid, msgs.length);
          progressed = true;
        }
      }

      const lingerOn = target; // resume swaps `target` under us (see above)
      if (lingerOn !== null && finished.has(lingerOn)) {
        if (autoExit) {
          // a draft in the prompt holds the countdown: the operator may be
          // about to say or resume something
          if (holdAutoExit(promptText())) {
            writeLiveness();
            await sleep(250);
            continue;
          }
          const until = Date.now() + autoExit * 1000;
          while (
            Date.now() < until &&
            !aborted &&
            target === lingerOn &&
            !holdAutoExit(promptText())
          ) {
            writeLiveness();
            await sleep(250);
          }
          // interrupted, resumed inside the window, or a draft appeared: follow on
          if (aborted || target !== lingerOn || holdAutoExit(promptText())) continue;
          eraseLiveness();
          out(c("dim", "closing"));
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
          out(c("dim", "closing"));
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
    if (onResize) out_.removeListener?.("resize", onResize);
    if (chat) out_.write(chatLeave(rows));
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
  claudeSession: string = "",
  now: Date = new Date(),
  /** Live routing choice (workers.active) — the head of the line. */
  active: string | null = null
): string {
  const statuses = loadStatuses(logDir);
  const mine = statuses.filter((s) => {
    const sameScope = term && workerInScope(s, term);
    // orchestrator Bash spawns have no terminal identity; their spawner
    // session (the claude session rendering this bar) claims them instead
    const spawnedHere = claudeSession && s.spawnerSession === claudeSession;
    const sameDir = cwd && s.cwd.startsWith(cwd);
    return sameScope || spawnedHere || (!term && sameDir);
  });
  return renderStatusLine(mine, now, active);
}
