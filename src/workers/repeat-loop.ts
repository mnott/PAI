/**
 * repeat-loop.ts — a worker issuing the same failing tool call over and over.
 * Pure: takes the worker's stream-json events, returns the trailing run.
 */

import { classifyToolError, summarizeToolInput } from "./tool-errors.js";

export interface RepeatLoop {
  name: string;
  count: number;
  /** Canonical input of the repeated call, truncated. */
  input: string;
  /** Set for an echo loop (see detectEchoLoop); absent for a repeated failing call. */
  kind?: "echo";
  /** Echo loops only: what tripped the verdict. */
  by?: "turns" | "string";
}

export const LOOP_WARN_AT = 3;
export const LOOP_STOP_AT = 6;

export function loopAction(count: number): "none" | "warn" | "stop" {
  if (count >= LOOP_STOP_AT) return "stop";
  if (count >= LOOP_WARN_AT) return "warn";
  return "none";
}

interface Call {
  name: string;
  key: string;
  failed: boolean;
}

const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
};

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n");
  return "";
}

/** The trailing run (>= minRepeat) of identical, failed tool calls, or null. */
export function detectRepeatLoop(events: unknown[], minRepeat = LOOP_WARN_AT): RepeatLoop | null {
  const uses = new Map<string, { name: string; key: string; input: unknown }>();
  const calls: Call[] = [];
  for (const e of events) {
    const ev = e as { type?: string; message?: { content?: unknown } };
    const blocks = ev?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (!b || typeof b !== "object") continue;
      if (ev.type === "assistant" && b.type === "tool_use" && typeof b.id === "string") {
        uses.set(b.id, { name: String(b.name ?? "?"), key: canon(b.input), input: b.input });
      } else if (ev.type === "user" && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const use = uses.get(b.tool_use_id);
        if (!use) continue;
        const text = resultText(b.content);
        const failed = b.is_error === true || (use.name === "Bash" && /^Exit code (?!0\b)\d+/.test(text.trim()));
        // designed non-zero answers (wait verbs exit 3, grep no-match, diff...) are not failures
        const benign = failed && classifyToolError({ ts: 0, worker: "", provider: "", label: "", tool: use.name, signature: "", raw: text.trim(), input: summarizeToolInput(use.input) }).cls === "benign";
        calls.push({ name: use.name, key: use.key, failed: failed && !benign });
      }
    }
  }
  const last = calls[calls.length - 1];
  if (!last || !last.failed) return null;
  let n = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (c.failed && c.name === last.name && c.key === last.key) n++;
    else break;
  }
  return n >= minRepeat ? { name: last.name, count: n, input: last.key.slice(0, 200) } : null;
}

// ---------------------------------------------------------------------------
// Echo loop — turns that only announce success, never edit anything
// ---------------------------------------------------------------------------

export const ECHO_LOOP_TURNS = 12;
export const ECHO_SAME_STRING = 3;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TRIVIAL_CMDS = new Set(["echo", "printf", "cat", "ls", "true"]);
const SUCCESS_RE = /success|complete|done|finished|✅|✓/i;

/** True when every segment of a Bash command is echo/printf/cat/ls/true and writes no file. */
export function isTrivialBash(cmd: string): boolean {
  if (/(^|[^0-9&])>{1,2}\s*[^&\s]/.test(cmd) || /<</.test(cmd)) return false;
  const segs = cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  return segs.length > 0 && segs.every((s) => TRIVIAL_CMDS.has(s.split(/\s+/)[0]));
}

/** Success string with digits, quotes and case folded, so near-identical lines match. */
function successKey(cmd: string): string | null {
  const m = cmd.match(/^\s*(?:echo|printf)\s+(.*)$/s);
  if (!m || !SUCCESS_RE.test(m[1])) return null;
  return m[1].toLowerCase().replace(/[\d"'`\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * The trailing run of tool-using turns that contain no Edit/Write and only
 * trivial Bash, or null. Fires at `minTurns` such turns, or when one
 * success string (digits ignored) repeats ECHO_SAME_STRING times in the run.
 */
export function detectEchoLoop(events: unknown[], minTurns = ECHO_LOOP_TURNS): RepeatLoop | null {
  const turns: Array<Array<{ name: string; cmd: string }>> = [];
  for (const e of events) {
    const ev = e as { type?: string; message?: { content?: unknown } };
    const blocks = ev?.message?.content;
    if (ev?.type !== "assistant" || !Array.isArray(blocks)) continue;
    const uses = (blocks as Array<Record<string, unknown>>)
      .filter((b) => b && b.type === "tool_use")
      .map((b) => ({ name: String(b.name ?? "?"), cmd: String((b.input as { command?: unknown } | undefined)?.command ?? "") }));
    if (uses.length) turns.push(uses);
  }
  let n = 0;
  const seen = new Map<string, number>();
  let sameMax = 0;
  let sample = "";
  for (let i = turns.length - 1; i >= 0; i--) {
    const trivial = turns[i].every((u) => u.name === "Bash" && !EDIT_TOOLS.has(u.name) && isTrivialBash(u.cmd));
    if (!trivial) break;
    n++;
    for (const u of turns[i]) {
      const k = successKey(u.cmd);
      if (!k) continue;
      const c = (seen.get(k) ?? 0) + 1;
      seen.set(k, c);
      if (c > sameMax) {
        sameMax = c;
        sample = u.cmd;
      }
    }
  }
  if (n >= minTurns) return { name: "echo", count: n, input: sample.slice(0, 200) || "echo", kind: "echo", by: "turns" };
  if (sameMax >= ECHO_SAME_STRING) return { name: "echo", count: sameMax, input: sample.slice(0, 200), kind: "echo", by: "string" };
  return null;
}

/** Echo loops warn when detected and stop at twice the turn threshold (or 2x repeats of one string). */
export function echoLoopAction(l: RepeatLoop, minTurns = ECHO_LOOP_TURNS): "warn" | "stop" {
  return l.count >= 2 * (l.by === "string" ? ECHO_SAME_STRING : minTurns) ? "stop" : "warn";
}
