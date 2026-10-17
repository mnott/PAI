/**
 * repeat-loop.ts — a worker issuing the same failing tool call over and over.
 * Pure: takes the worker's stream-json events, returns the trailing run.
 */

export interface RepeatLoop {
  name: string;
  count: number;
  /** Canonical input of the repeated call, truncated. */
  input: string;
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
  const uses = new Map<string, { name: string; key: string }>();
  const calls: Call[] = [];
  for (const e of events) {
    const ev = e as { type?: string; message?: { content?: unknown } };
    const blocks = ev?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (!b || typeof b !== "object") continue;
      if (ev.type === "assistant" && b.type === "tool_use" && typeof b.id === "string") {
        uses.set(b.id, { name: String(b.name ?? "?"), key: canon(b.input) });
      } else if (ev.type === "user" && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const use = uses.get(b.tool_use_id);
        if (!use) continue;
        const text = resultText(b.content);
        const failed = b.is_error === true || (use.name === "Bash" && /^Exit code (?!0\b)\d+/.test(text.trim()));
        calls.push({ ...use, failed });
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