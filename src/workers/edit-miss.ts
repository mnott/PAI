/**
 * edit-miss.ts — a failed Edit ("String to replace not found") gets the file's real lines back.
 * Pure parts: find the failures in a transcript, build the note. checkLoops does the delivery.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const EDIT_MISS_RE = /String to replace not found|No changes to make: old_string and new_string are exactly the same/i;
const EDIT_NOOP_RE = /No changes to make: old_string and new_string are exactly the same/i;
export const EDIT_MISS_COUNT_FILE = "edit-misses.jsonl";
export const EDIT_REWRITE_AT = 3;
const WHOLE_FILE_LINES = 120;
const CONTEXT_LINES = 15;

export interface EditMiss {
  file: string;
  oldString: string;
  /** Failed Edits on this file in the scanned tail. */
  count: number;
  /** The latest failure was an Edit whose old_string equals its new_string. */
  noop?: boolean;
}

/** The file with the most failed Edits (latest wins a tie) in the events, or null. */
export function detectEditMiss(events: unknown[]): EditMiss | null {
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const per = new Map<string, EditMiss>();
  let latest: EditMiss | null = null;
  for (const e of events) {
    const ev = e as { type?: string; message?: { content?: unknown } };
    const blocks = ev?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as Array<Record<string, any>>) {
      if (!b || typeof b !== "object") continue;
      if (ev.type === "assistant" && b.type === "tool_use" && typeof b.id === "string") {
        uses.set(b.id, { name: String(b.name ?? ""), input: (b.input ?? {}) as Record<string, unknown> });
      } else if (ev.type === "user" && b.type === "tool_result" && b.is_error === true) {
        const use = uses.get(String(b.tool_use_id));
        if (!use || use.name !== "Edit") continue;
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? "").join("\n") : "";
        if (!EDIT_MISS_RE.test(text)) continue;
        const file = String(use.input.file_path ?? "");
        if (!file) continue;
        const m = per.get(file) ?? { file, oldString: "", count: 0 };
        m.count++;
        m.oldString = String(use.input.old_string ?? "");
        m.noop = EDIT_NOOP_RE.test(text);
        per.set(file, m);
        latest = m;
      }
    }
  }
  return latest;
}

/** Longest common substring length of a and b (trimmed lines; small inputs). */
function lcs(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** 1-based index of the file line sharing the longest substring with any (trimmed) line of old; 0 if none. */
export function bestMatchLine(content: string, oldString: string): number {
  const lines = content.split("\n");
  const olds = oldString.split("\n").map((l) => l.trim()).filter((l) => l.length > 2).slice(0, 40);
  let best = 0;
  let at = 0;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.length < 3) return;
    for (const o of olds) {
      const s = lcs(t.slice(0, 300), o.slice(0, 300));
      if (s > best) {
        best = s;
        at = i + 1;
      }
    }
  });
  return best >= 3 ? at : 0;
}

/** Numbered lines around the best match; the whole file when short. */
export function fileExcerpt(content: string, oldString: string): string {
  const lines = content.split("\n");
  let from = 0;
  let to = lines.length;
  if (lines.length >= WHOLE_FILE_LINES) {
    const at = bestMatchLine(content, oldString) || 1;
    from = Math.max(0, at - 1 - CONTEXT_LINES);
    to = Math.min(lines.length, at + CONTEXT_LINES);
  }
  return lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(5)}| ${l}`).join("\n");
}

export function editMissNote(miss: EditMiss, content: string | null): string {
  if (miss.noop) return `Edit on ${miss.file} changed nothing: old_string and new_string are exactly the same. The change is probably already in the file; Read it to check, then move on.`;
  if (miss.count >= EDIT_REWRITE_AT) {
    return (
      `Edit on ${miss.file} has failed ${miss.count} times (String to replace not found). Stop using Edit on this file: ` +
      `Read the whole file and write it back with Write, or change the region by line number with a small python/sed edit ` +
      `(e.g. sed -i '' 'START,ENDc\\\\NEWTEXT' or a python script that rewrites lines START..END).` +
      (content === null ? "" : ` Current lines near your anchor:\n${fileExcerpt(content, miss.oldString)}`)
    );
  }
  if (content === null) return `Edit on ${miss.file} failed (String to replace not found); Read the file again and copy your anchor from it exactly.`;
  return `Edit on ${miss.file} failed: String to replace not found. The file's current content near your anchor (indentation and text exact), copy your anchor from these lines:\n${fileExcerpt(content, miss.oldString)}`;
}

/** One line per failed-Edit event, so the model that causes them can be counted (see readEditMisses). */
export function recordEditMiss(logDir: string, rec: { worker: string; model: string; provider: string; file: string; count: number }, now = Date.now()): void {
  try {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, EDIT_MISS_COUNT_FILE), JSON.stringify({ ts: now, ...rec }) + "\n", "utf8");
  } catch {
    // supervision data must never break a run
  }
}
