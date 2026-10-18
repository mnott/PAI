/**
 * render.ts — turn worker events into the lines a human reads.
 *
 * Ports the glm-ps transcript rendering: the gutter rules (dim `>` for reads
 * and searches, `$` for shell, magenta `~` + red/green diff for edits, green
 * `+` for writes), Read-result trimming (first 3 lines then a count), and the
 * result footer. Colors are applied only when the output is a TTY, so MCP
 * tool output stays plain text.
 */

import { deadlineLabel } from "./deadline.js";
import { relative, basename } from "node:path";
import { ANTHROPIC_NATIVE, NATIVE_ANTHROPIC_MODELS, getProviderOrNative, readWorkersSection, type WorkersConfig } from "./config.js";
import { shortText } from "./args.js";
import { denialMark, parseDenialText } from "./denials.js";
import { fmtElapsed, waitingLine, waitOnCallLine, waitOnResultLine, detachedLine, realWaitDeps } from "./waiting.js";
import { ageOf, elapsedOf, contextLabel, contextFooter,contextPercent, isChatPane, type WorkerStatus, isLive, UNLABELED } from "./status.js";
import { ownedTree } from "./worktree.js";
import { workerDepth } from "./tree.js";
import { sessionTag } from "./scope.js";
import { endLabel } from "./endreason.js";
import { parseWorkerReport, renderReport } from "./report.js";

export type ColorEnabled = boolean;

const CODES = {
  dim: "2",
  bold: "1",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  mag: "35",
  cyan: "36",
} as const;

export type ColorName = keyof typeof CODES;

export function makeColor(enabled: ColorEnabled) {
  return (name: ColorName, s: string): string =>
    enabled ? `\x1b[${CODES[name]}m${s}\x1b[0m` : s;
}

export type Paint = ReturnType<typeof makeColor>;

/** Path relative to cwd when it lies inside it, otherwise unchanged. */
export function relPath(path: string, cwd: string): string {
  if (!path || !cwd) return path;
  let r: string;
  try {
    r = relative(cwd, path);
  } catch {
    return path;
  }
  return r.startsWith("..") ? path : r;
}

/** Minimal line diff for Edit previews: common prefix/suffix, one hunk. */
export function unifiedDiffLines(oldStr: string, newStr: string): string[] {
  const oldL = oldStr.split("\n");
  const newL = newStr.split("\n");
  let start = 0;
  while (start < oldL.length && start < newL.length && oldL[start] === newL[start]) start++;
  let endOld = oldL.length;
  let endNew = newL.length;
  while (endOld > start && endNew > start && oldL[endOld - 1] === newL[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const out: string[] = [];
  for (let i = start; i < endOld; i++) out.push("-" + oldL[i]);
  for (let i = start; i < endNew; i++) out.push("+" + newL[i]);
  return out;
}

export interface ToolUseBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  /** tool_result blocks only: the call this answers. */
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

export interface StreamEventLike {
  type?: string;
  subtype?: string;
  model?: string;
  cwd?: string;
  message?: { content?: ToolUseBlock[] };
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  /** ISO stamp the runner attaches to every mirrored event (2g). */
  _ts?: string;
  /** Operator text (type: "operator"). */
  text?: string;
  /** Operator mirror of a handoff delivery — shown only as the ◆ inbox line. */
  handoff?: boolean;
  /** Handoff fields (type: "handoff", from the inbox tail). */
  from?: string;
  kind?: string;
}

/**
 * `HH:MM:SS` at an offset east of UTC in minutes (Date.getTimezoneOffset()
 * negated), from any ISO stamp the runner wrote — `Z` or a local `+HH:MM`.
 * null when the stamp cannot be parsed. Offsets make this testable without
 * depending on the machine's zone; the default is this machine's.
 */
export function clockOf(ts: string, offMin = -new Date().getTimezoneOffset()): string | null {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return new Date(t + offMin * 60_000).toISOString().slice(11, 19);
}

/** `YYYY-MM-DD` at the same offset — the local day a date separator shows. */
export function dayOf(ts: string, offMin = -new Date().getTimezoneOffset()): string | null {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return new Date(t + offMin * 60_000).toISOString().slice(0, 10);
}

/** The gutter of one rendered event: its three shapes and its width. */
export interface Gutter {
  /** first row: `HH:MM:SS │ ` (dim). */
  first: string;
  /** later rows of one event, no wrapping: blanks of the same width. */
  cont: string;
  /** wrapped continuation rows: blank time, the `│` bar kept (dim). */
  barCont: string;
  /** printable columns first/cont/barCont occupy. */
  width: number;
}

/**
 * The transcript gutter (2g): `HH:MM:SS │ ` from the event's `_ts`, dim, with
 * the worker tag in front when several run at once. Continuation lines get
 * blanks of the same width so wrapped text stays aligned; when the viewer
 * wraps lines itself, continuation rows carry the `│` bar instead (barCont)
 * so the bar runs unbroken down the pane. null when the event carries no
 * stamp (logs from before 2g render with the plain prefix). The time is the
 * stamp's wall clock at `offMin` — the default renders local time, whatever
 * zone stamped the log (old logs were stamped in UTC).
 */
export function gutterFor(
  c: Paint,
  e: { _ts?: string },
  tag?: string,
  offMin?: number
): Gutter | null {
  if (!e._ts) return null;
  const time = clockOf(e._ts, offMin) ?? (e._ts.length >= 19 ? e._ts.slice(11, 19) : e._ts);
  const head = tag ? `${tag} ${time}` : time;
  const width = head.length + 3; // + " │ "
  return {
    first: c("dim", `${head} │ `),
    cont: " ".repeat(width),
    barCont: c("dim", `${" ".repeat(head.length)} │ `),
    width,
  };
}

/**
 * The ticker's tool part: `$ <command>` for Bash (first 60 chars), the file
 * basename for the file tools, the bare name for everything else.
 */
export function tickerTool(name: string, inp: unknown): string {
  const i = (typeof inp === "object" && inp !== null ? inp : {}) as Record<string, unknown>;
  const get = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  if (name === "Bash") return `$ ${shortText(get("command").replace(/\s+/g, " ").trim(), 60)}`;
  if (name === "Read" || name === "Edit" || name === "Write" || name === "MultiEdit") {
    const base = get("file_path").split("/").pop() ?? "";
    return base || name;
  }
  return name;
}

/**
 * The liveness line: `⋯ 12s · run tests before the fix · $ bun run test` —
 * seconds since the last *rendered* event, the worker's last stated intent
 * (its last assistant text, ≤60 chars) and the tool it is currently running.
 * Parts that are empty drop out.
 */
export function tickerText(secs: number, intent: string, tool: string, meter?: string | null): string {
  const head = `⋯ ${secs}s`;
  const parts = [intent, tool].map((p) => p.trim()).filter(Boolean);
  const tail = parts.join(" · ");
  const line = tail ? `${head} · ${tail}` : head;
  return meter ? `${line} · ${meter}` : line;
}

/** What the chat pane's status row shows (chatStatusRow formats it). */
export interface StatusRow {
  provider: string;
  model: string;
  contextTokens?: number | null;
  contextWindow?: number | null;
  turns: number;
  tools: number;
  /** runtime so far in seconds; the finished row freezes its final value. */
  elapsed: number;
  /** seconds since the last rendered event (running only). */
  idle?: number;
  intent?: string;
  tool?: string;
  /** a finished state freezes the row with ✓/✗ instead of the ticker part. */
  state?: string | null;
  /** set while the run waits in the stagger gate for a cache warm-up. */
  warmup?: { elapsedSec: number; limitSec: number } | null;
}

export { fmtElapsed };

/**
 * The chat pane's status row (always visible while following):
 * `[glm/glm-5.3] ctx 84k/200k (42%) · turns 12 · tools 7 · 4m12s · ⋯ 7s · <intent> · <tool>`
 * — context yellow past 70 %, red past 85 %, dropped when unknown; once the
 * worker finished, the ticker part is replaced by `✓ done` / `✗ failed`.
 */
export function chatStatusRow(c: Paint, s: StatusRow): string {
  const parts: string[] = [];
  const pct = contextPercent(s);
  if (pct !== null) {
    const label = contextLabel(s);
    parts.push(pct > 85 ? c("red", label) : pct > 70 ? c("yellow", label) : label);
  }
  parts.push(`turns ${s.turns}`, `tools ${s.tools}`, fmtElapsed(s.elapsed));
  if (s.state && s.state !== "running") {
    parts.push(s.state === "done" ? c("green", "✓ done") : c("red", "✗ failed"));
  } else if (s.warmup) {
    parts.push(warmupText(s.warmup) as string);
  } else {
    parts.push(`⋯ ${Math.max(0, Math.floor(s.idle ?? 0))}s`);
    for (const p of [s.intent, s.tool]) if (p && p.trim()) parts.push(p.trim());
  }
  const model = shortModel(s.model);
  return `[${s.provider}${model ? "/" + model : ""}] ${parts.join(" · ")}`;
}

/**
 * One blank line between turns, none inside one: a blank goes before an
 * assistant message that follows a tool result or an operator message (the
 * worker starting to speak again after its tools were answered / it was told
 * something), not between the text, tool calls and results of one turn.
 */
export function blankBetween(prev: { type?: string } | null, e: { type?: string }): boolean {
  if (!prev) return false;
  if (e.type !== "assistant") return false;
  return prev.type === "user" || prev.type === "operator" || prev.type === "handoff";
}

/** The worker's last stated intent: the first line of its last text, ≤60. */
export function intentOf(text: string): string {
  const first = text.trim().split("\n").find((l) => l.trim()) ?? "";
  return shortText(first.trim().replace(/\s+/g, " "), 60);
}

/**
 * The context meter `ctx 84k/200k (42%)` (contextLabel, shared with the
 * chat status row), yellow from 70 %, red from 85 %. null when the numbers
 * are missing or below `minPct` (the table only shows it past 60; the pane
 * liveness line always shows it).
 */
export function contextMeter(
  c: Paint,
  s: Pick<WorkerStatus, "contextTokens" | "contextWindow">,
  minPct = 0
): string | null {
  const pct = contextPercent(s);
  if (pct === null || pct <= minPct) return null;
  const label = contextLabel(s);
  if (pct > 85) return c("red", label);
  if (pct > 70) return c("yellow", label);
  return label;
}

function renderToolUse(
  c: Paint,
  prefix: string,
  name: string,
  inp: unknown,
  cwd: string
): string[] {
  const i = (typeof inp === "object" && inp !== null ? inp : {}) as Record<string, unknown>;
  const get = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  if (name === "Read") {
    return [`${prefix}${c("dim", ">")} Reading ${relPath(get("file_path"), cwd)}`];
  }
  if (name === "Grep" || name === "Glob") {
    return [
      `${prefix}${c("dim", ">")} Searching ${c("cyan", get("pattern"))} in ${relPath(get("path") || ".", cwd)}`,
    ];
  }
  if (name === "Bash") {
    // the job, not the mechanism: wait-on and detached starts read in plain words (raw command: `pai worker replay`)
    const plain = waitOnCallLine(get("command")) ?? detachedLine(get("command"));
    if (plain) return [`${prefix}${c("yellow", plain)}`];
    return [`${prefix}${c("dim", "$")} ${shortText(get("command"), 160)}`];
  }
  if (name === "Edit") {
    const out = [`${prefix}${c("mag", "~")} Editing ${relPath(get("file_path"), cwd)}`];
    for (const line of unifiedDiffLines(get("old_string"), get("new_string"))) {
      if (line.startsWith("-")) out.push(`${prefix}    ${c("red", line)}`);
      else if (line.startsWith("+")) out.push(`${prefix}    ${c("green", line)}`);
      else out.push(`${prefix}    ${c("dim", line)}`);
    }
    return out;
  }
  if (name === "Write") {
    const n = get("content").split("\n").length;
    return [`${prefix}${c("green", "+")} Writing ${relPath(get("file_path"), cwd)} (${n} lines)`];
  }
  if (name === "WebSearch" || name === "WebFetch") {
    return [`${prefix}${c("dim", ">")} ${name} ${shortText(get("query") || get("url"), 100)}`];
  }
  return [`${prefix}${c("dim", ">")} ${name} ${shortText(JSON.stringify(i), 120)}`];
}

/** Render one stream-json event; `tools` maps tool_use_id → tool name. */
export function renderEvent(
  c: Paint,
  prefix: string,
  e: StreamEventLike,
  cwd: string,
  tools: Record<string, string>,
  gutter?: { first: string; cont: string } | null
): string[] {
  const out: string[] = [];
  if (e.type === "system" && e.subtype === "init") {
    out.push(
      `${prefix}${c("dim", `worker started · model ${e.model ?? "?"} · cwd ${basename(e.cwd || cwd || "")}`)}`
    );
  } else if (e.type === "operator") {
    // a handoff delivery is said to the worker AND tailed from the inbox —
    // the transcript shows only the ◆ line, its mirror renders nothing
    if (e.handoff) return out;
    // split per line so the gutter continuation pads wrapped text
    for (const ln of String(e.text ?? "").split("\n")) {
      out.push(`${prefix}${c("cyan", "» " + ln)}`);
    }
  } else if (e.type === "handoff") {
    // a child's message from the inbox: ◆ from <id> · <kind>: <text>
    for (const ln of String(e.text ?? "").split("\n")) {
      out.push(`${prefix}${c("mag", `◆ from ${e.from ?? "?"} · ${e.kind ?? "?"}: ${ln}`)}`);
    }
  } else if (e.type === "assistant") {
    for (const b of e.message?.content ?? []) {
      if (b.type === "text" && (b.text ?? "").trim()) {
        for (const ln of (b.text ?? "").trim().split("\n")) out.push(`${prefix}${ln}`);
      } else if (b.type === "tool_use") {
        out.push(...renderToolUse(c, prefix, b.name ?? "?", b.input, cwd));
      }
    }
  } else if (e.type === "user") {
    for (const b of e.message?.content ?? []) {
      if (b.type !== "tool_result") continue;
      let content: unknown = (b as { content?: unknown }).content ?? "";
      if (Array.isArray(content)) {
        content = content
          .map((x) => (typeof x === "object" && x !== null && "text" in x ? String((x as { text?: string }).text ?? "") : ""))
          .join("\n");
      }
      const text = String(content);
      const isError = (b as { is_error?: boolean }).is_error === true;
      const waited = !isError && tools[(b as { tool_use_id?: string }).tool_use_id ?? ""] === "Bash:wait-on" ? waitOnResultLine(text) : null;
      if (waited) {
        out.push(`${prefix}${c("yellow", waited)}`);
      } else if (!isError && tools[(b as { tool_use_id?: string }).tool_use_id ?? ""] === "Read") {
        // keep Read results as the tool returned them (`<lineno>\t<code>`),
        // only their count is summarised
        const lines = text.split("\n");
        for (const ln of lines.slice(0, 3)) out.push(`${prefix}${c("dim", ln)}`);
        if (lines.length > 3) {
          out.push(`${prefix}${c("dim", `    … ${lines.length} lines`)}`);
        }
      } else if (isError) {
        // guard/hook denials are expected friction (amber); other errors are real (red)
        const denied = parseDenialText(text) !== null || / blocked:/.test(text);
        out.push(`${prefix}    ${c(denied ? "yellow" : "red", "! " + shortText(text, 200))}`);
      } else if (text.trim()) {
        out.push(`${prefix}    ${c("dim", shortText(text, 120))}`);
      }
    }
  } else if (e.type === "result") {
    const ok = !e.is_error;
    const mark = ok ? c("green", "✓ done") : c("red", "✗ failed");
    out.push(`${prefix}${mark} · ${e.num_turns ?? "?"} turns · ${Math.floor((e.duration_ms ?? 0) / 1000)}s`);
    // a contract-compliant final message renders as the compact report block
    const report = parseWorkerReport(String(e.result ?? ""));
    if (report) {
      out.push(...renderReport(c, prefix, report, cwd));
    } else {
      for (const ln of String(e.result ?? "").trim().split("\n")) {
        out.push(`${prefix}  ${ln}`);
      }
    }
  }
  if (!gutter) return out;
  return out.map((ln, i) => (i === 0 ? gutter.first : gutter.cont) + ln);
}

/** Transcript header: id, provider, label, session name, project dir. */
export function headerLine(
  c: Paint,
  s: {
    id: string;
    label: string;
    cwd: string;
    provider?: string;
    session?: { name?: string } | null;
    spec?: string | null;
    reportFormat?: "json" | "ag2";
    reportValid?: boolean;
    reportErrors?: string[];
    endReason?: string;
    endBy?: string;
  }
): string {
  const bits = [s.provider ? `[${s.provider}]` : "", sessionTag(s)].filter(Boolean).join(" ");
  const sep = bits ? `  ${bits}` : "";
  const specBit = s.spec ? `  spec: ${s.spec}` : "";
  // R! an AG2 report that failed `aibroker agentish check`; R? either the
  // validator couldn't confirm it or a claimed changed path failed
  // verification against the filesystem (see reportVerify in run.ts)
  const reportBit =
    s.reportValid === false
      ? "  " + c("red", s.reportFormat === "ag2" && (s.reportErrors ?? []).length ? "R!" : "R?")
      : "";
  const why = endLabel(s);
  const endBit = why ? `  ended: ${why}` : "";
  return c("bold", `━━ ${s.id}${sep}  ${s.label}  (${basename(s.cwd)})${specBit}${reportBit}${endBit}`);
}

/** The chain label behind a stage label: strip the trailing " · <stage>". */
function chainLabelOf(stages: WorkerStatus[]): string {
  const first = stages[0];
  if (!first) return "";
  const suffix = first.stage ? ` · ${first.stage}` : "";
  return first.label.endsWith(suffix) && suffix
    ? first.label.slice(0, first.label.length - suffix.length)
    : first.label;
}

/**
 * The ps table (RUNNING + FINISHED last 8) as a forest: a worker whose parent
 * is another worker renders indented under it (`├`/`└` connectors); a parent
 * that is not a worker is a chain id and gets its old `chain <id>` header.
 * `⎇` marks an unmerged worktree branch, `◆N` an inbox with N handoffs.
 */
export function renderTable(
  c: Paint,
  statuses: WorkerStatus[],
  scopeLabel: string,
  now: Date = new Date(),
  inbox: Record<string, number> = {},
  workers: Pick<WorkersConfig, "providers" | "nativeModels"> = safeWorkers()
): string {
  const provTag = (s: WorkerStatus) => providerTag(s, workers);
  const running: WorkerStatus[] = [];
  const done: WorkerStatus[] = [];
  for (const s of statuses) {
    if (isLive(s)) running.push(s);
    else {
      if (s.state === "running") s.state = "lost";
      done.push(s);
    }
  }
  const isWorker = (id: string): boolean => statuses.some((s) => s.id === id);
  // a chain id (no status file) groups its stages under a header instead
  const chainOf = (s: WorkerStatus): string | null => (s.parent && !isWorker(s.parent) ? s.parent : null);
  const treeLine = (line: string, chain: string | null, last: boolean): string => {
    if (chain === null) return line;
    const mark = last ? "└" : "├";
    const bar = last ? " " : "│";
    return line.startsWith("      ")
      ? `  ${bar}   ${line.slice(6)}`
      : `  ${mark} ${line.slice(2)}`;
  };
  // sub-workers: one connector level per depth under their worker parent
  const rowPrefix = (depth: number, last: boolean): string =>
    depth <= 0 ? "  " : "  " + "│ ".repeat(depth - 1) + (last ? "└ " : "├ ");
  const rowCont = (depth: number, last: boolean): string =>
    depth <= 0 ? "      " : "  " + "│ ".repeat(depth - 1) + (last ? "  " : "│ ");
  const branchMark = (s: WorkerStatus): string =>
    s.branch && !s.merged ? "  " + c("yellow", "⎇" + (s.commits ? String(s.commits) : "")) : "";
  // tree path relative to the worktrees dir, and the resume chain links
  const treeMark = (s: WorkerStatus): string => {
    const t = ownedTree(s);
    const parts = [
      ...(t ? [`tree ${basename(t.dir)}`] : []),
      ...(s.pool?.slot ? [`slot ${basename(s.pool.slot)} #${s.pool.task}${s.pool.warm ? ` ${s.pool.warm}` : ""}`] : []),
      ...(s.resumedFrom ? [`resumed from ${s.resumedFrom}`] : []),
      ...(s.resumedBy ? [`resumed by ${s.resumedBy}`] : []),
      ...(s.route ? [`route ${s.route.reason}`] : []),
      ...(s.switchReason ? [s.switchReason] : []),
      ...(s.fallThroughOf ? [`fall-through of ${s.fallThroughOf}`] : []),
      ...(s.fallThroughTo ? [`fell through to ${s.fallThroughTo}`] : []),
    ];
    return parts.length ? "  " + c("dim", parts.join("  ")) : "";
  };
  const inboxMark = (s: WorkerStatus): string =>
    inbox[s.id] ? " " + c("mag", `◆${inbox[s.id]}`) : "";
  // "R!" an AG2 report that failed `aibroker agentish check`, "R?" either
  // the validator couldn't confirm it (missing/unreadable CLI) or a claimed
  // changed path failed verification against the filesystem — shown for
  // json reports too in the verify-failure case
  const reportMark = (s: WorkerStatus): string =>
    s.reportValid === false
      ? "  " + c("red", s.reportFormat === "ag2" && (s.reportErrors ?? []).length ? "R!" : "R?")
      : "";

  const deniedMark = (s: WorkerStatus): string => {
    const m = denialMark(s);
    return m ? "  " + c("red", m) : "";
  };
  const timeMark = (s: WorkerStatus): string => {
    const l = deadlineLabel(s, now.getTime());
    return l ? "  " + c(l === "timed out" || l.startsWith("OVERDUE") ? "red" : "dim", l) : "";
  };

  const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const lines: string[] = [c("bold", `Workers  ${clock}`), ""];
  lines.push(c("bold", `RUNNING (${running.length})`));
  if (!running.length) lines.push("  none");
  for (let i = 0; i < running.length; i++) {
    const s = running[i];
    const chain = chainOf(s);
    if (chain) {
      const prev = running[i - 1];
      if (!prev || chainOf(prev) !== chain) {
        const stages = running.filter((x) => chainOf(x) === chain);
        lines.push(`  ${c("bold", `chain ${chain}`)}  ${chainLabelOf(stages)}`);
      }
    }
    const last =
      !!chain && (i + 1 >= running.length || chainOf(running[i + 1]) !== chain);
    const depth = workerDepth(statuses, s.id);
    const subLast =
      !chain && (i + 1 >= running.length || running[i + 1].parent !== s.parent);
    const meter = contextMeter(c, s, 60);
    const p = chain ? "  " : rowPrefix(depth, subLast);
    const q = chain ? "      " : rowCont(depth, subLast);
    // owner session tag on running rows too: in the MACHINE section every row
    // must say whose worker it is (finished rows already carry it)
    const tag = sessionTag(s);
    lines.push(
      treeLine(
        `${p}${c("cyan", s.id)}${inboxMark(s)} ${provTag(s)}${tag ? " " + tag : ""}  ${ageOf(s.started, now).padStart(4)} old  turns ${String(s.turns).padStart(2)}  tools ${String(s.tools).padStart(2)}  ${basename(s.cwd)}${branchMark(s)}${treeMark(s)}${timeMark(s)}${deniedMark(s)}${meter ? "  " + meter : ""}`,
        chain,
        last
      )
    );
    lines.push(treeLine(`${q}task: ${s.label}`, chain, last));
    lines.push(
      treeLine(
        s.waitingOn
          ? `${q}${c("yellow", waitingLine(s.waitingOn, now.getTime()))}`
          : `${q}now:  ${c("yellow", s.last)}  (${ageOf(s.updated, now)} ago)`,
        chain,
        last
      )
    );
  }
  lines.push("");
  lines.push(c("bold", "FINISHED (last 8)"));
  const doneSlice = done.slice(-8);
  for (let i = 0; i < doneSlice.length; i++) {
    const s = doneSlice[i];
    const chain = chainOf(s);
    if (chain) {
      const prev = doneSlice[i - 1];
      if (!prev || chainOf(prev) !== chain) {
        const stages = doneSlice.filter((x) => chainOf(x) === chain);
        lines.push(`  ${c("bold", `chain ${chain}`)}  ${chainLabelOf(stages)}`);
      }
    }
    const last =
      !!chain && (i + 1 >= doneSlice.length || chainOf(doneSlice[i + 1]) !== chain);
    const depth = workerDepth(statuses, s.id);
    const subLast =
      !chain && (i + 1 >= doneSlice.length || doneSlice[i + 1].parent !== s.parent);
    const col = s.state === "done" ? "green" : s.state === "lost" ? "yellow" : "red";
    const tag = sessionTag(s);
    lines.push(
      treeLine(
        `${chain ? "  " : rowPrefix(depth, subLast)}${s.id}${inboxMark(s)} ${provTag(s)}${tag ? " " + tag : ""}  ${c(col, (s.state === "lost" ? "? lost" : s.state).padEnd(6))} rc=${s.rc}  ${String(s.secs ?? "?").padStart(4)}s  turns ${String(s.turns).padStart(2)}  tools ${String(s.tools).padStart(2)}  ${basename(s.cwd)}${branchMark(s)}${treeMark(s)}${timeMark(s)}${deniedMark(s)}${reportMark(s)}${endLabel(s) ? "  " + c("dim", `[${endLabel(s)}]`) : ""}  ${s.label}`,
        chain,
        last
      )
    );
  }
  lines.push("");
  lines.push(c("dim", "worker follow        live transcript of running workers"));
  lines.push(c("dim", "worker <id>          replay one worker"));
  lines.push(c("dim", scopeLabel));
  return lines.join("\n");
}

/**
 * The one place a model id is compacted for display, so every renderer
 * shortens identically: the vendor prefix goes (the provider column already
 * says who serves it), a release-date suffix goes, version segments read as
 * dots, and a `[1m]` window marker is kept because it changes what the run
 * costs. `claude-opus-5[1m]` → `opus-5[1m]`, `claude-haiku-4-5-20251001` →
 * `haiku-4.5`, `glm-5.3[1m]` and `k3[1m]` unchanged. Empty in, empty out.
 */
function safeWorkers(): Pick<WorkersConfig, "providers" | "nativeModels"> {
  try {
    return readWorkersSection().workers;
  } catch {
    return { providers: {}, nativeModels: NATIVE_ANTHROPIC_MODELS };
  }
}

/** `[provider]`, or `[provider/model]` when the served model is not the
 *  provider's default (e.g. the router picked another). */
export function providerTag(
  s: WorkerStatus,
  workers: Pick<WorkersConfig, "providers" | "nativeModels">
): string {
  const model = shortModel(s.model);
  const dflt = getProviderOrNative(workers, s.provider)?.models.default;
  if (!model || (dflt && shortModel(dflt) === model)) return `[${s.provider}]`;
  return `[${s.provider}/${model}]`;
}

export function shortModel(model: string | null | undefined): string {
  const raw = String(model ?? "").trim();
  if (!raw) return "";
  const wide = /\[1m\]$/i.test(raw);
  let id = wide ? raw.slice(0, -4) : raw;
  id = id.replace(/^(?:us\.|eu\.|apac\.)?(?:anthropic|claude|openai|google|models)[./-]/i, "");
  id = id.replace(/-\d{8}$/, "");
  // trailing numeric segments are one version: haiku-4-5 → haiku-4.5
  const parts = id.split("-");
  const nums: string[] = [];
  while (parts.length > 1 && /^\d+(?:\.\d+)*$/.test(parts[parts.length - 1])) {
    nums.unshift(parts.pop() as string);
  }
  if (nums.length) id = `${parts.join("-")}-${nums.join(".")}`;
  return wide ? `${id}[1m]` : id;
}

/** `waiting (warm-up) 7s/12s` for a run held in the stagger gate, else null. */
export function warmupText(w: { elapsedSec: number; limitSec: number } | null | undefined): string | null {
  return w ? `waiting (warm-up) ${Math.max(0, Math.floor(w.elapsedSec))}s/${Math.floor(w.limitSec)}s` : null;
}

/**
 * The goal of a statusline row: what the worker is FOR, never what it is doing
 * this second. The operator's `--label` is the goal and is preferred over
 * anything the model wrote; an unlabelled run's label already holds its prompt
 * (see run.ts), so the same path shortens that to its first sentence, cut on a
 * word boundary. A run with neither label nor prompt reads "unlabeled". Width
 * fitting goes through shortText, the repo's one truncation helper.
 */
export function goalOf(s: Pick<WorkerStatus, "label">, max = 40): string {
  const raw = String(s.label ?? "").trim();
  if (!raw || raw === "(no prompt)") return UNLABELED;
  const first = raw.split(/(?<=[.!?])\s+/)[0] ?? raw;
  if (first.length <= max) return shortText(first, max);
  const cut = first.slice(0, max - 1).replace(/\s+\S*$/, "");
  return shortText(`${cut || first.slice(0, max - 1)}…`, max);
}

/**
 * A worker pane's bottom line: `<goal> · <model> · started HH:MM · <age>` —
 * what the pane is FOR and how long it has run, never the tool call it
 * happens to be executing this second (that is `pai worker ps` / `follow`
 * territory). `columns`, when known, shrinks the goal so the fixed
 * `model · started · age` tail always survives — trimming that tail instead
 * would defeat the one thing an operator scanning several panes needs at a
 * glance. A legacy status with no recorded model omits that field rather
 * than rendering a bare gap.
 */
export function paneStatusRow(
  s: Pick<WorkerStatus, "label" | "model" | "started" | "contextUsed" | "contextWindow" | "waitingOn" | "denials" | "denialCount" | "warmup">,
  now: Date = new Date(),
  columns: number | null = null
): string {
  const model = [shortModel(s.model), contextFooter(s)].filter(Boolean).join(" · ");
  const started = String(s.started ?? "").slice(11, 16);
  const elapsed = elapsedOf(s.started, now);
  const tail = [model, started ? `started ${started}` : "", elapsed, denialMark(s)].filter(Boolean).join(" · ");
  const budget = columns !== null ? Math.max(1, columns - tail.length - 3) : 40;
  // a blocked worker's footer says what it waits on instead of its goal
  const head = warmupText(s.warmup) ?? (s.waitingOn ? waitingLine(s.waitingOn, now.getTime(), realWaitDeps, Math.max(10, budget - 30)) : goalOf(s, budget));
  return `${head} · ${tail}`;
}

/**
 * The statusline bar: `▶N (M nested) · <providers> · oldest <age>` and today's
 * ✓/✗ tail. `pai worker ps` has the full table and each pane its own bottom
 * line, so the bar only answers how many workers are running, on which
 * providers, and how long the oldest has been going. `▶N` counts every live
 * worker (the whole tree); `(M nested)` says how many of them were spawned by
 * another worker rather than by a session. `<providers>` lists the provider
 * names `pai worker providers` shows, most-populous first (ties by name), each
 * suffixed `×N` past one; native Anthropic runs show their short model name
 * (`sonnet-5.5`) since "anthropic" alone says nothing. No active-provider
 * head: it read as "workers run on glm" when none did, and the bar already
 * shows the session's provider elsewhere. `columns`, when known, shrinks only
 * the providers segment.
 */
export function renderStatusLine(
  mine: WorkerStatus[],
  now: Date = new Date(),
  columns: number | null = null
): string {
  // isChatPane carries the migration shim for pre-`origin` entries (see
  // status.ts): the chat pane is not a worker row and not counted in ▶N.
  const running = mine.filter((s) => !isChatPane(s) && isLive(s));
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const doneToday = mine.filter((s) => s.state !== "running" && s.started.startsWith(today));
  const ok = doneToday.filter((s) => s.state === "done").length;
  const bad = doneToday.length - ok;
  const tail = doneToday.length ? `   ✓${ok} ✗${bad} today` : "";
  if (!running.length) return tail.trim();

  // nested: spawned by another worker (its parent has a status file; a chain
  // id or a session is a root, as in tree.ts workerDepth)
  const ids = new Set(mine.map((s) => s.id));
  const nested = running.filter((s) => s.parent && ids.has(s.parent)).length;
  const head = `▶${running.length}${nested ? ` (${nested} nested)` : ""}`;

  const counts = new Map<string, number>();
  for (const s of running) {
    const name = s.provider === ANTHROPIC_NATIVE ? shortModel(s.model) || s.provider : s.provider || "?";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const providersFull = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([m, n]) => (n > 1 ? `${m} ×${n}` : m))
    .join(" · ");
  const oldest = running.reduce((a, b) => (a.started < b.started ? a : b));
  const oldestPart = `oldest ${ageOf(oldest.started, now)}`;

  let providers = providersFull;
  const fixedLen = head.length + 3 + oldestPart.length + tail.length; // + " · "
  if (columns !== null && fixedLen + 3 + providersFull.length > columns) {
    const budget = columns - fixedLen - 3;
    providers = budget > 0 ? shortText(providersFull, budget) : "";
  }
  const mid = [providers, oldestPart].filter(Boolean).join(" · ");
  return `${head} · ${mid}${tail}`;
}
