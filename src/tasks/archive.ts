/**
 * archive.ts — keep the conversation that happened on a task.
 *
 * A task's comment thread is where the actual thinking ends up: a question,
 * the answer, the correction, the reason a decision went the way it did. When
 * the task is completed that thread stops being visible — it is not deleted,
 * but it leaves every list anyone looks at, and it lives in a tracker rather
 * than in the project it was about. Six months later the decision is
 * unrecoverable from the place you would look for it.
 *
 * So on completion the thread is written into the owning project's notes, where
 * the rest of that project's knowledge already is and where the memory indexer
 * will pick it up.
 *
 * One file per task, rewritten in full each time rather than appended to. The
 * whole thread is fetched on every archive, so rewriting is naturally
 * idempotent: archiving twice produces the same file, and a recurring task
 * accumulates its history in one place instead of scattering a note per
 * occurrence. Appending would need duplicate detection, and duplicate detection
 * is where this would grow a bug.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Task } from "./types.js";

export interface ArchiveComment {
  id: string;
  content: string;
  postedAt?: string;
}

export interface ArchiveResult {
  path: string;
  /** False when the file already held exactly this content. */
  written: boolean;
  commentCount: number;
  /** Set when nothing was written and the reason was not "unchanged". */
  skipped?: "no-discussion";
}

/**
 * Filesystem-safe stem for a task, stable across re-archives.
 *
 * The id is included because titles change and two tasks can share one — the
 * id is what makes the path stable, and stability is what makes rewriting
 * idempotent rather than accumulating near-duplicate files.
 */
export function archiveSlug(task: Pick<Task, "id" | "title">): string {
  const title = task.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return title ? `${title} - ${task.id}` : task.id;
}

/** Where a task's thread belongs, given the project root that owns it. */
export function archivePath(projectRoot: string, task: Pick<Task, "id" | "title">): string {
  return join(projectRoot, "Notes", "tasks", `${archiveSlug(task)}.md`);
}

/**
 * Render the task and its thread as a note.
 *
 * The description is included in full. It is usually the runbook or the
 * reasoning, and it is the half of the record that explains why the comments
 * say what they say.
 */
export function renderArchive(
  task: Task,
  comments: ArchiveComment[],
  completedAt: string
): string {
  const out: string[] = [];

  out.push("---");
  out.push(`task_id: ${task.id}`);
  out.push(`title: ${JSON.stringify(task.title)}`);
  if (task.owner.project) out.push(`owner: ${task.owner.project}`);
  if (task.due) out.push(`due: ${task.due}`);
  if (task.recurrence) out.push(`recurrence: ${JSON.stringify(task.recurrence)}`);
  out.push(`completed: ${completedAt}`);
  if (task.sourceUrl) out.push(`source: ${task.sourceUrl}`);
  out.push("---");
  out.push("");
  out.push(`# ${task.title}`);
  out.push("");

  if (task.body.trim()) {
    out.push("## Task");
    out.push("");
    out.push(task.body.trim());
    out.push("");
  }

  out.push(`## Discussion (${comments.length})`);
  out.push("");

  if (comments.length === 0) {
    // Stated rather than omitted: an empty section says the thread was checked
    // and was empty, where a missing section says nothing at all.
    out.push("_No comments were posted on this task._");
    out.push("");
  } else {
    for (const c of comments) {
      const when = c.postedAt ? c.postedAt.slice(0, 19).replace("T", " ") : "date unknown";
      out.push(`### ${when}`);
      out.push("");
      out.push(c.content.trim());
      out.push("");
    }
  }

  return out.join("\n");
}

/**
 * Write the archive, skipping the write when nothing changed.
 *
 * Returning `written: false` for an unchanged file matters for a recurring
 * task: it is archived on every completion, and rewriting an identical file
 * daily would churn mtimes and make the indexer re-read it for nothing.
 */
export function writeArchive(
  projectRoot: string,
  task: Task,
  comments: ArchiveComment[],
  completedAt: string
): ArchiveResult {
  const path = archivePath(projectRoot, task);

  // Nothing was discussed, so there is nothing to keep. The point of this is to
  // preserve a conversation that completing the task would otherwise bury —
  // where no conversation happened, a file saying so is noise, and enough of it
  // buries the notes that DO carry something. The task itself is not at risk:
  // it stays in the tracker either way.
  if (comments.length === 0) {
    return { path, written: false, commentCount: 0, skipped: "no-discussion" };
  }

  const body = renderArchive(task, comments, completedAt);

  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf-8") === body) {
        return { path, written: false, commentCount: comments.length };
      }
    } catch {
      // Unreadable for any reason — fall through and rewrite rather than
      // treating a read failure as "already up to date".
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf-8");
  return { path, written: true, commentCount: comments.length };
}
