#!/usr/bin/env node

/**
 * worker-note.ts — PostToolUse (all tools)
 *
 * Worker-only (PAI_WORKER=1 with PAI_WORKER_ID): puts every `pai worker goal`
 * note that arrived since the last tool call into the worker's conversation
 * as additionalContext, once per note. A no-op in interactive sessions.
 */

import { readWorkersSection } from "../../../workers/config.js";
import { noteContext, takePendingNotes } from "../../../workers/note-delivery.js";
import { workersLogDir } from "../../../workers/paths.js";
import { isWorkerSession } from "../lib/worker-session.js";

function main(): void {
  const id = process.env.PAI_WORKER_ID;
  if (!isWorkerSession() || !id) return;
  const notes = takePendingNotes(process.argv[2] || workersLogDir(readWorkersSection().workers), id);
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
