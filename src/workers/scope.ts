/**
 * scope.ts — which workers "belong" to the terminal asking about them.
 *
 * Two identities, in priority order:
 *
 *   1. AIBroker's session registry (~/.aibroker/session-names.json): iTerm
 *      session UUID → session name. The launching session's UUID is stored in
 *      each worker's status file as `session.id`, so every pane of a named
 *      session sees its workers — regardless of tab layout.
 *   2. The iTerm tab key (`w<window>t<tab>` prefix of ITERM_SESSION_ID): the
 *      original heuristic, kept as the fallback when no registry entry
 *      matches (AIBroker absent, unnamed session, non-iTerm terminal).
 *
 * If neither is available, viewers fall back to "all workers".
 *
 * A third case: workers spawned from a Claude Code Bash tool (the
 * orchestrator pattern) have neither — Claude Code exports no terminal or
 * session identity to its Bash children. Those record `spawnerSession`, the
 * orchestrator's claude session id bridged through the status line's
 * session map (see below), so their tab still claims them.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadStatus, type WorkerStatus } from "./status.js";

export const AIBROKER_REGISTRY = join(homedir(), ".aibroker", "session-names.json");

/**
 * `w<window>t<tab>` prefix of an iTerm session id, "" if empty or malformed.
 * Panes split from the same tab share this prefix and differ only in `p<n>`.
 */
export function tabKey(term: string): string {
  if (!term) return "";
  const head = term.split("p", 1)[0];
  const parts = head.slice(1).split("t");
  if (head.startsWith("w") && parts.length === 2 && parts.every((p) => /^\d+$/.test(p))) {
    return head;
  }
  return "";
}

/** Tab key of the iTerm tab this process runs in, "" if not inside iTerm2. */
export function currentTabKey(env: NodeJS.ProcessEnv = process.env): string {
  return tabKey(env.ITERM_SESSION_ID ?? "");
}

/** The iTerm UUID part of an ITERM_SESSION_ID (after the last colon). */
export function itermUuid(term: string): string {
  if (!term) return "";
  return term.split(":").pop() ?? "";
}

export interface SessionIdentity {
  id: string;
  name: string;
}

/**
 * Resolve the AIBroker session for an ITERM_SESSION_ID. Reads the persistent
 * name registry (the same store `aibroker_rename` writes); returns null when
 * AIBroker is absent or the session is not in it — callers then use the tab
 * key, which is the pre-AIBroker behaviour.
 */
export function resolveSession(
  term: string,
  registryPath: string = AIBROKER_REGISTRY
): SessionIdentity | null {
  const uuid = itermUuid(term);
  if (!uuid) return null;
  let names: Record<string, unknown>;
  try {
    if (!existsSync(registryPath)) return null;
    names = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = names[uuid];
  if (typeof name !== "string" || !name) return null;
  return { id: uuid, name };
}

/**
 * True when `worker` was launched from `term` (the terminal asking about it).
 * Session-id match first; the tab key only when no registry entry matched —
 * a session without a name keeps the tab-scoped behaviour it always had.
 */
export function workerInScope(worker: WorkerStatus, term: string): boolean {
  if (!term) return false;
  const uuid = itermUuid(term);
  if (worker.session?.id && uuid) return worker.session.id === uuid;
  return tabKey(worker.term) === tabKey(term) && tabKey(term) !== "";
}

/**
 * Registry key for pane files: the session id when AIBroker knows this
 * terminal, else the tab key, else the raw iTerm UUID.
 */
export function scopeKey(term: string): string {
  const session = resolveSession(term);
  if (session) return session.id;
  return currentTabKey() || itermUuid(term);
}

/** `[Name]` when the worker has an AIBroker session name, else "". */
export function sessionTag(worker: { session?: { name?: string } | null }): string {
  return worker.session?.name ? `[${worker.session.name}]` : "";
}

// ---------------------------------------------------------------------------
// spawner sessions — attribution for workers launched from a Claude Code Bash
// ---------------------------------------------------------------------------

/**
 * Claude Code exports neither ITERM_SESSION_ID nor its own session id to the
 * Bash tool, so a `pai worker run` from an orchestrator has no terminal to
 * record and its status would be unattributable. The status line is the one
 * process that sees both identities at once — the payload's session_id and
 * the tab's ITERM_SESSION_ID — so it bridges them: every refresh writes this
 * cwd-keyed map, and the runner reads it back at spawn time.
 */
export interface SessionMapEntry {
  session: string;
  ts: number;
  /**
   * The tab's ITERM_SESSION_ID, when the status line could see one — the
   * bridge back from a claude session id to the terminal it runs in
   * (supervision uses it to push worker events into that terminal).
   * Absent on entries written before the field existed.
   */
  term?: string;
}

/** How old a map entry may be for a spawn to adopt it (status lines refresh constantly while a session lives). */
export const SPAWNER_SESSION_TTL_MS = 10 * 60_000;

/** Map entries not refreshed within this window are pruned on write. */
const SESSION_MAP_PRUNE_MS = 60 * 60_000;

export function sessionMapPath(logDir: string): string {
  return join(logDir, "claude-session-map.json");
}

/**
 * Record that the claude session `session` renders its status line in `cwd`
 * (and, when known, in iTerm session `term`). Never throws — a broken map
 * must not break the bar. Prunes stale entries; skips the write when the
 * entry is unchanged and fresh.
 */
export function recordSessionMapEntry(
  logDir: string,
  cwd: string,
  session: string,
  term?: string,
  now: number = Date.now()
): void {
  if (!cwd || !session) return;
  const path = sessionMapPath(logDir);
  let map: Record<string, SessionMapEntry> = {};
  try {
    if (existsSync(path)) {
      map = JSON.parse(readFileSync(path, "utf8")) as Record<string, SessionMapEntry>;
    }
  } catch {
    map = {}; // a damaged map is rewritten, never fatal
  }
  const prev = map[cwd];
  if (
    prev &&
    prev.session === session &&
    (prev.term ?? "") === (term ?? "") &&
    now - prev.ts < 60_000
  ) {
    return;
  }
  const pruned: Record<string, SessionMapEntry> = {};
  for (const [dir, e] of Object.entries(map)) {
    if (now - e.ts < SESSION_MAP_PRUNE_MS) pruned[dir] = e;
  }
  pruned[cwd] = { session, ts: now, ...(term ? { term } : {}) };
  try {
    mkdirSync(logDir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(pruned), "utf8");
    renameSync(tmp, path);
  } catch {
    // unwritable log dir: no attribution this round, nothing else breaks
  }
}

/**
 * The claude session a new run was spawned by, when it can be known: a run
 * inside another worker inherits its spawner (chain stages keep the
 * orchestrator's tab that way); otherwise a fresh map entry for `cwd`.
 */
export function resolveSpawnerSession(
  logDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): string | null {
  const parentId = env.PAI_WORKER_ID;
  if (parentId) {
    const inherited = loadStatus(logDir, parentId)?.spawnerSession;
    if (inherited) return inherited;
  }
  const path = sessionMapPath(logDir);
  if (!existsSync(path) || !cwd) return null;
  try {
    const entry = (JSON.parse(readFileSync(path, "utf8")) as Record<string, SessionMapEntry>)[cwd];
    if (entry && entry.session && now - entry.ts < SPAWNER_SESSION_TTL_MS) return entry.session;
  } catch {
    // a damaged map simply attributes nothing
  }
  return null;
}

/**
 * The iTerm UUID a claude session last rendered its status line in, when the
 * map knows one: the freshest entry naming that session. This is the reverse
 * of resolveSpawnerSession — worker → orchestrator there, orchestrator →
 * terminal here — and it exists so daemon-side pushes (supervision) can reach
 * a session that has no iTerm identity of its own in any worker status.
 */
export function itermForClaudeSession(
  logDir: string,
  claudeSession: string,
  now: number = Date.now()
): string | null {
  const path = sessionMapPath(logDir);
  if (!existsSync(path) || !claudeSession) return null;
  let map: Record<string, SessionMapEntry>;
  try {
    map = JSON.parse(readFileSync(path, "utf8")) as Record<string, SessionMapEntry>;
  } catch {
    return null;
  }
  let best: SessionMapEntry | null = null;
  for (const e of Object.values(map)) {
    if (e.session !== claudeSession || !e.term) continue;
    // a stale entry names a tab the session left; freshness orders them
    if (now - e.ts >= SESSION_MAP_PRUNE_MS) continue;
    if (!best || e.ts > best.ts) best = e;
  }
  const term = best?.term;
  return term ? itermUuid(term) : null;
}
