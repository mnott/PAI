/**
 * note-delivery.ts — hand `pai worker goal` notes to the running worker.
 *
 * `goal` only stores the note in the status file; nothing reads it back into
 * the worker's conversation. The PostToolUse hook (hooks/ts/post-tool-use/
 * worker-note.ts) calls takePendingNotes after every tool call: each note is
 * returned exactly once and the delivery time is recorded for `pai worker ps`.
 */

import { randomBytes } from "node:crypto";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { loadStatus, nowStamp, saveStatus } from "./status.js";

/** The pending notes of a worker, cleared and stamped as delivered; null when there are none. */
export function takePendingNotes(logDir: string, id: string, d: Date = new Date()): string[] | null {
  const status = loadStatus(logDir, id);
  if (!status?.notePending?.length) return null;
  const notes = status.notePending;
  status.notePending = [];
  status.noteDeliveredAt = nowStamp(d);
  saveStatus(logDir, status, d, true);
  appendLedger(ledgerPath(logDir), "WORKER-NOTE-DELIVERED", { id, count: notes.length }, d);
  return notes;
}

/** Env var carrying the per-run note token from the runner to the worker's hooks. */
export const NOTE_TOKEN_ENV = "PAI_WORKER_NOTE_TOKEN";

/** A fresh random per-run token (8 hex chars). */
export function newNoteToken(): string {
  return randomBytes(4).toString("hex");
}

/** The additionalContext text for the delivered notes, each authenticated with the run's token. */
export function noteContext(notes: string[], token: string): string {
  return notes.map((n) => `PAI note [${token}] from your orchestrator: ${n}`).join("\n");
}
