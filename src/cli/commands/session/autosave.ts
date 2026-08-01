/**
 * pai session autosave [--session-id <uuid>] [--min-gap <seconds>] [--dry-run]
 *
 * The rolling floor. Runs unattended from live hooks during a session, so an
 * interrupted session still leaves a usable `## Continue` behind.
 *
 * It writes in "auto" mode, which is what makes it safe to run often: a
 * model-authored checkpoint for the same session is preserved untouched, so
 * this can never trade a good handover for a mechanical one. When there is no
 * authored checkpoint — the Ctrl+C case, the crash case, the "never got round
 * to it" case — this is what the next session finds instead of nothing.
 *
 * Silent and exit-0 on every path. It is wired to hooks that fire constantly;
 * anything it printed would be noise, and anything it threw would interrupt
 * Claude Code.
 */

import type { Database } from "better-sqlite3";
import { join } from "node:path";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { applyContinue } from "../../../session/checkpoint-block.js";
import {
  buildAutosaveBody,
  findTranscripts,
  resolveTranscriptDir,
} from "../../../session/autosave.js";
import { resolveSessionLine, resolveNotePath, resolveProjectByCwd } from "./pause.js";
import type { ProjectRow, SessionRow } from "./types.js";

export interface AutosaveOptions {
  sessionId?: string;
  minGap?: string;
  dryRun?: boolean;
}

/** Default seconds between autosaves. Long enough to be free, short enough to matter. */
const DEFAULT_MIN_GAP = 240;

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * One sentinel per project, shared by every trigger.
 *
 * The command is wired to more than one hook event, and they fire at wildly
 * different rates. Keying the gap on the project rather than the event means
 * "at most once per N seconds" holds across all of them, instead of once per
 * N seconds *each*.
 */
function sentinelPath(rootPath: string): string {
  const key = rootPath.replace(/[^a-zA-Z0-9]/g, "-").slice(-80);
  return join(tmpdir(), `pai-autosave-${key}`);
}

function tooRecent(rootPath: string, minGapSeconds: number): boolean {
  const p = sentinelPath(rootPath);
  if (!existsSync(p)) return false;
  try {
    return Date.now() - statSync(p).mtimeMs < minGapSeconds * 1000;
  } catch {
    return false;
  }
}

function touchSentinel(rootPath: string): void {
  try {
    writeFileSync(sentinelPath(rootPath), String(Date.now()), "utf8");
  } catch {
    // Best-effort — a missing sentinel only costs an extra write.
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function cmdAutosave(db: Database, opts: AutosaveOptions): void {
  const minGap = parseInt(opts.minGap ?? String(DEFAULT_MIN_GAP), 10);
  const cwd = process.cwd();

  const project = resolveProjectByCwd(db, cwd) as ProjectRow | undefined;
  if (!project) process.exit(0);

  if (!opts.dryRun && tooRecent(project.root_path, minGap)) process.exit(0);

  // The transcript lives in the Claude Code project directory, which the
  // registry already records as encoded_dir. Passing the session id matters:
  // it selects this session's transcript — both halves of it — rather than
  // whichever file happens to be newest.
  // The registry's encoded_dir is a hint, not an answer — it goes stale when a
  // project moves and silently disables capture. See resolveTranscriptDir.
  const transcriptPaths = findTranscripts(
    resolveTranscriptDir(project),
    opts.sessionId
  );

  const body = buildAutosaveBody({ cwd, transcriptPaths });
  // Nothing worth recording — leave whatever is already there alone.
  if (!body) process.exit(0);

  const session = db
    .prepare(
      "SELECT * FROM sessions WHERE project_id = ? ORDER BY number DESC LIMIT 1"
    )
    .get(project.id) as SessionRow | undefined;

  const result = applyContinue({
    rootPath: project.root_path,
    authored: "auto",
    sessionLine: resolveSessionLine(project, session, resolveNotePath(project)),
    sessionId: opts.sessionId,
    cwd,
    body,
    dryRun: opts.dryRun,
  });

  if (opts.dryRun) {
    console.log(result.block);
    console.log(`\n[dry-run] action would be: ${result.action}`);
    process.exit(0);
  }

  touchSentinel(project.root_path);
  process.exit(0);
}
