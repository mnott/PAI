/**
 * codex.ts — adapter over Codex CLI session logs:
 * `<codex home>/sessions/**\/rollout-*.jsonl`. Implemented against the
 * documented rollout shape (JSON lines; `type:"message"` with role
 * user/assistant, `function_call` / `function_call_output`); unknown entry
 * types and malformed lines are skipped rather than failing the session.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, HarnessEvent, HarnessSession } from "./types.js";

/** Codex CLI's config dir: CODEX_HOME if set, else ~/.codex. */
export function codexHomeDir(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

interface Entry {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: unknown;
    name?: string;
    arguments?: unknown;
    output?: unknown;
  };
}

/** Plain text of a message payload's content: a string, or text parts joined. */
function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const o = p as Record<string, unknown>;
          if (typeof o.text === "string") return o.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** function_call arguments: parsed as JSON when they are a JSON string. */
function parseArgs(a: unknown): unknown {
  if (typeof a !== "string") return a;
  try {
    return JSON.parse(a);
  } catch {
    return a;
  }
}

/** Events of one parsed rollout entry; nothing for entries that carry none. */
function eventsOfEntry(sessionId: string, e: Entry): HarnessEvent[] {
  const ts = e.timestamp ?? "";
  const p = e.payload;
  if (!p || !p.type) return [];
  if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
    const text = contentText(p.content);
    if (!text) return [];
    return [{ harness: NAME, sessionId, ts, kind: p.role, text, source: "transcript", fidelity: "observed" }];
  }
  if (p.type === "function_call" && p.name) {
    return [{ harness: NAME, sessionId, ts, kind: "tool_call", tool: p.name, input: parseArgs(p.arguments), source: "transcript", fidelity: "observed" }];
  }
  if (p.type === "function_call_output") {
    return [{ harness: NAME, sessionId, ts, kind: "tool_result", text: contentText(p.output), source: "transcript", fidelity: "observed" }];
  }
  return [];
}

const NAME = "codex";

/** Sort/filter time of an updatedAt stamp; an unparsable one counts as 0 (oldest). */
function sortMs(updatedAt: string): number {
  const ms = Date.parse(updatedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** rollout-*.jsonl under `dir`, recursing into subdirectories. */
function rolloutFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...rolloutFiles(p));
    else if (ent.name.startsWith("rollout-") && ent.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function toSession(file: string): HarnessSession {
  const id = file.slice(0, -".jsonl".length).split("/").pop() ?? file;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      let e: Entry;
      try {
        e = JSON.parse(raw) as Entry;
      } catch {
        continue;
      }
      if (typeof e.timestamp === "string" && e.timestamp) {
        startedAt ??= e.timestamp;
        updatedAt = e.timestamp;
      }
    }
  } catch {
    // unreadable file: mtime below still lists it
  }
  const mtime = new Date(statSync(file).mtimeMs).toISOString();
  return { harness: NAME, id, path: file, startedAt, updatedAt: updatedAt ?? mtime };
}

export const codexAdapter: HarnessAdapter = {
  name: NAME,
  detect() {
    return existsSync(join(codexHomeDir(), "sessions"));
  },
  listSessions(opts: { cwd?: string; sinceMs?: number } = {}): HarnessSession[] {
    const root = join(codexHomeDir(), "sessions");
    if (!existsSync(root)) return [];
    const out = rolloutFiles(root).map(toSession);
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
      let e: Entry;
      try {
        e = JSON.parse(raw) as Entry;
      } catch {
        continue;
      }
      yield* eventsOfEntry(session.id, e);
    }
  },
};
