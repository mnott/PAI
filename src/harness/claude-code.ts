/**
 * claude-code.ts — adapter over Claude Code's JSONL transcripts:
 * `<claude home>/projects/<encoded cwd>/<session id>.jsonl`. The encoded-cwd
 * spelling is the one PAI already uses everywhere (encodeDir, src/cli/lib/utils.ts).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

function toSession(harness: string, file: string, dir: string): HarnessSession {
  const id = file.slice(0, -".jsonl".length);
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let cwd: string | undefined;
  try {
    for (const raw of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!raw.trim()) continue;
      let obj: Line;
      try {
        obj = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      if (typeof obj.cwd === "string" && obj.cwd) cwd ??= obj.cwd;
      if (typeof obj.timestamp === "string" && obj.timestamp) {
        startedAt ??= obj.timestamp;
        updatedAt = obj.timestamp;
      }
    }
  } catch {
    // unreadable file: mtime below still lists it
  }
  const mtime = new Date(statSync(join(dir, file)).mtimeMs).toISOString();
  return { harness, id, cwd, path: join(dir, file), startedAt, updatedAt: updatedAt ?? mtime };
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
      for (const f of sessionFiles(dir)) out.push(toSession(this.name, f, dir));
    }
    const since = opts.sinceMs !== undefined ? Date.now() - opts.sinceMs : undefined;
    return out
      .filter((s) => since === undefined || Date.parse(s.updatedAt) >= since)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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
