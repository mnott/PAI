/**
 * Session handover command — writes a ## Continue section to the project's
 * TODO.md. Called from the session-stop and pre-compact hooks.
 *
 * PRESERVATION
 * ------------
 * This runs on every clean exit and before every compaction, unattended. It
 * used to regenerate a generic four-line block and strip whatever ## Continue
 * was already there — which meant a model-authored checkpoint written seconds
 * earlier by `pai pause` was destroyed by /exit.
 *
 * It now writes in "auto" mode: an authored checkpoint describing the *same*
 * session is left alone. One from an earlier session is stale and gets
 * replaced, so TODO.md never points at the wrong session.
 *
 * Still exits 0 on every path — this must never interrupt Claude Code.
 */

import type { Database } from "better-sqlite3";
import type { SessionRow, ProjectRow } from "./types.js";
import { applyContinue } from "../../../session/checkpoint-block.js";
import {
  resolveSessionLine,
  resolveNotePath,
  resolveProjectByCwd,
} from "./pause.js";
import {
  findTranscripts,
  buildAutosaveBody,
  resolveTranscriptDir,
} from "../../../session/autosave.js";

/**
 * Reconstruct a resumable digest for a session that is stopping.
 *
 * Best-effort by construction: this runs from a hook on every exit, so a failure
 * to read the transcript must degrade to an empty body — which the checkpoint
 * writer now treats as "do not overwrite what is already there" — rather than
 * throw and interrupt Claude Code.
 */
function buildStopBody(project: ProjectRow, sessionId?: string): string {
  try {
    const transcriptPaths = findTranscripts(resolveTranscriptDir(project), sessionId);
    return buildAutosaveBody({ cwd: process.cwd(), transcriptPaths });
  } catch {
    return "";
  }
}

export function cmdHandover(
  db: Database,
  projectSlug: string | undefined,
  numberOrLatest: string | undefined,
  sessionId?: string
): void {
  // ---- 1. Resolve project ----
  let project: ProjectRow | undefined;

  if (projectSlug) {
    project = db
      .prepare(
        "SELECT id, slug, display_name, root_path, encoded_dir FROM projects WHERE slug = ?"
      )
      .get(projectSlug) as ProjectRow | undefined;
    if (!project) process.exit(0);
  } else {
    // Same resolver as `pai pause` — including the realpath fallback, so a
    // session started via a symlinked path prefix resolves to the same project
    // rather than silently finding nothing.
    const row = resolveProjectByCwd(db, process.cwd());
    if (!row) process.exit(0);
    project = row;
  }

  // ---- 2. Resolve session ----
  let session: SessionRow | undefined;
  const nol = numberOrLatest ?? "latest";

  if (nol === "latest") {
    session = db
      .prepare(
        "SELECT * FROM sessions WHERE project_id = ? ORDER BY number DESC LIMIT 1"
      )
      .get(project!.id) as SessionRow | undefined;
  } else {
    const num = parseInt(nol, 10);
    if (!isNaN(num)) {
      session = db
        .prepare("SELECT * FROM sessions WHERE project_id = ? AND number = ?")
        .get(project!.id, num) as SessionRow | undefined;
    }
  }

  // ---- 3. Write, preserving any authored checkpoint for this session ----
  //
  // The session line must be derived exactly as `pai pause` derives it — it is
  // the fallback preservation key, and deriving it independently here is what
  // let this command clobber a checkpoint written seconds earlier.
  //
  // The line alone is not enough. By the time this runs, `session-stop.sh` has
  // already executed `session slug --apply` and `session cleanup --execute`,
  // both of which rewrite the session note filename the line is derived from.
  // The UUID is passed through precisely because it survives that.
  // A body, not just a pointer. This used to write metadata only, on the
  // assumption that the session note holds the real content — but the note is
  // written by a different path that can fail or never run at all, and when it
  // does the checkpoint names a file that does not exist. Reconstructing the
  // same digest the autosave writes (recent prompts + working tree) costs one
  // transcript read and means a stop-hook handover always carries something
  // resumable on its own.
  applyContinue({
    rootPath: project!.root_path,
    authored: "auto",
    sessionLine: resolveSessionLine(project!, session, resolveNotePath(project!)),
    sessionId,
    cwd: process.cwd(),
    body: buildStopBody(project!, sessionId),
  });

  process.exit(0);
}
