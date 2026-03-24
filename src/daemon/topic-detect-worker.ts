/**
 * topic-detect-worker.ts — Topic shift detection for session note splitting
 *
 * Processes `topic-detect` work items by:
 *   1. Extracting recent user messages from the JSONL transcript
 *   2. Running the BM25-based topic shift detector against the PAI memory DB
 *   3. If a shift is detected, recording a topic boundary marker
 *
 * The actual note splitting is handled by session-summary-worker.ts when it
 * processes the next `session-summary` work item — it uses the TOPIC: line
 * from the summarizer to decide whether to create a new note.
 *
 * This worker provides an additional signal: project-level topic shift
 * (e.g., conversation moved from project A to project B). The session
 * summary worker handles intra-project topic shifts (e.g., from "dark mode"
 * to "keyboard IPC" within the same project).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

import { detectTopicShift } from "../topics/detector.js";
import { registryDb, storageBackend } from "./daemon/state.js";
import {
  findNotesDir,
  getCurrentNotePath,
  appendCheckpoint,
} from "../hooks/ts/lib/project-utils/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopicDetectPayload {
  /** Working directory of the session. */
  cwd: string;
  /** Recent conversation context (extracted user messages). */
  context?: string;
  /** The project slug the session is currently routed to. */
  currentProject?: string;
  /** Path to the JSONL transcript (optional — used to extract context if not provided). */
  transcriptPath?: string;
  /** Session ID (for logging). */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// JSONL context extraction (lightweight — just last few user messages)
// ---------------------------------------------------------------------------

const MAX_CONTEXT_MESSAGES = 5;
const MAX_CONTEXT_CHARS = 2000;

/**
 * Extract recent user messages from a JSONL transcript for topic detection.
 * Takes only the last few messages to represent the current topic.
 */
function extractRecentContext(jsonlPath: string): string {
  try {
    const raw = readFileSync(jsonlPath, "utf-8");
    // Read from the end — last 50KB should be more than enough
    const tail = raw.length > 50_000 ? raw.slice(-50_000) : raw;
    const lines = tail.trim().split("\n");

    const messages: string[] = [];

    for (let i = lines.length - 1; i >= 0 && messages.length < MAX_CONTEXT_MESSAGES; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "user") {
          const msg = entry.message as Record<string, unknown> | undefined;
          if (msg?.content) {
            const text = contentToText(msg.content);
            if (text && text.length > 3) {
              messages.unshift(text.slice(0, 500));
            }
          }
        }
      } catch { /* skip invalid JSON */ }
    }

    return messages.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
  } catch {
    return "";
  }
}

/** Convert Claude content (string or content block array) to plain text. */
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

// ---------------------------------------------------------------------------
// Topic boundary file — signals to session-summary-worker
// ---------------------------------------------------------------------------

const TOPIC_BOUNDARY_FILE = "topic-boundary.json";

interface TopicBoundary {
  timestamp: string;
  previousProject: string | null;
  suggestedProject: string | null;
  confidence: number;
  context: string;
}

/**
 * Write a topic boundary marker into the Notes directory.
 * The session-summary-worker checks for this file and uses it as an
 * additional signal that a new note should be created.
 */
function writeTopicBoundary(
  cwd: string,
  boundary: TopicBoundary
): void {
  try {
    const notesInfo = findNotesDir(cwd);
    const boundaryPath = join(notesInfo.path, TOPIC_BOUNDARY_FILE);
    writeFileSync(boundaryPath, JSON.stringify(boundary, null, 2), "utf-8");
    process.stderr.write(
      `[topic-detect] Wrote topic boundary marker: ${boundaryPath}\n`
    );
  } catch (e) {
    process.stderr.write(`[topic-detect] Could not write boundary marker: ${e}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process a `topic-detect` work item.
 *
 * Called by work-queue-worker.ts. Throws on fatal errors so the work queue
 * retry logic handles them.
 */
export async function handleTopicDetect(payload: TopicDetectPayload): Promise<void> {
  const { cwd, currentProject, transcriptPath, sessionId } = payload;

  if (!cwd) {
    throw new Error("topic-detect payload missing cwd");
  }

  process.stderr.write(
    `[topic-detect] Starting for ${cwd}` +
    `${currentProject ? ` (project=${currentProject})` : ""}` +
    `${sessionId ? ` (session=${sessionId})` : ""}\n`
  );

  // Check that daemon state is available
  if (!registryDb || !storageBackend) {
    process.stderr.write(
      "[topic-detect] Registry DB or storage backend not available — skipping.\n"
    );
    return;
  }

  // Extract context from payload or transcript
  let context = payload.context || "";

  if (!context && transcriptPath && existsSync(transcriptPath)) {
    context = extractRecentContext(transcriptPath);
  }

  if (!context || context.trim().length < 10) {
    process.stderr.write(
      "[topic-detect] Insufficient context for topic detection — skipping.\n"
    );
    return;
  }

  process.stderr.write(
    `[topic-detect] Context: ${context.length} chars, checking against memory...\n`
  );

  // Run the BM25-based topic shift detector
  const result = await detectTopicShift(registryDb, storageBackend, {
    context,
    currentProject,
    threshold: 0.6,
    candidates: 20,
  });

  process.stderr.write(
    `[topic-detect] Result: shifted=${result.shifted}, ` +
    `suggested=${result.suggestedProject}, confidence=${result.confidence.toFixed(2)}, ` +
    `chunks=${result.chunkCount}\n`
  );

  if (result.topProjects.length > 0) {
    process.stderr.write(
      `[topic-detect] Top projects: ${result.topProjects.map(
        (p) => `${p.slug}(${(p.score * 100).toFixed(0)}%)`
      ).join(", ")}\n`
    );
  }

  if (result.shifted) {
    // Record the topic boundary
    writeTopicBoundary(cwd, {
      timestamp: new Date().toISOString(),
      previousProject: result.currentProject,
      suggestedProject: result.suggestedProject,
      confidence: result.confidence,
      context: context.slice(0, 200),
    });

    // Also append a checkpoint to the current session note
    try {
      const notesInfo = findNotesDir(cwd);
      const notePath = getCurrentNotePath(notesInfo.path);
      if (notePath) {
        appendCheckpoint(
          notePath,
          `Topic shift detected: conversation moved from **${result.currentProject}** ` +
          `to **${result.suggestedProject}** (confidence: ${(result.confidence * 100).toFixed(0)}%). ` +
          `A new session note will be created for the new topic.`
        );
      }
    } catch (e) {
      process.stderr.write(`[topic-detect] Could not append checkpoint: ${e}\n`);
    }
  }

  process.stderr.write("[topic-detect] Done.\n");
}
