/**
 * TODO.md management — creation, task updates, checkpoints, and Continue section.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { findTodoPath } from './paths.js';

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
 * Update the ## Continue section at the top of TODO.md.
 * Mirrors "pause session" behavior — gives the next session a starting point.
 * Replaces any existing ## Continue section.
 */
export function updateTodoContinue(
  cwd: string,
  noteFilename: string,
  state: string | null,
  tokenDisplay: string
): void {
  const todoPath = ensureTodoMd(cwd);
  let content = readFileSync(todoPath, 'utf-8');

  // Remove existing ## Continue section
  content = content.replace(/## Continue\n[\s\S]*?\n---\n+/, '');

  const now = new Date().toISOString();
  const stateLines = state
    ? state.split('\n').filter(l => l.trim()).slice(0, 10).map(l => `> ${l}`).join('\n')
    : `> Working directory: ${cwd}. Check the latest session note for details.`;

  const continueSection = `## Continue

> **Last session:** ${noteFilename.replace('.md', '')}
> **Paused at:** ${now}
>
${stateLines}

---

`;

  content = content.replace(/^\s+/, '');

  const titleMatch = content.match(/^(# [^\n]+\n+)/);
  if (titleMatch) {
    content = titleMatch[1] + continueSection + content.substring(titleMatch[0].length);
  } else {
    content = continueSection + content;
  }

  content = content.replace(/(\n---\s*)*(\n\*Last updated:.*\*\s*)+$/g, '');
  content = content.trimEnd() + `\n\n---\n\n*Last updated: ${now}*\n`;

  writeFileSync(todoPath, content);
  console.error('TODO.md ## Continue section updated');
}
