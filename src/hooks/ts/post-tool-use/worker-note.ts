#!/usr/bin/env node

/**
 * worker-note.ts — PostToolUse (all tools)
 *
 * Worker-only (PAI_WORKER=1 with a job id: PAI_WORKER_ID, or the pool slot's current job): puts every `pai worker goal`
 * note that arrived since the last tool call into the worker's conversation
 * as additionalContext, once per note. A no-op in interactive sessions.
 */

import { readFileSync } from "node:fs";
import { readWorkersSection } from "../../../workers/config.js";
import { noteContext, takePendingNotes } from "../../../workers/note-delivery.js";
import { workersLogDir } from "../../../workers/paths.js";
import { currentWorkerId } from "../../../workers/worker-id.js";
import { recordLoopResult } from "../lib/loop-guard.js";
import { loadLoopState, loopStateFile, saveLoopState } from "../lib/loop-guard-state.js";
import { isWorkerSession } from "../lib/worker-session.js";

/** Feeds the tool result into the loop guard's repeated-result count. */
function recordResult(raw: string, logDir: string, id: string): void {
  try {
    const j = JSON.parse(raw) as { tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown };
    if (!j.tool_name) return;
    const file = loopStateFile(logDir, id);
    const state = loadLoopState(file);
    const next = recordLoopResult(state, j.tool_name, j.tool_name === "Bash" ? (j.tool_input?.command as string | undefined) : j.tool_input, j.tool_response);
    if (next !== state) saveLoopState(file, next);
  } catch {
    // result tracking is best effort
  }
}

function readStdin(): string {
  try {
    return process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(): void {
  const logDir = process.argv[2] || workersLogDir(readWorkersSection().workers);
  const id = currentWorkerId(process.env, logDir);
  if (!isWorkerSession() || !id) return;
  recordResult(readStdin(), logDir, id);
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
