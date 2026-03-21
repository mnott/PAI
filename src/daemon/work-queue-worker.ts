/**
 * work-queue-worker.ts — Daemon worker loop for the persistent work queue
 *
 * Runs every 5 seconds to drain the queue.
 * Handles 'session-end' work items by reading the transcript, extracting
 * work summaries, updating the session note, and updating TODO.md.
 * Handles 'session-summary' items by spawning Haiku for AI-powered note generation.
 *
 * Other item types (note-update, todo-update, topic-detect)
 * are stubs — they log and complete immediately, ready for future expansion.
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import {
  dequeue,
  markCompleted,
  markFailed,
  cleanup,
  getStats,
  type WorkItem,
} from "./work-queue.js";

import {
  handleSessionSummary,
  type SessionSummaryPayload,
} from "./session-summary-worker.js";

// Hooks lib imports — resolving through the compiled JS path.
// These are the same utilities used by stop-hook.ts.
import {
  findNotesDir,
  getCurrentNotePath,
  addWorkToSessionNote,
  finalizeSessionNote,
  updateTodoContinue,
  moveSessionFilesToSessionsDir,
  type WorkItem as NoteWorkItem,
} from "../hooks/ts/lib/project-utils/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKER_INTERVAL_MS = 5_000;
const HOUSEKEEPING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Timers (stored so shutdown can clear them)
// ---------------------------------------------------------------------------

let workerTimer: ReturnType<typeof setInterval> | null = null;
let housekeepingTimer: ReturnType<typeof setInterval> | null = null;
let _immediateSignal = false;

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

/** Start the background worker and housekeeping timers. */
export function startWorker(): void {
  process.stderr.write("[work-queue-worker] Starting worker loop.\n");

  workerTimer = setInterval(async () => {
    try {
      await processNextItem();
    } catch (e) {
      process.stderr.write(`[work-queue-worker] Uncaught error in worker loop: ${e}\n`);
    }
  }, WORKER_INTERVAL_MS);

  housekeepingTimer = setInterval(() => {
    try {
      cleanup();
    } catch (e) {
      process.stderr.write(`[work-queue-worker] Housekeeping error: ${e}\n`);
    }
  }, HOUSEKEEPING_INTERVAL_MS);

  process.stderr.write("[work-queue-worker] Worker started (interval=5s, housekeeping=10min).\n");
}

/** Stop the worker timers gracefully. */
export function stopWorker(): void {
  if (workerTimer !== null) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  if (housekeepingTimer !== null) {
    clearInterval(housekeepingTimer);
    housekeepingTimer = null;
  }
  process.stderr.write("[work-queue-worker] Worker stopped.\n");
}

/**
 * Signal that new work has been enqueued.
 * The worker will run on its next tick — we don't need to reset the timer
 * since 5 s is fast enough. The flag allows future optimisations.
 */
export function notifyNewWork(): void {
  _immediateSignal = true;
}

// ---------------------------------------------------------------------------
// Item processor (sequential — one item per tick)
// ---------------------------------------------------------------------------

async function processNextItem(): Promise<void> {
  const item = dequeue();
  if (!item) return;

  process.stderr.write(
    `[work-queue-worker] Processing ${item.type} (id=${item.id}, attempt=${item.attempts}).\n`
  );

  try {
    switch (item.type) {
      case "session-end":
        await handleSessionEnd(item);
        break;

      case "session-summary":
        await handleSessionSummary(item.payload as SessionSummaryPayload);
        break;

      case "note-update":
      case "todo-update":
      case "topic-detect":
        // Stubs — log and complete
        process.stderr.write(
          `[work-queue-worker] Item type '${item.type}' is not yet implemented — completing as no-op.\n`
        );
        break;

      default:
        throw new Error(`Unknown work item type: ${(item as WorkItem).type}`);
    }

    markCompleted(item.id);
    process.stderr.write(`[work-queue-worker] Completed ${item.type} (id=${item.id}).\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markFailed(item.id, msg);
  }
}

// ---------------------------------------------------------------------------
// session-end handler
// ---------------------------------------------------------------------------

/**
 * Process a 'session-end' work item.
 *
 * Expected payload:
 *   transcriptPath: string   — absolute path to the .jsonl transcript
 *   cwd: string              — working directory of the session
 *   message?: string         — COMPLETED: line extracted by the hook (optional)
 */
async function handleSessionEnd(item: WorkItem): Promise<void> {
  const { transcriptPath, cwd, message: hookMessage } = item.payload as {
    transcriptPath: string;
    cwd: string;
    message?: string;
  };

  if (!transcriptPath) throw new Error("session-end payload missing transcriptPath");
  if (!cwd) throw new Error("session-end payload missing cwd");

  // Read transcript
  let transcript: string;
  try {
    transcript = readFileSync(transcriptPath, "utf-8");
  } catch (e) {
    throw new Error(`Could not read transcript at ${transcriptPath}: ${e}`);
  }

  const lines = transcript.trim().split("\n");

  // Extract work items from transcript
  const workItems = extractWorkFromTranscript(lines);

  // Determine completion message
  let message = hookMessage ?? "";
  if (!message) {
    const lastEntry = tryParseJson(lines[lines.length - 1]);
    if (lastEntry?.type === "assistant" && lastEntry.message?.content) {
      const content = contentToText(lastEntry.message.content);
      const m = content.match(/COMPLETED:\s*(.+?)(?:\n|$)/i);
      if (m) {
        message = m[1].trim().replace(/\*+/g, "").replace(/\[.*?\]/g, "").trim();
      }
    }
  }

  // Find notes directory and current note
  const notesInfo = findNotesDir(cwd);
  const currentNotePath = getCurrentNotePath(notesInfo.path);

  if (currentNotePath) {
    // Add work items to session note
    if (workItems.length > 0) {
      addWorkToSessionNote(currentNotePath, workItems);
      process.stderr.write(
        `[work-queue-worker] Added ${workItems.length} work item(s) to note.\n`
      );
    } else if (message) {
      addWorkToSessionNote(currentNotePath, [{ title: message, completed: true }]);
      process.stderr.write("[work-queue-worker] Added completion message to note.\n");
    }

    // Finalize the note
    const summary = message || "Session completed.";
    finalizeSessionNote(currentNotePath, summary);
    process.stderr.write(
      `[work-queue-worker] Finalized session note: ${basename(currentNotePath)}.\n`
    );

    // Update TODO.md ## Continue section
    try {
      const stateLines: string[] = [];
      stateLines.push(`Working directory: ${cwd}`);
      if (workItems.length > 0) {
        stateLines.push("", "Work completed:");
        for (const wi of workItems.slice(0, 5)) {
          stateLines.push(`- ${wi.title}`);
        }
      }
      if (message) {
        stateLines.push("", `Last completed: ${message}`);
      }
      updateTodoContinue(cwd, basename(currentNotePath), stateLines.join("\n"), "session-end");
    } catch (todoError) {
      // Non-fatal — log and continue
      process.stderr.write(
        `[work-queue-worker] Could not update TODO.md: ${todoError}\n`
      );
    }
  } else {
    process.stderr.write(
      "[work-queue-worker] No current session note found — skipping note update.\n"
    );
  }

  // Move session .jsonl files to sessions/ subdirectory
  try {
    const transcriptDir = dirname(transcriptPath);
    const movedCount = moveSessionFilesToSessionsDir(transcriptDir);
    if (movedCount > 0) {
      process.stderr.write(
        `[work-queue-worker] Moved ${movedCount} session file(s) to sessions/.\n`
      );
    }
  } catch (moveError) {
    // Non-fatal
    process.stderr.write(`[work-queue-worker] Could not move session files: ${moveError}\n`);
  }
}

// ---------------------------------------------------------------------------
// Transcript parsing helpers (mirrors stop-hook.ts logic)
// ---------------------------------------------------------------------------

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        const block = c as Record<string, unknown>;
        if (block?.text) return String(block.text);
        if (block?.content) return String(block.content);
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

function extractWorkFromTranscript(lines: string[]): NoteWorkItem[] {
  const workItems: NoteWorkItem[] = [];
  const seenSummaries = new Set<string>();

  for (const line of lines) {
    const entry = tryParseJson(line);
    if (!entry || entry.type !== "assistant") continue;

    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg?.content) continue;

    const content = contentToText(msg.content);

    // SUMMARY: line (preferred)
    const summaryMatch = content.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
    if (summaryMatch) {
      const summary = summaryMatch[1].trim();
      if (summary && !seenSummaries.has(summary) && summary.length > 5) {
        seenSummaries.add(summary);

        const details: string[] = [];
        const actionsMatch = content.match(/ACTIONS:\s*(.+?)(?=\n[A-Z]+:|$)/is);
        if (actionsMatch) {
          const actionLines = actionsMatch[1]
            .split("\n")
            .map((l) =>
              l.replace(/^[-*•]\s*/, "").replace(/^\d+\.\s*/, "").trim()
            )
            .filter((l) => l.length > 3 && l.length < 100);
          details.push(...actionLines.slice(0, 3));
        }

        workItems.push({
          title: summary,
          details: details.length > 0 ? details : undefined,
          completed: true,
        });
      }
    }

    // COMPLETED: line (fallback)
    const completedMatch = content.match(/COMPLETED:\s*(.+?)(?:\n|$)/i);
    if (completedMatch && workItems.length === 0) {
      const completed = completedMatch[1]
        .trim()
        .replace(/\*+/g, "")
        .replace(/\[.*?\]/g, "")
        .trim();
      if (completed && !seenSummaries.has(completed) && completed.length > 5) {
        seenSummaries.add(completed);
        workItems.push({ title: completed, completed: true });
      }
    }
  }

  return workItems;
}
