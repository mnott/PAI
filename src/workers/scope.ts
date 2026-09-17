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
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkerStatus } from "./status.js";

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
