/**
 * render.ts — turn worker events into the lines a human reads.
 *
 * Ports the glm-ps transcript rendering: the gutter rules (dim `>` for reads
 * and searches, `$` for shell, magenta `~` + red/green diff for edits, green
 * `+` for writes), Read-result trimming (first 3 lines then a count), and the
 * result footer. Colors are applied only when the output is a TTY, so MCP
 * tool output stays plain text.
 */

import { relative, basename } from "node:path";
import { shortText } from "./args.js";
import { ageOf, contextPercent, type WorkerStatus, alive } from "./status.js";
import { sessionTag } from "./scope.js";
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

/**
 * One blank line between turns, none inside one: a blank goes before an
 * assistant message that follows a tool result or an operator message (the
 * worker starting to speak again after its tools were answered / it was told
 * something), not between the text, tool calls and results of one turn.
 */
export function blankBetween(prev: { type?: string } | null, e: { type?: string }): boolean {
  if (!prev) return false;
  if (e.type !== "assistant") return false;
  return prev.type === "user" || prev.type === "operator";
}

/** The worker's last stated intent: the first line of its last text, ≤60. */
export function intentOf(text: string): string {
  const first = text.trim().split("\n").find((l) => l.trim()) ?? "";
  return shortText(first.trim().replace(/\s+/g, " "), 60);
}

/** Compact token count: 84k, 200k, 900. */
function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * The context meter `ctx 84k/200k (42%)`, yellow from 70 %, red from 85 %.
 * null when the numbers are missing or below `minPct` (the table only shows
 * it past 60; the pane liveness line always shows it).
 */
export function contextMeter(
  c: Paint,
  s: Pick<WorkerStatus, "contextTokens" | "contextWindow">,
  minPct = 0
): string | null {
  const pct = contextPercent(s);
  if (pct === null || pct <= minPct) return null;
  const label = `ctx ${fmtK(s.contextTokens ?? 0)}/${fmtK(s.contextWindow ?? 0)} (${pct}%)`;
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
    // split per line so the gutter continuation pads wrapped text
    for (const ln of String(e.text ?? "").split("\n")) {
      out.push(`${prefix}${c("cyan", "» " + ln)}`);
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
      if (!isError && tools[(b as { tool_use_id?: string }).tool_use_id ?? ""] === "Read") {
        // keep Read results as the tool returned them (`<lineno>\t<code>`),
        // only their count is summarised
        const lines = text.split("\n");
        for (const ln of lines.slice(0, 3)) out.push(`${prefix}${c("dim", ln)}`);
        if (lines.length > 3) {
          out.push(`${prefix}${c("dim", `    … ${lines.length} lines`)}`);
        }
      } else if (isError) {
        out.push(`${prefix}    ${c("red", "! " + shortText(text, 200))}`);
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
  s: { id: string; label: string; cwd: string; provider?: string; session?: { name?: string } | null }
): string {
  const bits = [s.provider ? `[${s.provider}]` : "", sessionTag(s)].filter(Boolean).join(" ");
  const sep = bits ? `  ${bits}` : "";
  return c("bold", `━━ ${s.id}${sep}  ${s.label}  (${basename(s.cwd)})`);
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
 * The ps table (RUNNING + FINISHED last 8). Chain stages carry `parent` and
 * render as a tree under one `chain <id>` header; plain workers render as
 * before.
 */
export function renderTable(
  c: Paint,
  statuses: WorkerStatus[],
  scopeLabel: string,
  now: Date = new Date()
): string {
  const running: WorkerStatus[] = [];
  const done: WorkerStatus[] = [];
  for (const s of statuses) {
    if (s.state === "running" && alive(s.pid)) running.push(s);
    else {
      if (s.state === "running") s.state = "lost";
      done.push(s);
    }
  }
  // group stages by their chain id, keeping first-seen order
  const group = (list: WorkerStatus[]): { s: WorkerStatus; chain: string | null }[] => {
    const out: { s: WorkerStatus; chain: string | null }[] = [];
    for (const s of list) {
      out.push({ s, chain: s.parent ?? null });
    }
    return out;
  };
  const treeLine = (line: string, chain: string | null, last: boolean): string => {
    if (chain === null) return line;
    const mark = last ? "└" : "├";
    const bar = last ? " " : "│";
    return line.startsWith("      ")
      ? `  ${bar}   ${line.slice(6)}`
      : `  ${mark} ${line.slice(2)}`;
  };

  const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const lines: string[] = [c("bold", `Workers  ${clock}`), ""];
  lines.push(c("bold", `RUNNING (${running.length})`));
  if (!running.length) lines.push("  none");
  const runEntries = group(running);
  for (let i = 0; i < runEntries.length; i++) {
    const { s, chain } = runEntries[i];
    if (chain) {
      const prev = runEntries[i - 1];
      if (!prev || prev.chain !== chain) {
        const stages = runEntries.filter((e) => e.chain === chain).map((e) => e.s);
        lines.push(`  ${c("bold", `chain ${chain}`)}  ${chainLabelOf(stages)}`);
      }
    }
    const last = !chain || !runEntries[i + 1] || runEntries[i + 1].chain !== chain;
    const meter = contextMeter(c, s, 60);
    lines.push(
      treeLine(
        `  ${c("cyan", s.id)} [${s.provider}]  ${ageOf(s.started, now).padStart(4)} old  turns ${String(s.turns).padStart(2)}  tools ${String(s.tools).padStart(2)}  ${basename(s.cwd)}${meter ? "  " + meter : ""}`,
        chain,
        last
      )
    );
    lines.push(treeLine(`      task: ${s.label}`, chain, last));
    lines.push(
      treeLine(`      now:  ${c("yellow", s.last)}  (${ageOf(s.updated, now)} ago)`, chain, last)
    );
  }
  lines.push("");
  lines.push(c("bold", "FINISHED (last 8)"));
  const doneEntries = group(done.slice(-8));
  for (let i = 0; i < doneEntries.length; i++) {
    const { s, chain } = doneEntries[i];
    if (chain) {
      const prev = doneEntries[i - 1];
      if (!prev || prev.chain !== chain) {
        const stages = doneEntries.filter((e) => e.chain === chain).map((e) => e.s);
        lines.push(`  ${c("bold", `chain ${chain}`)}  ${chainLabelOf(stages)}`);
      }
    }
    const last = !chain || !doneEntries[i + 1] || doneEntries[i + 1].chain !== chain;
    const col = s.state === "done" ? "green" : "red";
    const tag = sessionTag(s);
    lines.push(
      treeLine(
        `  ${s.id} [${s.provider}]${tag ? " " + tag : ""}  ${c(col, s.state.padEnd(6))} rc=${s.rc}  ${String(s.secs ?? "?").padStart(4)}s  turns ${String(s.turns).padStart(2)}  tools ${String(s.tools).padStart(2)}  ${basename(s.cwd)}  ${s.label}`,
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

/** One-line status-bar summary (same shape glm-ps --status printed). */
export function renderStatusLine(
  mine: WorkerStatus[],
  now: Date = new Date(),
  c: Paint = makeColor(true)
): string {
  if (!mine.length) return "";
  const running = mine.filter((s) => s.state === "running" && alive(s.pid));
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const doneToday = mine.filter((s) => s.state !== "running" && s.started.startsWith(today));
  const ok = doneToday.filter((s) => s.state === "done").length;
  const bad = doneToday.length - ok;
  const providers = new Set(running.map((s) => s.provider));
  const providerTag = providers.size === 1 ? [...providers][0] : "workers";
  let head = `${providerTag} ▶${running.length}`;
  const parts = running.slice(0, 3).map((s) => {
    // context load joins the summary once it passes 60 % (yellow >70, red >85)
    const meter = contextMeter(c, s, 60);
    return (
      `${s.id.slice(-4)} ${s.label.slice(0, 26)} ${ageOf(s.started, now)} · ${s.last.slice(0, 30)}` +
      (meter ? ` ${meter}` : "")
    );
  });
  if (parts.length) head += "  " + parts.join(" | ");
  if (doneToday.length) head += `   ✓${ok} ✗${bad} today`;
  return head;
}
