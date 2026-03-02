/**
 * project-utils.ts - Shared utilities for project context management
 *
 * Provides:
 * - Path encoding (matching Claude Code's scheme)
 * - ntfy.sh notifications (mandatory, synchronous)
 * - Session notes management
 * - Session token calculation
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join, basename } from 'path';

// Import from pai-paths which handles .env loading and path resolution
import { PAI_DIR } from './pai-paths.js';

// Re-export PAI_DIR for consumers
export { PAI_DIR };
export const PROJECTS_DIR = join(PAI_DIR, 'projects');

/**
 * Encode a path the same way Claude Code does:
 * - Replace / with -
 * - Replace . with - (hidden directories become --name)
 *
 * This matches Claude Code's internal encoding to ensure Notes
 * are stored in the same project directory as transcripts.
 */
export function encodePath(path: string): string {
  return path
    .replace(/\//g, '-')   // Slashes become dashes
    .replace(/\./g, '-')   // Dots also become dashes
    .replace(/ /g, '-');   // Spaces become dashes (matches Claude Code native encoding)
}

/**
 * Get the project directory for a given working directory
 */
export function getProjectDir(cwd: string): string {
  const encoded = encodePath(cwd);
  return join(PROJECTS_DIR, encoded);
}

/**
 * Get the Notes directory for a project (central location)
 */
export function getNotesDir(cwd: string): string {
  return join(getProjectDir(cwd), 'Notes');
}

/**
 * Find Notes directory - check local first, fallback to central
 * DOES NOT create the directory - just finds the right location
 *
 * Logic:
 * - If cwd itself IS a Notes directory → use it directly
 * - If local Notes/ exists → use it (can be checked into git)
 * - Otherwise → use central ~/.claude/projects/.../Notes/
 */
export function findNotesDir(cwd: string): { path: string; isLocal: boolean } {
  // FIRST: Check if cwd itself IS a Notes directory
  const cwdBasename = basename(cwd).toLowerCase();
  if (cwdBasename === 'notes' && existsSync(cwd)) {
    return { path: cwd, isLocal: true };
  }

  // Check local locations
  const localPaths = [
    join(cwd, 'Notes'),
    join(cwd, 'notes'),
    join(cwd, '.claude', 'Notes')
  ];

  for (const path of localPaths) {
    if (existsSync(path)) {
      return { path, isLocal: true };
    }
  }

  // Fallback to central location
  return { path: getNotesDir(cwd), isLocal: false };
}

/**
 * Get the Sessions directory for a project (stores .jsonl transcripts)
 */
export function getSessionsDir(cwd: string): string {
  return join(getProjectDir(cwd), 'sessions');
}

/**
 * Get the Sessions directory from a project directory path
 */
export function getSessionsDirFromProjectDir(projectDir: string): string {
  return join(projectDir, 'sessions');
}

/**
 * Check if WhatsApp (Whazaa) is configured as an enabled MCP server.
 *
 * Uses standard Claude Code config at ~/.claude/settings.json.
 * No PAI dependency — works for any Claude Code user with whazaa installed.
 */
export function isWhatsAppEnabled(): boolean {
  try {
    const { homedir } = require('os');
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return false;

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const enabled: string[] = settings.enabledMcpjsonServers || [];
    return enabled.includes('whazaa');
  } catch {
    return false;
  }
}

/**
 * Send push notification — WhatsApp-aware with ntfy fallback.
 *
 * When WhatsApp (Whazaa) is enabled in MCP config, ntfy is SKIPPED
 * because the AI sends WhatsApp messages directly via MCP. Sending both
 * would cause duplicate notifications.
 *
 * When WhatsApp is NOT configured, ntfy fires as the fallback channel.
 */
export async function sendNtfyNotification(message: string, retries = 2): Promise<boolean> {
  // Skip ntfy when WhatsApp is configured — the AI handles notifications via MCP
  if (isWhatsAppEnabled()) {
    console.error(`WhatsApp (Whazaa) enabled in MCP config — skipping ntfy`);
    return true;
  }

  const topic = process.env.NTFY_TOPIC;

  if (!topic) {
    console.error('NTFY_TOPIC not set and WhatsApp not active — notifications disabled');
    return false;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        body: message,
        headers: {
          'Title': 'Claude Code',
          'Priority': 'default'
        }
      });

      if (response.ok) {
        console.error(`ntfy.sh notification sent (WhatsApp inactive): "${message}"`);
        return true;
      } else {
        console.error(`ntfy.sh attempt ${attempt + 1} failed: ${response.status}`);
      }
    } catch (error) {
      console.error(`ntfy.sh attempt ${attempt + 1} error: ${error}`);
    }

    // Wait before retry
    if (attempt < retries) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.error('ntfy.sh notification failed after all retries');
  return false;
}

/**
 * Ensure the Notes directory exists for a project
 * DEPRECATED: Use ensureNotesDirSmart() instead
 */
export function ensureNotesDir(cwd: string): string {
  const notesDir = getNotesDir(cwd);

  if (!existsSync(notesDir)) {
    mkdirSync(notesDir, { recursive: true });
    console.error(`Created Notes directory: ${notesDir}`);
  }

  return notesDir;
}

/**
 * Smart Notes directory handling:
 * - If local Notes/ exists → use it (don't create anything new)
 * - If no local Notes/ → ensure central exists and use that
 *
 * This respects the user's choice:
 * - Projects with local Notes/ keep notes there (git-trackable)
 * - Other directories don't get cluttered with auto-created Notes/
 */
export function ensureNotesDirSmart(cwd: string): { path: string; isLocal: boolean } {
  const found = findNotesDir(cwd);

  if (found.isLocal) {
    // Local Notes/ exists - use it as-is
    return found;
  }

  // No local Notes/ - ensure central exists
  if (!existsSync(found.path)) {
    mkdirSync(found.path, { recursive: true });
    console.error(`Created central Notes directory: ${found.path}`);
  }

  return found;
}

/**
 * Ensure the Sessions directory exists for a project
 */
export function ensureSessionsDir(cwd: string): string {
  const sessionsDir = getSessionsDir(cwd);

  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
    console.error(`Created sessions directory: ${sessionsDir}`);
  }

  return sessionsDir;
}

/**
 * Ensure the Sessions directory exists (from project dir path)
 */
export function ensureSessionsDirFromProjectDir(projectDir: string): string {
  const sessionsDir = getSessionsDirFromProjectDir(projectDir);

  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
    console.error(`Created sessions directory: ${sessionsDir}`);
  }

  return sessionsDir;
}

/**
 * Move all .jsonl session files from project root to sessions/ subdirectory
 * @param projectDir - The project directory path
 * @param excludeFile - Optional filename to exclude (e.g., current active session)
 * @param silent - If true, suppress console output
 * Returns the number of files moved
 */
export function moveSessionFilesToSessionsDir(
  projectDir: string,
  excludeFile?: string,
  silent: boolean = false
): number {
  const sessionsDir = ensureSessionsDirFromProjectDir(projectDir);

  if (!existsSync(projectDir)) {
    return 0;
  }

  const files = readdirSync(projectDir);
  let movedCount = 0;

  for (const file of files) {
    // Match session files: uuid.jsonl or agent-*.jsonl
    // Skip the excluded file (typically the current active session)
    if (file.endsWith('.jsonl') && file !== excludeFile) {
      const sourcePath = join(projectDir, file);
      const destPath = join(sessionsDir, file);

      try {
        renameSync(sourcePath, destPath);
        if (!silent) {
          console.error(`Moved ${file} → sessions/`);
        }
        movedCount++;
      } catch (error) {
        if (!silent) {
          console.error(`Could not move ${file}: ${error}`);
        }
      }
    }
  }

  return movedCount;
}

/**
 * Get the YYYY/MM subdirectory for the current month inside notesDir.
 * Creates the directory if it doesn't exist.
 */
function getMonthDir(notesDir: string): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const monthDir = join(notesDir, year, month);
  if (!existsSync(monthDir)) {
    mkdirSync(monthDir, { recursive: true });
  }
  return monthDir;
}

/**
 * Get the next note number (4-digit format: 0001, 0002, etc.)
 * ALWAYS uses 4-digit format with space-dash-space separators
 * Format: NNNN - YYYY-MM-DD - Description.md
 * Numbers reset per month (each YYYY/MM directory has its own sequence).
 */
export function getNextNoteNumber(notesDir: string): string {
  const monthDir = getMonthDir(notesDir);

  // Match CORRECT format: "0001 - " (4-digit with space-dash-space)
  // Also match legacy formats for backwards compatibility when detecting max number
  const files = readdirSync(monthDir)
    .filter(f => f.match(/^\d{3,4}[\s_-]/))  // Starts with 3-4 digits followed by separator
    .filter(f => f.endsWith('.md'))
    .sort();

  if (files.length === 0) {
    return '0001';  // Default to 4-digit
  }

  // Find the highest number across all formats
  let maxNumber = 0;
  for (const file of files) {
    const digitMatch = file.match(/^(\d+)/);
    if (digitMatch) {
      const num = parseInt(digitMatch[1], 10);
      if (num > maxNumber) maxNumber = num;
    }
  }

  // ALWAYS return 4-digit format
  return String(maxNumber + 1).padStart(4, '0');
}

/**
 * Get the current (latest) note file path, or null if none exists.
 * Searches in the current month's YYYY/MM subdirectory first,
 * then falls back to previous month (for sessions spanning month boundaries),
 * then falls back to flat notesDir for legacy notes.
 * Supports multiple formats for backwards compatibility:
 * - CORRECT: "0001 - YYYY-MM-DD - Description.md" (space-dash-space)
 * - Legacy: "001_YYYY-MM-DD_description.md" (underscores)
 */
export function getCurrentNotePath(notesDir: string): string | null {
  if (!existsSync(notesDir)) {
    return null;
  }

  // Helper: find latest session note in a directory
  const findLatestIn = (dir: string): string | null => {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter(f => f.match(/^\d{3,4}[\s_-].*\.md$/))
      .sort((a, b) => {
        const numA = parseInt(a.match(/^(\d+)/)?.[1] || '0', 10);
        const numB = parseInt(b.match(/^(\d+)/)?.[1] || '0', 10);
        return numA - numB;
      });
    if (files.length === 0) return null;
    return join(dir, files[files.length - 1]);
  };

  // 1. Check current month's YYYY/MM directory
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const currentMonthDir = join(notesDir, year, month);
  const found = findLatestIn(currentMonthDir);
  if (found) return found;

  // 2. Check previous month (for sessions spanning month boundaries)
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevYear = String(prevDate.getFullYear());
  const prevMonth = String(prevDate.getMonth() + 1).padStart(2, '0');
  const prevMonthDir = join(notesDir, prevYear, prevMonth);
  const prevFound = findLatestIn(prevMonthDir);
  if (prevFound) return prevFound;

  // 3. Fallback: check flat notesDir (legacy notes not yet filed)
  return findLatestIn(notesDir);
}

/**
 * Create a new session note
 * CORRECT FORMAT: "NNNN - YYYY-MM-DD - Description.md"
 * - 4-digit zero-padded number
 * - Space-dash-space separators (NOT underscores)
 * - Title case description
 *
 * IMPORTANT: The initial description is just a PLACEHOLDER.
 * Claude MUST rename the file at session end with a meaningful description
 * based on the actual work done. Never leave it as "New Session" or project name.
 */
export function createSessionNote(notesDir: string, description: string): string {
  const noteNumber = getNextNoteNumber(notesDir);
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Use "New Session" as placeholder - Claude MUST rename at session end!
  // The project name alone is NOT descriptive enough.
  const safeDescription = 'New Session';

  // CORRECT FORMAT: space-dash-space separators, filed into YYYY/MM subdirectory
  const monthDir = getMonthDir(notesDir);
  const filename = `${noteNumber} - ${date} - ${safeDescription}.md`;
  const filepath = join(monthDir, filename);

  const content = `# Session ${noteNumber}: ${description}

**Date:** ${date}
**Status:** In Progress

---

## Work Done

<!-- PAI will add completed work here during session -->

---

## Next Steps

<!-- To be filled at session end -->

---

**Tags:** #Session
`;

  writeFileSync(filepath, content);
  console.error(`Created session note: ${filename}`);

  return filepath;
}

/**
 * Append checkpoint to current session note
 */
export function appendCheckpoint(notePath: string, checkpoint: string): void {
  if (!existsSync(notePath)) {
    console.error(`Note file not found: ${notePath}`);
    return;
  }

  const content = readFileSync(notePath, 'utf-8');
  const timestamp = new Date().toISOString();
  const checkpointText = `\n### Checkpoint ${timestamp}\n\n${checkpoint}\n`;

  // Insert before "## Next Steps" if it exists, otherwise append
  const nextStepsIndex = content.indexOf('## Next Steps');
  let newContent: string;

  if (nextStepsIndex !== -1) {
    newContent = content.substring(0, nextStepsIndex) + checkpointText + content.substring(nextStepsIndex);
  } else {
    newContent = content + checkpointText;
  }

  writeFileSync(notePath, newContent);
  console.error(`Checkpoint added to: ${basename(notePath)}`);
}

/**
 * Work item for session notes
 */
export interface WorkItem {
  title: string;
  details?: string[];
  completed?: boolean;
}

/**
 * Add work items to the "Work Done" section of a session note
 * This is the main way to capture what was accomplished in a session
 */
export function addWorkToSessionNote(notePath: string, workItems: WorkItem[], sectionTitle?: string): void {
  if (!existsSync(notePath)) {
    console.error(`Note file not found: ${notePath}`);
    return;
  }

  let content = readFileSync(notePath, 'utf-8');

  // Build the work section content
  let workText = '';
  if (sectionTitle) {
    workText += `\n### ${sectionTitle}\n\n`;
  }

  for (const item of workItems) {
    const checkbox = item.completed !== false ? '[x]' : '[ ]';
    workText += `- ${checkbox} **${item.title}**\n`;
    if (item.details && item.details.length > 0) {
      for (const detail of item.details) {
        workText += `  - ${detail}\n`;
      }
    }
  }

  // Find the Work Done section and insert after the comment/placeholder
  const workDoneMatch = content.match(/## Work Done\n\n(<!-- .*? -->)?/);
  if (workDoneMatch) {
    const insertPoint = content.indexOf(workDoneMatch[0]) + workDoneMatch[0].length;
    content = content.substring(0, insertPoint) + workText + content.substring(insertPoint);
  } else {
    // Fallback: insert before Next Steps
    const nextStepsIndex = content.indexOf('## Next Steps');
    if (nextStepsIndex !== -1) {
      content = content.substring(0, nextStepsIndex) + workText + '\n' + content.substring(nextStepsIndex);
    }
  }

  writeFileSync(notePath, content);
  console.error(`Added ${workItems.length} work item(s) to: ${basename(notePath)}`);
}

/**
 * Update the session note title to be more descriptive
 * Called when we know what work was done
 */
export function updateSessionNoteTitle(notePath: string, newTitle: string): void {
  if (!existsSync(notePath)) {
    console.error(`Note file not found: ${notePath}`);
    return;
  }

  let content = readFileSync(notePath, 'utf-8');

  // Update the H1 title
  content = content.replace(/^# Session \d+:.*$/m, (match) => {
    const sessionNum = match.match(/Session (\d+)/)?.[1] || '';
    return `# Session ${sessionNum}: ${newTitle}`;
  });

  writeFileSync(notePath, content);

  // Also rename the file
  renameSessionNote(notePath, sanitizeForFilename(newTitle));
}

/**
 * Sanitize a string for use in a filename (exported for use elsewhere)
 */
export function sanitizeForFilename(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // Remove special chars
    .replace(/\s+/g, '-')           // Spaces to hyphens
    .replace(/-+/g, '-')            // Collapse multiple hyphens
    .replace(/^-|-$/g, '')          // Trim hyphens
    .substring(0, 50);              // Limit length
}

/**
 * Extract a meaningful name from session note content
 * Looks at Work Done section and summary to generate a descriptive name
 */
export function extractMeaningfulName(noteContent: string, summary: string): string {
  // Try to extract from Work Done section headers (### headings)
  const workDoneMatch = noteContent.match(/## Work Done\n\n([\s\S]*?)(?=\n---|\n## Next)/);

  if (workDoneMatch) {
    const workDoneSection = workDoneMatch[1];

    // Look for ### subheadings which typically describe what was done
    const subheadings = workDoneSection.match(/### ([^\n]+)/g);
    if (subheadings && subheadings.length > 0) {
      // Use the first subheading, clean it up
      const firstHeading = subheadings[0].replace('### ', '').trim();
      if (firstHeading.length > 5 && firstHeading.length < 60) {
        return sanitizeForFilename(firstHeading);
      }
    }

    // Look for bold text which often indicates key topics
    const boldMatches = workDoneSection.match(/\*\*([^*]+)\*\*/g);
    if (boldMatches && boldMatches.length > 0) {
      const firstBold = boldMatches[0].replace(/\*\*/g, '').trim();
      if (firstBold.length > 3 && firstBold.length < 50) {
        return sanitizeForFilename(firstBold);
      }
    }

    // Look for numbered list items (1. Something)
    const numberedItems = workDoneSection.match(/^\d+\.\s+\*\*([^*]+)\*\*/m);
    if (numberedItems) {
      return sanitizeForFilename(numberedItems[1]);
    }
  }

  // Fall back to summary if provided
  if (summary && summary.length > 5 && summary !== 'Session completed.') {
    // Take first meaningful phrase from summary
    const cleanSummary = summary
      .replace(/[^\w\s-]/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .join(' ');

    if (cleanSummary.length > 3) {
      return sanitizeForFilename(cleanSummary);
    }
  }

  return '';
}

/**
 * Rename session note with a meaningful name
 * ALWAYS uses correct format: "NNNN - YYYY-MM-DD - Description.md"
 * Returns the new path, or original path if rename fails
 */
export function renameSessionNote(notePath: string, meaningfulName: string): string {
  if (!meaningfulName || !existsSync(notePath)) {
    return notePath;
  }

  const dir = join(notePath, '..');
  const oldFilename = basename(notePath);

  // Parse existing filename - support multiple formats:
  // CORRECT: "0001 - 2026-01-02 - Description.md"
  // Legacy: "001_2026-01-02_description.md"
  const correctMatch = oldFilename.match(/^(\d{3,4}) - (\d{4}-\d{2}-\d{2}) - .*\.md$/);
  const legacyMatch = oldFilename.match(/^(\d{3,4})_(\d{4}-\d{2}-\d{2})_.*\.md$/);

  const match = correctMatch || legacyMatch;
  if (!match) {
    return notePath; // Can't parse, don't rename
  }

  const [, noteNumber, date] = match;

  // Convert to Title Case
  const titleCaseName = meaningfulName
    .split(/[\s_-]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .trim();

  // ALWAYS use correct format with 4-digit number
  const paddedNumber = noteNumber.padStart(4, '0');
  const newFilename = `${paddedNumber} - ${date} - ${titleCaseName}.md`;
  const newPath = join(dir, newFilename);

  // Don't rename if name is the same
  if (newFilename === oldFilename) {
    return notePath;
  }

  try {
    renameSync(notePath, newPath);
    console.error(`Renamed note: ${oldFilename} → ${newFilename}`);
    return newPath;
  } catch (error) {
    console.error(`Could not rename note: ${error}`);
    return notePath;
  }
}

/**
 * Finalize session note (mark as complete, add summary, rename with meaningful name)
 * IDEMPOTENT: Will only finalize once, subsequent calls are no-ops
 * Returns the final path (may be renamed)
 */
export function finalizeSessionNote(notePath: string, summary: string): string {
  if (!existsSync(notePath)) {
    console.error(`Note file not found: ${notePath}`);
    return notePath;
  }

  let content = readFileSync(notePath, 'utf-8');

  // IDEMPOTENT CHECK: If already completed, don't modify again
  if (content.includes('**Status:** Completed')) {
    console.error(`Note already finalized: ${basename(notePath)}`);
    return notePath;
  }

  // Update status
  content = content.replace('**Status:** In Progress', '**Status:** Completed');

  // Add completion timestamp (only if not already present)
  if (!content.includes('**Completed:**')) {
    const completionTime = new Date().toISOString();
    content = content.replace(
      '---\n\n## Work Done',
      `**Completed:** ${completionTime}\n\n---\n\n## Work Done`
    );
  }

  // Add summary to Next Steps section (only if placeholder exists)
  const nextStepsMatch = content.match(/## Next Steps\n\n(<!-- .*? -->)/);
  if (nextStepsMatch) {
    content = content.replace(
      nextStepsMatch[0],
      `## Next Steps\n\n${summary || 'Session completed.'}`
    );
  }

  writeFileSync(notePath, content);
  console.error(`Session note finalized: ${basename(notePath)}`);

  // Extract meaningful name and rename the file
  const meaningfulName = extractMeaningfulName(content, summary);
  if (meaningfulName) {
    const newPath = renameSessionNote(notePath, meaningfulName);
    return newPath;
  }

  return notePath;
}

/**
 * Calculate total tokens from a session .jsonl file
 */
export function calculateSessionTokens(jsonlPath: string): number {
  if (!existsSync(jsonlPath)) {
    return 0;
  }

  try {
    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');
    let totalTokens = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.message?.usage) {
          const usage = entry.message.usage;
          totalTokens += (usage.input_tokens || 0);
          totalTokens += (usage.output_tokens || 0);
          totalTokens += (usage.cache_creation_input_tokens || 0);
          totalTokens += (usage.cache_read_input_tokens || 0);
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return totalTokens;
  } catch (error) {
    console.error(`Error calculating tokens: ${error}`);
    return 0;
  }
}

/**
 * Find TODO.md - check local first, fallback to central
 */
export function findTodoPath(cwd: string): string {
  // Check local locations first
  const localPaths = [
    join(cwd, 'TODO.md'),
    join(cwd, 'notes', 'TODO.md'),
    join(cwd, 'Notes', 'TODO.md'),
    join(cwd, '.claude', 'TODO.md')
  ];

  for (const path of localPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  // Fallback to central location (inside Notes/)
  return join(getNotesDir(cwd), 'TODO.md');
}

/**
 * Find CLAUDE.md - check local locations
 * Returns the FIRST found path (for backwards compatibility)
 */
export function findClaudeMdPath(cwd: string): string | null {
  const paths = findAllClaudeMdPaths(cwd);
  return paths.length > 0 ? paths[0] : null;
}

/**
 * Find ALL CLAUDE.md files in local locations
 * Returns paths in priority order (most specific first):
 * 1. .claude/CLAUDE.md (project-specific config dir)
 * 2. CLAUDE.md (project root)
 * 3. Notes/CLAUDE.md (notes directory)
 * 4. Prompts/CLAUDE.md (prompts directory)
 *
 * All found files will be loaded and injected into context.
 */
export function findAllClaudeMdPaths(cwd: string): string[] {
  const foundPaths: string[] = [];

  // Priority order: most specific first
  const localPaths = [
    join(cwd, '.claude', 'CLAUDE.md'),
    join(cwd, 'CLAUDE.md'),
    join(cwd, 'Notes', 'CLAUDE.md'),
    join(cwd, 'notes', 'CLAUDE.md'),
    join(cwd, 'Prompts', 'CLAUDE.md'),
    join(cwd, 'prompts', 'CLAUDE.md')
  ];

  for (const path of localPaths) {
    if (existsSync(path)) {
      foundPaths.push(path);
    }
  }

  return foundPaths;
}

/**
 * Ensure TODO.md exists
 */
export function ensureTodoMd(cwd: string): string {
  const todoPath = findTodoPath(cwd);

  if (!existsSync(todoPath)) {
    // Ensure parent directory exists
    const parentDir = join(todoPath, '..');
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

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

/**
 * Task item for TODO.md
 */
export interface TodoItem {
  content: string;
  completed: boolean;
}

/**
 * Update TODO.md with current session tasks
 * Preserves the Backlog section
 * Ensures only ONE timestamp line at the end
 */
export function updateTodoMd(cwd: string, tasks: TodoItem[], sessionSummary?: string): void {
  const todoPath = ensureTodoMd(cwd);
  const content = readFileSync(todoPath, 'utf-8');

  // Find Backlog section to preserve it (but strip any trailing timestamps/separators)
  const backlogMatch = content.match(/## Backlog[\s\S]*?(?=\n---|\n\*Last updated|$)/);
  let backlogSection = backlogMatch ? backlogMatch[0].trim() : '## Backlog\n\n- [ ] (Future tasks)';

  // Format tasks
  const taskLines = tasks.length > 0
    ? tasks.map(t => `- [${t.completed ? 'x' : ' '}] ${t.content}`).join('\n')
    : '- [ ] (No active tasks)';

  // Build new content with exactly ONE timestamp at the end
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
 * Add a checkpoint entry to TODO.md (without replacing tasks)
 * Ensures only ONE timestamp line at the end
 */
export function addTodoCheckpoint(cwd: string, checkpoint: string): void {
  const todoPath = ensureTodoMd(cwd);
  let content = readFileSync(todoPath, 'utf-8');

  // Remove ALL existing timestamp lines and trailing separators
  content = content.replace(/(\n---\s*)*(\n\*Last updated:.*\*\s*)+$/g, '');

  // Add checkpoint before Backlog section
  const backlogIndex = content.indexOf('## Backlog');
  if (backlogIndex !== -1) {
    const checkpointText = `\n**Checkpoint (${new Date().toISOString()}):** ${checkpoint}\n\n`;
    content = content.substring(0, backlogIndex) + checkpointText + content.substring(backlogIndex);
  }

  // Add exactly ONE timestamp at the end
  content = content.trimEnd() + `\n\n---\n\n*Last updated: ${new Date().toISOString()}*\n`;

  writeFileSync(todoPath, content);
  console.error(`Checkpoint added to TODO.md`);
}
