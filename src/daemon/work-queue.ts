/**
 * work-queue.ts — Persistent work queue for the PAI Daemon
 *
 * Provides a durable, file-backed queue that survives daemon restarts.
 * Items are processed sequentially to avoid concurrent writes to the same
 * session note. Failed items are retried with exponential backoff.
 *
 * Queue file: ~/.config/pai/work-queue.json
 * Written atomically (write temp → rename) to prevent corruption.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkItemType =
  | "session-end"
  | "session-summary"
  | "note-update"
  | "todo-update"
  | "topic-detect";

export type WorkItemStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export interface WorkItem {
  id: string;
  type: WorkItemType;
  priority: number;       // 1=high, 5=low
  payload: Record<string, unknown>;
  status: WorkItemStatus;
  createdAt: string;      // ISO timestamp
  attempts: number;
  maxAttempts: number;    // default 3
  nextRetryAt?: string;   // ISO timestamp — undefined means ready now
  error?: string;         // last error message
  completedAt?: string;   // ISO timestamp
}

export interface WorkQueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_FILE = join(homedir(), ".config", "pai", "work-queue.json");
const MAX_QUEUE_SIZE = 1000;
const MAX_QUEUE_FILE_BYTES = 1024 * 1024; // 1 MB
const COMPLETED_TTL_MS = 60 * 60 * 1000;           // 1 hour
const FAILED_TTL_MS = 24 * 60 * 60 * 1000;         // 24 hours

/** Backoff delays in ms by attempt number (0-indexed). */
const BACKOFF_MS = [
  5_000,    // attempt 1 → wait 5 s
  30_000,   // attempt 2 → wait 30 s
  300_000,  // attempt 3 → wait 5 min
];

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let _queue: WorkItem[] = [];
let _dirty = false;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/** Load queue from disk. Call once at daemon startup. */
export function loadQueue(): void {
  if (!existsSync(QUEUE_FILE)) {
    _queue = [];
    return;
  }

  try {
    const raw = readFileSync(QUEUE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as WorkItem[];
    if (!Array.isArray(parsed)) {
      process.stderr.write("[work-queue] Invalid queue file format — starting empty.\n");
      _queue = [];
      return;
    }

    // On restart, reset any 'processing' items back to 'pending' — they
    // were interrupted mid-flight and need to be retried.
    _queue = parsed.map((item) => {
      if (item.status === "processing") {
        return { ...item, status: "pending" as WorkItemStatus };
      }
      return item;
    });

    const stats = getStats();
    process.stderr.write(
      `[work-queue] Loaded ${_queue.length} items from disk ` +
      `(pending=${stats.pending}, failed=${stats.failed}).\n`
    );
  } catch (e) {
    process.stderr.write(`[work-queue] Could not load queue file: ${e}\n`);
    _queue = [];
  }
}

/** Persist queue to disk atomically. */
export function saveQueue(): void {
  const dir = dirname(QUEUE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpFile = QUEUE_FILE + ".tmp";
  try {
    writeFileSync(tmpFile, JSON.stringify(_queue, null, 2), "utf-8");
    renameSync(tmpFile, QUEUE_FILE);
    _dirty = false;
  } catch (e) {
    process.stderr.write(`[work-queue] Could not persist queue: ${e}\n`);
  }
}

/** Persist only if there are unsaved changes. */
function saveIfDirty(): void {
  if (_dirty) saveQueue();
}

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------

/**
 * Enforce the maximum queue size cap.
 * Strategy: first drop oldest completed, then oldest low-priority pending.
 */
function enforceMaxSize(): void {
  if (_queue.length <= MAX_QUEUE_SIZE) return;

  const excess = _queue.length - MAX_QUEUE_SIZE;

  // Step 1: drop oldest completed items
  const completed = _queue
    .filter((i) => i.status === "completed")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const toDropCompleted = completed.slice(0, excess);
  const dropIds = new Set(toDropCompleted.map((i) => i.id));
  _queue = _queue.filter((i) => !dropIds.has(i.id));

  if (_queue.length <= MAX_QUEUE_SIZE) return;

  // Step 2: drop oldest low-priority pending items (priority 4-5)
  const remainingExcess = _queue.length - MAX_QUEUE_SIZE;
  const lowPriorityPending = _queue
    .filter((i) => i.status === "pending" && i.priority >= 4)
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));

  const toDropLow = lowPriorityPending.slice(0, remainingExcess);
  const dropLowIds = new Set(toDropLow.map((i) => i.id));
  _queue = _queue.filter((i) => !dropLowIds.has(i.id));

  process.stderr.write(
    `[work-queue] Pruned queue to ${_queue.length} items (cap=${MAX_QUEUE_SIZE}).\n`
  );
}

/**
 * Add a new work item to the queue.
 * Returns the created WorkItem.
 */
export function enqueue(params: {
  type: WorkItemType;
  priority?: number;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}): WorkItem {
  const item: WorkItem = {
    id: randomUUID(),
    type: params.type,
    priority: params.priority ?? 3,
    payload: params.payload,
    status: "pending",
    createdAt: new Date().toISOString(),
    attempts: 0,
    maxAttempts: params.maxAttempts ?? 3,
  };

  _queue.push(item);
  enforceMaxSize();
  _dirty = true;
  saveIfDirty();

  process.stderr.write(
    `[work-queue] Enqueued ${item.type} (id=${item.id}, priority=${item.priority}).\n`
  );

  return item;
}

/**
 * Pick the next pending item that is ready to process (respects nextRetryAt).
 * Returns null if no eligible item exists.
 * Highest priority (lowest number) is processed first; ties broken by createdAt.
 */
export function dequeue(): WorkItem | null {
  const now = new Date().toISOString();

  const eligible = _queue
    .filter((i) => {
      if (i.status !== "pending") return false;
      if (i.nextRetryAt && i.nextRetryAt > now) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.createdAt.localeCompare(b.createdAt);
    });

  if (eligible.length === 0) return null;

  const item = eligible[0];
  item.status = "processing";
  item.attempts += 1;
  _dirty = true;
  saveIfDirty();

  return item;
}

/** Peek at the next eligible pending item without changing its status. */
export function peek(): WorkItem | null {
  const now = new Date().toISOString();

  return (
    _queue
      .filter((i) => {
        if (i.status !== "pending") return false;
        if (i.nextRetryAt && i.nextRetryAt > now) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt.localeCompare(b.createdAt);
      })[0] ?? null
  );
}

/**
 * Mark an item as completed.
 */
export function markCompleted(id: string): void {
  const item = _queue.find((i) => i.id === id);
  if (!item) return;
  item.status = "completed";
  item.completedAt = new Date().toISOString();
  item.error = undefined;
  _dirty = true;
  saveIfDirty();
}

/**
 * Mark an item as failed.
 * If attempts < maxAttempts, schedules a retry with exponential backoff.
 * Otherwise, leaves status as 'failed'.
 */
export function markFailed(id: string, errorMsg: string): void {
  const item = _queue.find((i) => i.id === id);
  if (!item) return;

  item.error = errorMsg;

  if (item.attempts < item.maxAttempts) {
    const backoffMs = BACKOFF_MS[item.attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    item.status = "pending";
    item.nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    process.stderr.write(
      `[work-queue] Item ${id} failed (attempt ${item.attempts}/${item.maxAttempts}), ` +
      `retry in ${backoffMs / 1000}s: ${errorMsg}\n`
    );
  } else {
    item.status = "failed";
    process.stderr.write(
      `[work-queue] Item ${id} exhausted retries (${item.maxAttempts} attempts): ${errorMsg}\n`
    );
  }

  _dirty = true;
  saveIfDirty();
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function getStats(): WorkQueueStats {
  const stats: WorkQueueStats = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    total: _queue.length,
  };
  for (const item of _queue) {
    stats[item.status as keyof Omit<WorkQueueStats, "total">]++;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Remove completed and permanently-failed items older than their TTL.
 * Also force-cleans all completed items if the queue file exceeds 1 MB.
 */
export function cleanup(): void {
  const now = Date.now();
  const before = _queue.length;

  // Check file size for force-clean
  let forceCleanCompleted = false;
  try {
    if (existsSync(QUEUE_FILE)) {
      const { size } = statSync(QUEUE_FILE);
      if (size > MAX_QUEUE_FILE_BYTES) {
        forceCleanCompleted = true;
        process.stderr.write(
          `[work-queue] Queue file exceeds 1 MB (${size} bytes) — force-cleaning completed items.\n`
        );
      }
    }
  } catch {
    // non-fatal
  }

  _queue = _queue.filter((item) => {
    if (item.status === "completed") {
      if (forceCleanCompleted) return false;
      const completedMs = item.completedAt ? new Date(item.completedAt).getTime() : 0;
      return now - completedMs < COMPLETED_TTL_MS;
    }
    if (item.status === "failed") {
      const createdMs = new Date(item.createdAt).getTime();
      return now - createdMs < FAILED_TTL_MS;
    }
    return true;
  });

  const removed = before - _queue.length;
  const stats = getStats();

  if (removed > 0 || before === 0) {
    process.stderr.write(
      `[work-queue] Cleanup: removed ${removed} items. ` +
      `Queue stats: pending=${stats.pending}, processing=${stats.processing}, ` +
      `completed=${stats.completed}, failed=${stats.failed}.\n`
    );
  }

  _dirty = removed > 0;
  saveIfDirty();
}
