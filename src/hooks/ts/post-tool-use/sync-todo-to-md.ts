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

import { isWorkerSession } from "../lib/worker-session.js";
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { buildTodoContent, fixMalformedHeadings, writeFileAtomic, type TodoItem } from '../lib/todo-sync.js';
import {
  findTodoPath,
  findNotesDir,
  getCurrentNotePath,
  addWorkToSessionNote,
  type WorkItem
} from '../lib/project-utils.js';

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: {
    todos: TodoItem[];
  };
}

async function main() {
  if (isWorkerSession()) return; // disposable worker: no per-session bookkeeping
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
      const parentDir = dirname(todoPath);
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
    writeFileAtomic(todoPath, newContent);

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
