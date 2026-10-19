#!/usr/bin/env node

/**
 * worker-note.ts — PostToolUse (all tools)
 *
 * Worker-only (PAI_WORKER=1 with a job id: PAI_WORKER_ID, or the pool slot's current job): puts every `pai worker goal`
 * note that arrived since the last tool call into the worker's conversation
 * as additionalContext, once per note. A no-op in interactive sessions.
 */

import { readWorkersSection } from "../../../workers/config.js";
import { noteContext, takePendingNotes } from "../../../workers/note-delivery.js";
import { workersLogDir } from "../../../workers/paths.js";
import { currentWorkerId } from "../../../workers/worker-id.js";
import { isWorkerSession } from "../lib/worker-session.js";

function main(): void {
  const logDir = process.argv[2] || workersLogDir(readWorkersSection().workers);
  const id = currentWorkerId(process.env, logDir);
  if (!isWorkerSession() || !id) return;
  const notes = takePendingNotes(logDir, id);
  if (!notes) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: noteContext(notes) } }) + "\n",
  );
}

try {
  main();
} catch {
  // a note that cannot be delivered must never fail the tool call
}
