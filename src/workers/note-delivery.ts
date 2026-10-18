/**
 * note-delivery.ts — hand `pai worker goal` notes to the running worker.
 *
 * `goal` only stores the note in the status file; nothing reads it back into
 * the worker's conversation. The PostToolUse hook (hooks/ts/post-tool-use/
 * worker-note.ts) calls takePendingNotes after every tool call: each note is
 * returned exactly once and the delivery time is recorded for `pai worker ps`.
 */

import { loadStatus, nowStamp, saveStatus } from "./status.js";

/** The pending notes of a worker, cleared and stamped as delivered; null when there are none. */
export function takePendingNotes(logDir: string, id: string, d: Date = new Date()): string[] | null {
  const status = loadStatus(logDir, id);
  if (!status?.notePending?.length) return null;
  const notes = status.notePending;
  status.notePending = [];
  status.noteDeliveredAt = nowStamp(d);
  saveStatus(logDir, status, d, true);
  return notes;
}

/** The additionalContext text for the delivered notes. */
export function noteContext(notes: string[]): string {
  return notes.map((n) => `Operator note (pai worker goal): ${n}`).join("\n");
}
