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
import { NOTE_TOKEN_ENV, noteContext, takePendingNotes } from "../../../workers/note-delivery.js";
import { workersLogDir } from "../../../workers/paths.js";
import { currentWorkerId } from "../../../workers/worker-id.js";
import { recordLoopTelemetry } from "../lib/loop-guard-telemetry.js";
import { recordLoopFailure, recordLoopResult } from "../lib/loop-guard.js";
import { loadLoopState, loopStateFile, saveLoopState } from "../lib/loop-guard-state.js";
import { requestLoopStop } from "../../../workers/loop-stop.js";
import { isWorkerSession } from "../lib/worker-session.js";

/** Feeds the tool result into the loop guard's repeated-result count. */
function recordResult(raw: string, logDir: string, id: string): string | undefined {
  try {
    const j = JSON.parse(raw) as { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown; error?: unknown };
    if (!j.tool_name) return;
    const file = loopStateFile(logDir, id);
    const state = loadLoopState(file);
    const input = j.tool_name === "Bash" ? (j.tool_input?.command as string | undefined) : j.tool_input;
    if (j.hook_event_name === "PostToolUseFailure") {
      // a failure that never reached PreToolUse (input validation) is counted here; the 4th identical one is told to stop
      const r = recordLoopFailure(state, j.tool_name, input, j.error ?? j.tool_response);
      if (r.state !== state) saveLoopState(file, r.state);
      recordLoopTelemetry(r, { fallbackText: j.tool_name });
      if (!r.deny) return r.note;
      if (r.stop) requestLoopStop(logDir, id, `${j.tool_name} failed ${r.count} times with the same error`);
      return r.reason;
    }
    const next = recordLoopResult(state, j.tool_name, input, j.tool_response);
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
  const raw = readStdin();
  const loopNote = recordResult(raw, logDir, id);
  const event = raw.includes('"PostToolUseFailure"') ? "PostToolUseFailure" : "PostToolUse";
  // no token, no delivery: a note is never produced without the run's token (notes stay pending)
  const token = process.env[NOTE_TOKEN_ENV];
  const notes = token ? takePendingNotes(logDir, id) : "";
  const context = [loopNote, notes && token ? noteContext(notes, token) : ""].filter(Boolean).join("\n");
  if (!context) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }) + "\n");
}

try {
  main();
} catch {
  // a note that cannot be delivered must never fail the tool call
}
