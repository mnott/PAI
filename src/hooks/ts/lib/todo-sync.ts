/**
 * TODO.md section handling for the TodoWrite sync hook.
 *
 * Only the "## Current Session" section is managed; every other byte of the
 * file (preamble, other sections, blank lines between them) is kept as is.
 */

import { writeFileSync, renameSync, unlinkSync } from 'fs';
import { dirname, join, basename } from 'path';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

const MANAGED_HEADING = /^## Current Session[ \t]*$/;
const FOOTER = /(\n---[ \t\r\n]*)?(\n\*Last updated:[^\n]*\*[ \t\r\n]*)?$/;

/** Format current session todos as markdown. */
export function formatSessionTodos(todos: TodoItem[]): string {
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
 * Split into a preamble (text before the first "## " heading, possibly empty)
 * and sections, each starting at its "## " line. Concatenating them
 * reproduces the input exactly.
 */
function splitSections(content: string): { preamble: string; sections: string[] } {
  const starts: number[] = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) starts.push(offset);
    offset += line.length + 1;
  }
  if (starts.length === 0) return { preamble: content, sections: [] };
  const sections = starts.map((s, i) => content.slice(s, starts[i + 1] ?? content.length));
  return { preamble: content.slice(0, starts[0]), sections };
}

/** Build the new TODO.md, replacing only the Current Session section. */
export function buildTodoContent(todos: TodoItem[], existingContent: string, now = new Date().toISOString()): string {
  const body = existingContent.replace(FOOTER, '');
  const managed = `## Current Session\n\n${formatSessionTodos(todos)}`;
  const { preamble, sections } = splitSections(body);

  let out: string;
  const idx = sections.findIndex(s => MANAGED_HEADING.test(s.split('\n', 1)[0]));
  if (idx >= 0) {
    // Keep the separator that followed the old managed section.
    const old = sections[idx];
    const trailing = old.slice(old.trimEnd().length);
    const replaced = sections.slice();
    replaced[idx] = managed.trimEnd() + (idx < sections.length - 1 ? (trailing.length > 1 ? trailing : '\n\n') : '\n');
    out = preamble + replaced.join('');
  } else if (body.trim() === '') {
    out = `# TODO\n\n${managed}`;
  } else {
    // No managed section yet: put it first, after the title if there is one.
    const titleEnd = /^# [^\n]*\n\n?/.exec(preamble);
    const head = titleEnd ? preamble.slice(0, titleEnd[0].length) : '';
    const rest = preamble.slice(head.length);
    out = head + managed + rest + sections.join('');
  }

  if (!out.endsWith('\n')) out += '\n';
  return `${out}\n---\n\n*Last updated: ${now}*\n`;
}

/** Fix malformed headings: Remove --- prefix from headings (---# → #). */
export function fixMalformedHeadings(content: string): string {
  return content.replace(/^---#/gm, '#');
}

/** Write via temp file + rename so a crash never leaves a truncated file. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}
