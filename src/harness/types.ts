/**
 * types.ts — the seam between PAI and agent harnesses (Claude Code, Codex
 * CLI, ...). Read-only ingestion: an adapter finds a harness's session logs
 * on disk and replays them as events. Nothing here writes to or hooks into
 * a harness.
 */

/** One session's log file as an adapter found it. */
export interface HarnessSession {
  harness: string;
  id: string;
  /** Working directory when the log records one. */
  cwd?: string;
  path: string;
  /** First timestamped line's time; absent when the log carries none. */
  startedAt?: string;
  /** Last timestamped line's time, or the file's mtime when it carries none. */
  updatedAt: string;
}

/** One observed thing a session did. */
export interface HarnessEvent {
  harness: string;
  sessionId: string;
  ts: string;
  kind: "user" | "assistant" | "tool_call" | "tool_result";
  tool?: string;
  input?: unknown;
  text?: string;
  /** Bash-style exit code when the result content shows one; else undefined. */
  exitCode?: number;
  source: "transcript";
  fidelity: "observed" | "inferred";
}

/** A harness's session store, read-only. */
export interface HarnessAdapter {
  name: string;
  /** True when this harness's store exists on this machine. */
  detect(): boolean;
  /** Sessions newest-first; `cwd` limits to one directory, `sinceMs` to a window. */
  listSessions(opts?: { cwd?: string; sinceMs?: number }): HarnessSession[];
  /** The session's events in file order; lines the adapter cannot map are skipped. */
  readEvents(session: HarnessSession): Iterable<HarnessEvent>;
}
