/**
 * TODO.md management — creation, task updates, checkpoints, and Continue section.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { findTodoPath } from './paths.js';
import { applyContinue } from '../../../../session/checkpoint-block.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Task item for TODO.md. */
export interface TodoItem {
  content: string;
  completed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ensure TODO.md exists. Creates it with default structure if missing.
 * Returns the path to the TODO.md file.
 */
export function ensureTodoMd(cwd: string): string {
  const todoPath = findTodoPath(cwd);

  if (!existsSync(todoPath)) {
    const parentDir = join(todoPath, '..');
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

    const content = `# TODO

## Current Session

- [ ] (Tasks will be tracked here)

## Backlog

- [ ] (Future tasks)

---

*Last updated: ${new Date().toISOString()}*
`;

    writeFileSync(todoPath, content);
    console.error(`Created TODO.md: ${todoPath}`);
  }

  return todoPath;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Update TODO.md with current session tasks.
 * Preserves the Backlog section and ensures exactly ONE timestamp at the end.
 */
export function updateTodoMd(cwd: string, tasks: TodoItem[], sessionSummary?: string): void {
  const todoPath = ensureTodoMd(cwd);
  const content = readFileSync(todoPath, 'utf-8');

  const backlogMatch = content.match(/## Backlog[\s\S]*?(?=\n---|\n\*Last updated|$)/);
  const backlogSection = backlogMatch
    ? backlogMatch[0].trim()
    : '## Backlog\n\n- [ ] (Future tasks)';

  const taskLines = tasks.length > 0
    ? tasks.map(t => `- [${t.completed ? 'x' : ' '}] ${t.content}`).join('\n')
    : '- [ ] (No active tasks)';

  const newContent = `# TODO

## Current Session

${taskLines}

${sessionSummary ? `**Session Summary:** ${sessionSummary}\n\n` : ''}${backlogSection}

---

*Last updated: ${new Date().toISOString()}*
`;

  writeFileSync(todoPath, newContent);
  console.error(`Updated TODO.md: ${todoPath}`);
}

/**
 * Add a checkpoint entry to TODO.md (without replacing tasks).
 * Ensures exactly ONE timestamp line at the end.
 */
export function addTodoCheckpoint(cwd: string, checkpoint: string): void {
  const todoPath = ensureTodoMd(cwd);
  let content = readFileSync(todoPath, 'utf-8');

  // Remove ALL existing timestamp lines and trailing separators
  content = content.replace(/(\n---\s*)*(\n\*Last updated:.*\*\s*)+$/g, '');

  const checkpointText = `\n**Checkpoint (${new Date().toISOString()}):** ${checkpoint}\n\n`;

  const backlogIndex = content.indexOf('## Backlog');
  if (backlogIndex !== -1) {
    content = content.substring(0, backlogIndex) + checkpointText + content.substring(backlogIndex);
  } else {
    const continueIndex = content.indexOf('## Continue');
    if (continueIndex !== -1) {
      const afterContinue = content.indexOf('\n---', continueIndex);
      if (afterContinue !== -1) {
        const insertAt = afterContinue + 4;
        content = content.substring(0, insertAt) + '\n' + checkpointText + content.substring(insertAt);
      } else {
        content = content.trimEnd() + '\n' + checkpointText;
      }
    } else {
      content = content.trimEnd() + '\n' + checkpointText;
    }
  }

  content = content.trimEnd() + `\n\n---\n\n*Last updated: ${new Date().toISOString()}*\n`;

  writeFileSync(todoPath, content);
  console.error(`Checkpoint added to TODO.md`);
}

/**
 * The Claude Code session UUID, read off the transcript path.
 *
 * Claude Code names a transcript `<session-uuid>.jsonl`, so the hooks that
 * receive a transcript path are holding the session's identity without knowing
 * it. Both session-end writers had one available and neither used it.
 *
 * Shape-checked rather than trusted: only a UUID is returned, so a renamed,
 * archived or otherwise unexpected filename yields undefined and the caller
 * falls back to the session line rather than writing a `session-id` that
 * identifies nothing. A wrong id is worse than none — it would make two
 * different sessions compare equal.
 */
export function sessionIdFromTranscript(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined;
  const base = basename(transcriptPath).replace(/\.jsonl$/, '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base)
    ? base
    : undefined;
}

/**
 * Update the ## Continue section at the top of TODO.md.
 *
 * This is the unattended writer: the pre-compact hook and the daemon's
 * work-queue worker both come through here. It used to build its own block and
 * strip the existing section with `/## Continue\n[\s\S]*?\n---\n+/` — a
 * non-greedy match to the first `---`, which cuts a rich checkpoint in half at
 * the first horizontal rule inside its body and leaves the remainder orphaned
 * in the document.
 *
 * More importantly it was the writer that actually destroyed model-authored
 * checkpoints: `pai pause` wrote one, then this ran seconds later on session
 * end and replaced it with `Working directory: … Check the latest session note
 * for details.`
 *
 * It now delegates to the shared checkpoint module in "auto" mode, which means
 * it inherits the preservation rules rather than reimplementing them. Guarding
 * here rather than at each of the three call sites is deliberate: any future
 * caller inherits the behaviour without knowing it exists.
 */
export function updateTodoContinue(
  cwd: string,
  noteFilename: string,
  state: string | null,
  tokenDisplay: string,
  /**
   * The Claude Code session UUID, when the caller knows it.
   *
   * Optional only because a caller may genuinely not have it; supply it
   * whenever you can. Without it `isSameSession` falls back to comparing the
   * note FILENAME, and pausing renames the note — so a session stops
   * recognising its own checkpoint seconds after writing it, and an automated
   * write is then free to replace it as though it belonged to a predecessor.
   * That is how a live session lost a model-authored handover on 2026-08-04.
   */
  sessionId?: string
): void {
  // Ensure a TODO.md exists so applyContinue writes to the same file the rest
  // of the hooks lib uses.
  ensureTodoMd(cwd);

  const result = applyContinue({
    rootPath: cwd,
    authored: 'auto',
    // The hooks identify a session by its note filename; `pai pause` resolves
    // the same string from the registry (and falls back to this filename when
    // the registry has no session row). They must agree, because this string
    // is the key that decides whether an authored checkpoint belongs to the
    // current session and must be preserved.
    sessionLine: noteFilename.replace(/\.md$/, ''),
    // The UUID is authoritative when present; the line above is the fallback
    // for callers that cannot supply one, and it is mutable by design.
    sessionId,
    cwd,
    body: state?.trim() || undefined,
  });

  if (result.action === 'preserved') {
    console.error(
      'TODO.md ## Continue left intact — authored checkpoint for this session'
    );
    return;
  }

  if (result.action === 'failed') {
    console.error(`TODO.md ## Continue update failed: ${result.error}`);
    return;
  }

  // Refresh the trailing "Last updated" stamp without disturbing the block.
  try {
    const todoPath = result.path!;
    const now = new Date().toISOString();
    let content = readFileSync(todoPath, 'utf-8');
    content = content.replace(/(\n---\s*)*(\n\*Last updated:.*\*\s*)+$/g, '');
    content = content.trimEnd() + `\n\n---\n\n*Last updated: ${now}*\n`;
    writeFileSync(todoPath, content);
  } catch {
    // Non-fatal — the checkpoint itself is already written.
  }

  console.error(
    result.carriedForward
      ? 'TODO.md ## Continue section updated (previous content carried forward)'
      : 'TODO.md ## Continue section updated'
  );
}
