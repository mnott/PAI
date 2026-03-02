#!/usr/bin/env node
/**
 * sync-todo-to-md.ts
 *
 * PostToolUse hook for TodoWrite that:
 * 1. Syncs Claude's todos to TODO.md "Current Session" section
 * 2. PRESERVES all user-managed sections (Plans, Completed, Backlog, etc.)
 * 3. Adds completed items to the session note
 *
 * IMPORTANT: This hook PRESERVES user content. It only updates "Current Session".
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  findTodoPath,
  findNotesDir,
  getCurrentNotePath,
  addWorkToSessionNote,
  type WorkItem
} from '../lib/project-utils';

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: {
    todos: TodoItem[];
  };
}

/**
 * Format current session todos as markdown
 */
function formatSessionTodos(todos: TodoItem[]): string {
  const inProgress = todos.filter(t => t.status === 'in_progress');
  const pending = todos.filter(t => t.status === 'pending');
  const completed = todos.filter(t => t.status === 'completed');

  let content = '';

  if (inProgress.length > 0) {
    content += `### In Progress\n\n`;
    for (const todo of inProgress) {
      content += `- [ ] **${todo.content}** _(${todo.activeForm})_\n`;
    }
    content += '\n';
  }

  if (pending.length > 0) {
    content += `### Pending\n\n`;
    for (const todo of pending) {
      content += `- [ ] ${todo.content}\n`;
    }
    content += '\n';
  }

  if (completed.length > 0) {
    content += `### Completed\n\n`;
    for (const todo of completed) {
      content += `- [x] ${todo.content}\n`;
    }
    content += '\n';
  }

  if (todos.length === 0) {
    content += `_(No active session tasks)_\n\n`;
  }

  return content;
}

/**
 * Extract all sections from TODO.md EXCEPT "Current Session"
 * These are user-managed sections that should be preserved.
 */
function extractPreservedSections(content: string): string {
  let preserved = '';

  // Match all ## sections that are NOT "Current Session"
  const sectionRegex = /\n(## (?!Current Session)[^\n]+[\s\S]*?)(?=\n## |\n---\n+\*Last updated|$)/g;
  const matches = content.matchAll(sectionRegex);

  for (const match of matches) {
    preserved += match[1];
  }

  return preserved;
}

/**
 * Fix malformed headings: Remove --- prefix from headings (---# → #)
 * Claude sometimes incorrectly merges horizontal rules with headings.
 */
function fixMalformedHeadings(content: string): string {
  return content.replace(/^---#/gm, '#');
}

/**
 * Build new TODO.md preserving user sections
 */
function buildTodoContent(todos: TodoItem[], existingContent: string): string {
  const now = new Date().toISOString();

  // Get all preserved sections (everything except Current Session)
  const preserved = extractPreservedSections(existingContent);

  // Build new content
  let content = `# TODO

## Current Session

${formatSessionTodos(todos)}`;

  // Add preserved sections
  if (preserved.trim()) {
    content += preserved;
  }

  // Ensure we end with exactly one timestamp
  content = content.replace(/(\n---\s*)*(\n\*Last updated:.*\*\s*)*$/, '');
  content += `\n---\n\n*Last updated: ${now}*\n`;

  return content;
}

async function main() {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const stdinData = Buffer.concat(chunks).toString('utf-8');

    if (!stdinData.trim()) {
      console.error('No input received');
      process.exit(0);
    }

    const hookInput: HookInput = JSON.parse(stdinData);

    if (hookInput.tool_name !== 'TodoWrite') {
      process.exit(0);
    }

    const todos = hookInput.tool_input?.todos;

    if (!todos || !Array.isArray(todos)) {
      console.error('No todos in tool input');
      process.exit(0);
    }

    const cwd = hookInput.cwd || process.cwd();

    // Find TODO.md path
    const todoPath = findTodoPath(cwd);

    // Create TODO.md if it doesn't exist
    if (!existsSync(todoPath)) {
      const parentDir = todoPath.replace(/\/[^/]+$/, '');
      mkdirSync(parentDir, { recursive: true });
      console.error(`Creating TODO.md at ${todoPath}`);
    }

    // Read existing content to preserve user sections
    let existingContent = '';
    try {
      existingContent = readFileSync(todoPath, 'utf-8');
    } catch (e) {
      // New file, no content to preserve
    }

    // Build and write new content (with heading fix)
    let newContent = buildTodoContent(todos, existingContent);
    newContent = fixMalformedHeadings(newContent);
    writeFileSync(todoPath, newContent);

    const stats = {
      inProgress: todos.filter(t => t.status === 'in_progress').length,
      pending: todos.filter(t => t.status === 'pending').length,
      completed: todos.filter(t => t.status === 'completed').length
    };
    console.error(`TODO.md synced: ${stats.inProgress} in progress, ${stats.pending} pending, ${stats.completed} completed`);

    // Add completed items to session note (if local Notes/ exists)
    const completedTodos = todos.filter(t => t.status === 'completed');

    if (completedTodos.length > 0) {
      const notesInfo = findNotesDir(cwd);

      if (notesInfo.isLocal) {
        const currentNotePath = getCurrentNotePath(notesInfo.path);

        if (currentNotePath) {
          let noteContent = '';
          try {
            noteContent = readFileSync(currentNotePath, 'utf-8');
          } catch (e) {
            console.error('Could not read session note:', e);
          }

          const newlyCompleted = completedTodos.filter(t => !noteContent.includes(t.content));

          if (newlyCompleted.length > 0) {
            const workItems: WorkItem[] = newlyCompleted.map(t => ({
              title: t.content,
              completed: true
            }));

            addWorkToSessionNote(currentNotePath, workItems);
            console.error(`Added ${newlyCompleted.length} completed item(s) to session note`);
          }
        }
      }
    }

  } catch (error) {
    console.error('sync-todo-to-md error:', error);
  }

  process.exit(0);
}

main();
