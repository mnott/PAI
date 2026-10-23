/**
 * claude-code.ts — adapter over Claude Code's JSONL transcripts:
 * `<claude home>/projects/<encoded cwd>/<session id>.jsonl`. The encoded-cwd
 * spelling is the one PAI already uses everywhere (encodeDir, src/cli/lib/utils.ts).
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeHomeDir, claudeProjectsDir } from "../config/pai-home.js";
import { encodeDir } from "../cli/lib/utils.js";
import type { HarnessAdapter, HarnessEvent, HarnessSession } from "./types.js";

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}
interface Line {
  type?: string;
  timestamp?: string;
  cwd?: string;
  /** Injected (skill expansion, system reminder) — not something the user typed. */
  isMeta?: boolean;
  message?: { role?: string; content?: string | Block[] };
}

/** Text of a tool_result's content: a string or its text blocks joined. */
function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" && typeof (b as Block).text === "string" ? (b as Block).text : "")).join("\n");
  return "";
}

/** Exit code a Bash result shows ("Exit code N" header or an exitCode field); else undefined. */
function exitCodeOf(content: unknown): number | undefined {
  if (typeof content === "string") {
    const m = /^Exit code (\d+)/m.exec(content);
    return m ? Number(m[1]) : undefined;
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const v = (content as Record<string, unknown>).exitCode;
    if (typeof v === "number") return v;
  }
  return undefined;
}

/** Events of one parsed transcript line; nothing for lines that carry no event. */
function eventsOfLine(harness: string, sessionId: string, obj: Line): HarnessEvent[] {
  const ts = obj.timestamp ?? "";
  const content = obj.message?.content;
  const out: HarnessEvent[] = [];
  const blocks = Array.isArray(content) ? content : [];
  if (obj.type === "user") {
    for (const b of blocks) {
      if (b.type === "tool_result") {
        out.push({ harness, sessionId, ts, kind: "tool_result", text: resultText(b.content), exitCode: exitCodeOf(b.content), source: "transcript", fidelity: "observed" });
      }
    }
    // a typed prompt: string content or text blocks, never an injected (isMeta) line
    if (!obj.isMeta) {
      const text = typeof content === "string" ? content : blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      if (text) out.push({ harness, sessionId, ts, kind: "user", text, source: "transcript", fidelity: "observed" });
    }
    return out;
  }
  if (obj.type === "assistant" && Array.isArray(content)) {
    for (const b of content) {
      if (b.type === "text" && b.text) out.push({ harness, sessionId, ts, kind: "assistant", text: b.text, source: "transcript", fidelity: "observed" });
      else if (b.type === "tool_use" && b.name) out.push({ harness, sessionId, ts, kind: "tool_call", tool: b.name, input: b.input, source: "transcript", fidelity: "observed" });
    }
  }
  return out;
}

/** Session files under a project dir: top-level `<id>.jsonl` only — the
 *  `sessions/` archive holds hardlinks of the same files, and subagent logs
 *  live in their own subdirs. */
function sessionFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

const CHUNK = 64 * 1024;

/** Sort/filter time of an updatedAt stamp; an unparsable one counts as 0 (oldest). */
function sortMs(updatedAt: string): number {
  const ms = Date.parse(updatedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Parsed lines of `text`; the first and last may be cut by the chunk edge, so `partialFirst`/`partialLast` drop them. */
function parseLines(text: string, partialFirst: boolean, partialLast: boolean): Line[] {
  const lines = text.split("\n");
  if (partialFirst) lines.shift();
  if (partialLast) lines.pop();
  const out: Line[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw) as Line);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** The session of one transcript, reading only its first and last 64 KB; null when the file vanished. */
export function toSession(harness: string, file: string, dir: string): HarnessSession | null {
  const id = file.slice(0, -".jsonl".length);
  const path = join(dir, file);
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let cwd: string | undefined;
  let mtime: string;
  try {
    const size = statSync(path).size;
    mtime = new Date(statSync(path).mtimeMs).toISOString();
    try {
      const fd = openSync(path, "r");
      try {
        const read = (pos: number, len: number): string => {
          const buf = Buffer.alloc(len);
          return buf.toString("utf8", 0, readSync(fd, buf, 0, len, pos));
        };
        const head = parseLines(read(0, Math.min(size, CHUNK)), false, size > CHUNK);
        for (const obj of head) {
          if (typeof obj.cwd === "string" && obj.cwd) cwd ??= obj.cwd;
          if (typeof obj.timestamp === "string" && obj.timestamp) startedAt ??= obj.timestamp;
          if (cwd && startedAt) break;
        }
        const from = Math.max(0, size - CHUNK);
        const tail = parseLines(read(from, size - from), from > 0, false);
        for (const obj of tail) if (typeof obj.timestamp === "string" && obj.timestamp) updatedAt = obj.timestamp;
      } finally {
        closeSync(fd);
      }
    } catch {
      // unreadable file: mtime still lists it
    }
  } catch {
    return null; // vanished between listing and stat
  }
  return { harness, id, cwd, path, startedAt, updatedAt: updatedAt ?? mtime };
}

export const claudeCodeAdapter: HarnessAdapter = {
  name: "claude-code",
  detect() {
    return existsSync(claudeProjectsDir());
  },
  listSessions(opts: { cwd?: string; sinceMs?: number } = {}): HarnessSession[] {
    const projectsDir = claudeProjectsDir();
    if (!existsSync(projectsDir)) return [];
    const dirs = opts.cwd ? [encodeDir(opts.cwd)] : readdirSafe(projectsDir);
    const out: HarnessSession[] = [];
    for (const d of dirs) {
      const dir = join(projectsDir, d);
      if (!existsSync(dir)) continue;
      for (const f of sessionFiles(dir)) {
        const sess = toSession(this.name, f, dir);
        if (sess) out.push(sess);
      }
    }
    const since = opts.sinceMs !== undefined ? Date.now() - opts.sinceMs : undefined;
    return out
      .filter((s) => since === undefined || sortMs(s.updatedAt) >= since)
      .sort((a, b) => sortMs(b.updatedAt) - sortMs(a.updatedAt));
  },
  *readEvents(session: HarnessSession): Iterable<HarnessEvent> {
    let text: string;
    try {
      text = readFileSync(session.path, "utf8");
    } catch {
      return;
    }
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let obj: Line;
      try {
        obj = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      yield* eventsOfLine(this.name, session.id, obj);
    }
  },
};

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
