/**
 * Series watchdog for `pai bench run`: decides from a stream of worker events whether a running
 * eval series should be stopped. Port of the night toolbox's series-watchdog.mjs; the decision
 * logic is pure (Watchdog), the worker-log tailing (LogTail) only turns jsonl lines into events.
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Verdict = { reason: "REWRITE" | "RUNAWAY" | "IDLE"; detail: string };
export type WatchEvent =
  | { type: "write"; run: string; file: string } // a worker wrote an answer file of `run`
  | { type: "activity" }; // any other sign of life

export interface WatchLimits {
  /** A file of the series written this many times is a rewrite loop. */
  maxWrites: number;
  /** No worker activity for this long while a run is going. */
  idleMs: number;
  /** More distinct answer files in one run than any set has (sets have 20 or 40 tasks). */
  maxFiles: number;
}

export const DEFAULT_LIMITS: WatchLimits = { maxWrites: 15, idleMs: 900_000, maxFiles: 60 };

export class Watchdog {
  private writes = new Map<string, number>();
  private files = new Map<string, Set<string>>();
  private last: number;

  constructor(private limits: WatchLimits, now: number) {
    this.last = now;
  }

  /** A new run starts: the idle clock restarts (the gap between runs is grading, not idling). */
  reset(now: number): void {
    this.last = now;
    this.writes.clear();
    this.files.clear();
  }

  feed(ev: WatchEvent, now: number): Verdict | null {
    this.last = now;
    if (ev.type !== "write") return null;
    const key = `${ev.run}\0${ev.file}`;
    const n = (this.writes.get(key) ?? 0) + 1;
    this.writes.set(key, n);
    if (n >= this.limits.maxWrites) return { reason: "REWRITE", detail: `${ev.file} x${n} in ${ev.run}` };
    const set = this.files.get(ev.run) ?? new Set<string>();
    set.add(ev.file);
    this.files.set(ev.run, set);
    if (set.size > this.limits.maxFiles) return { reason: "RUNAWAY", detail: `${ev.run}: ${set.size} distinct files` };
    return null;
  }

  check(now: number): Verdict | null {
    const idle = now - this.last;
    return idle > this.limits.idleMs ? { reason: "IDLE", detail: `${Math.round(idle / 1000)}s without worker activity` } : null;
  }
}

/** File paths of the Write/Edit tool calls in one worker transcript line. */
export function writtenFiles(line: string): string[] {
  let j: { type?: string; message?: { content?: unknown } };
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  if (j.type !== "assistant" || !Array.isArray(j.message?.content)) return [];
  const out: string[] = [];
  for (const c of j.message!.content as { type?: string; name?: string; input?: { file_path?: unknown } }[]) {
    if (c?.type === "tool_use" && (c.name === "Write" || c.name === "Edit") && typeof c.input?.file_path === "string") out.push(c.input.file_path);
  }
  return out;
}

/** Answer files of the eval sets live in the run's out/ directory; only those count for rewrite and runaway. */
export function answerFile(path: string, cwd: string): string | null {
  const rel = path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
  return /^out\/[^/]+$/.test(rel) ? rel : null;
}

/** Follows the worker transcripts (<logDir>/<id>.jsonl) that grew since `since` and whose cwd passes `wanted`. */
export class LogTail {
  private offsets = new Map<string, number>();
  private cwds = new Map<string, string>();

  constructor(private logDir: string, private since: number, private wanted: (cwd: string) => boolean) {}

  poll(): WatchEvent[] {
    const events: WatchEvent[] = [];
    if (!existsSync(this.logDir)) return events;
    for (const f of readdirSync(this.logDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(this.logDir, f);
      let size: number;
      try {
        const st = statSync(p);
        if (st.mtimeMs < this.since) continue;
        size = st.size;
      } catch {
        continue;
      }
      const from = this.offsets.get(p) ?? 0;
      if (size <= from) continue;
      const buf = Buffer.alloc(size - from);
      const fd = openSync(p, "r");
      try {
        readSync(fd, buf, 0, buf.length, from);
      } finally {
        closeSync(fd);
      }
      const text = buf.toString("utf8");
      const end = text.lastIndexOf("\n") + 1; // a half-written last line waits for the next poll
      this.offsets.set(p, from + Buffer.byteLength(text.slice(0, end)));
      for (const line of text.slice(0, end).split("\n")) {
        if (!line) continue;
        if (!this.cwds.has(p)) {
          const m = line.match(/"subtype":"init","cwd":"([^"]+)"/);
          if (m) this.cwds.set(p, m[1]);
        }
        const cwd = this.cwds.get(p);
        if (cwd === undefined || !this.wanted(cwd)) continue;
        events.push({ type: "activity" });
        for (const w of writtenFiles(line)) {
          const file = answerFile(w, cwd);
          if (file) events.push({ type: "write", run: cwd, file });
        }
      }
    }
    return events;
  }
}
