/**
 * pai-files.ts — path resolution for the PAI per-user files that don't have
 * a dedicated module of their own: whisper-rules.md, advisor-mode.json, and
 * the stop-hook's session-state/ dir (kept here rather than in the hook
 * itself, since importing that hook module runs it — it calls main() at
 * import time).
 * config.json lives in daemon/config.ts, workers.yaml in
 * workers/workers-config.ts — this covers the rest of PAI_HOME.
 */

import { existsSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  paiHomePath,
  resolvePaiFile,
  migratePaiFile,
  migratePaiDir,
  type MigrateFileResult,
  type MigrateDirResult,
} from "./pai-home.js";

export { paiHomePath };

function oldWhisperRulesPath(): string {
  return join(homedir(), ".claude", "whisper-rules.md");
}

function oldAdvisorModePath(): string {
  return join(homedir(), ".claude", "advisor-mode.json");
}

function oldSessionStateDir(): string {
  return join(homedir(), ".config", "pai", "session-state");
}

export function whisperRulesPath(): string {
  return resolvePaiFile(paiHomePath("whisper-rules.md"), [oldWhisperRulesPath()], "pai config migrate");
}

export function advisorModePath(): string {
  return resolvePaiFile(paiHomePath("advisor-mode.json"), [oldAdvisorModePath()], "pai config migrate");
}

export function migrateWhisperRules(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath("whisper-rules.md"), [oldWhisperRulesPath()], opts);
}

export function migrateAdvisorMode(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath("advisor-mode.json"), [oldAdvisorModePath()], opts);
}

/** Read location: PAI_HOME's session-state/ if present, else the
 *  pre-2026-09-19 ~/.config/pai/session-state (one-time stderr notice). */
export function sessionStateDir(): string {
  return resolvePaiFile(paiHomePath("session-state"), [oldSessionStateDir()], "pai config migrate");
}

export function migrateSessionStateDir(opts: { dryRun?: boolean } = {}): MigrateDirResult {
  return migratePaiDir(paiHomePath("session-state"), [oldSessionStateDir()], opts);
}

// ---------------------------------------------------------------------------
// Orphans: files under the old ~/.config/pai that no code currently reads
// (voices.json — no `voice` reference anywhere in src). Still moved by
// `pai config migrate` so ~/.config/pai ends up with nothing but
// *.migrated-* markers. The orphaned legacy federation database is handled
// by storage/paths.ts's migrateOrphanFederationDb — this file stays free of
// database path literals so it is not a database opener.
// ---------------------------------------------------------------------------

function oldLastHousekeepingPath(): string {
  return join(homedir(), ".config", "pai", ".last-housekeeping");
}

/** session-stop.sh resolves this itself at runtime (it can't import TS) —
 *  this is only what `pai config migrate` uses to relocate a leftover. */
export function migrateLastHousekeeping(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath(".last-housekeeping"), [oldLastHousekeepingPath()], opts);
}

function oldVoicesJsonPath(): string {
  return join(homedir(), ".config", "pai", "voices.json");
}

export function migrateVoicesJson(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath("voices.json"), [oldVoicesJsonPath()], opts);
}

// ---------------------------------------------------------------------------
// .session-stop.lock — a live mkdir-based mutex, not data. session-stop.sh
// already creates new locks at PAI_HOME going forward (see src/hooks/
// session-stop.sh); this only handles what's left at the old location.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// History/, agent-sessions.json, session-routing.json, security-events.jsonl
// — hook-written PAI state, read/written at runtime via the resolvers in
// src/hooks/ts/lib/pai-paths.ts (ADAPTER_DIR fallback + notice, same as
// everything here). Duplicated here rather than imported: pai-paths.ts
// validates ADAPTER_DIR/HOOKS_DIR exist at import time (process.exit(1) if
// not) since every hook that imports it genuinely needs that guarantee — the
// CLI does not, and must not inherit a hook-only failure mode just to
// migrate a file. Actively written by hooks in every live session, so unlike
// most of this file the live move is NOT automatic — see `pai config migrate
// --history` and its RUNNING-worker guard in src/cli/commands/config.ts.
// ---------------------------------------------------------------------------

function oldHistoryDir(): string {
  return join(homedir(), ".claude", "History");
}

export function migrateHistoryDir(opts: { dryRun?: boolean } = {}): MigrateDirResult {
  return migratePaiDir(paiHomePath("History"), [oldHistoryDir()], opts);
}

function oldAgentSessionsPath(): string {
  return join(homedir(), ".claude", "agent-sessions.json");
}

export function migrateAgentSessions(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath("agent-sessions.json"), [oldAgentSessionsPath()], opts);
}

function oldSessionRoutingPath(): string {
  return join(homedir(), ".claude", "session-routing.json");
}

export function migrateSessionRouting(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath("session-routing.json"), [oldSessionRoutingPath()], opts);
}

function oldSecurityEventsPath(): string {
  return join(homedir(), ".claude", "history", "security", "security-events.jsonl");
}

export function migrateSecurityEvents(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath("History", "security", "security-events.jsonl"), [oldSecurityEventsPath()], opts);
}

export interface MigrateLockResult {
  status: "nothing-to-migrate" | "skipped-in-use" | "moved";
  note: string;
}

/** A lock this fresh means a session-stop.sh tail is genuinely running under
 *  it right now — moving it out from under that process would break the
 *  mutex it exists to provide. Matches the hook's own 600s abandonment
 *  window with headroom, since this runs far less often than every Stop. */
const SESSION_STOP_LOCK_ABANDONED_AFTER_MS = 60 * 60 * 1000;

export function migrateSessionStopLock(opts: { dryRun?: boolean } = {}): MigrateLockResult {
  const oldPath = join(homedir(), ".config", "pai", ".session-stop.lock");
  const newPath = paiHomePath(".session-stop.lock");
  if (!existsSync(oldPath)) {
    return { status: "nothing-to-migrate", note: `nothing to migrate (${newPath})` };
  }

  const ageMs = Date.now() - statSync(oldPath).mtimeMs;
  if (ageMs <= SESSION_STOP_LOCK_ABANDONED_AFTER_MS) {
    return {
      status: "skipped-in-use",
      note: `in use (${Math.round(ageMs / 1000)}s old) — left in place; new locks go to ${newPath}`,
    };
  }

  const ageMin = Math.round(ageMs / 60000);
  if (opts.dryRun) {
    return { status: "moved", note: `would rename abandoned lock (${ageMin}m old) at ${oldPath}` };
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  renameSync(oldPath, `${oldPath}.migrated-${stamp}`);
  return { status: "moved", note: `abandoned lock (${ageMin}m old) renamed aside` };
}
