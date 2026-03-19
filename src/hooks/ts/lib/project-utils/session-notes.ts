/**
 * Session note creation, editing, checkpointing, renaming, and finalization.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join, basename } from 'path';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Get or create the YYYY/MM subdirectory for the current month inside notesDir. */
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the next note number (4-digit format: 0001, 0002, etc.).
 * Numbers are scoped per YYYY/MM directory.
 */
export function getNextNoteNumber(notesDir: string): string {
  const monthDir = getMonthDir(notesDir);

  const files = readdirSync(monthDir)
    .filter(f => f.match(/^\d{3,4}[\s_-]/))
    .sort();

  if (files.length === 0) return '0001';

  let maxNumber = 0;
  for (const file of files) {
    const digitMatch = file.match(/^(\d+)/);
    if (digitMatch) {
      const num = parseInt(digitMatch[1], 10);
      if (num > maxNumber) maxNumber = num;
    }
  }

  return String(maxNumber + 1).padStart(4, '0');
}

/**
 * Get the current (latest) note file path, or null if none exists.
 * Searches current month → previous month → flat notesDir (legacy).
 */
export function getCurrentNotePath(notesDir: string): string | null {
  if (!existsSync(notesDir)) return null;

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

  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const currentMonthDir = join(notesDir, year, month);
  const found = findLatestIn(currentMonthDir);
  if (found) return found;

  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevYear = String(prevDate.getFullYear());
  const prevMonth = String(prevDate.getMonth() + 1).padStart(2, '0');
  const prevMonthDir = join(notesDir, prevYear, prevMonth);
  const prevFound = findLatestIn(prevMonthDir);
  if (prevFound) return prevFound;

  return findLatestIn(notesDir);
}

/**
 * Create a new session note.
 * Format: "NNNN - YYYY-MM-DD - New Session.md" filed into YYYY/MM subdirectory.
 * Claude MUST rename at session end with a meaningful description.
 */
export function createSessionNote(notesDir: string, description: string): string {
  const noteNumber = getNextNoteNumber(notesDir);
  const date = new Date().toISOString().split('T')[0];
  const monthDir = getMonthDir(notesDir);
  const filename = `${noteNumber} - ${date} - New Session.md`;
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

/** Append a checkpoint to the current session note. */
export function appendCheckpoint(notePath: string, checkpoint: string): void {
  if (!existsSync(notePath)) {
    console.error(`Note file not found, recreating: ${notePath}`);
    try {
      const parentDir = join(notePath, '..');
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      const noteFilename = basename(notePath);
      const numberMatch = noteFilename.match(/^(\d+)/);
      const noteNumber = numberMatch ? numberMatch[1] : '0000';
      const date = new Date().toISOString().split('T')[0];
      const content = `# Session ${noteNumber}: Recovered\n\n**Date:** ${date}\n**Status:** In Progress\n\n---\n\n## Work Done\n\n<!-- PAI will add completed work here during session -->\n\n---\n\n## Next Steps\n\n<!-- To be filled at session end -->\n\n---\n\n**Tags:** #Session\n`;
      writeFileSync(notePath, content);
      console.error(`Recreated session note: ${noteFilename}`);
    } catch (err) {
      console.error(`Failed to recreate note: ${err}`);
      return;
    }
  }

  const content = readFileSync(notePath, 'utf-8');
  const timestamp = new Date().toISOString();
  const checkpointText = `\n### Checkpoint ${timestamp}\n\n${checkpoint}\n`;

  const nextStepsIndex = content.indexOf('## Next Steps');
  const newContent = nextStepsIndex !== -1
    ? content.substring(0, nextStepsIndex) + checkpointText + content.substring(nextStepsIndex)
    : content + checkpointText;

  writeFileSync(notePath, newContent);
  console.error(`Checkpoint added to: ${basename(notePath)}`);
}

/** Work item for session notes. */
export interface WorkItem {
  title: string;
  details?: string[];
  completed?: boolean;
}

/** Add work items to the "Work Done" section of a session note. */
export function addWorkToSessionNote(notePath: string, workItems: WorkItem[], sectionTitle?: string): void {
  if (!existsSync(notePath)) {
    console.error(`Note file not found: ${notePath}`);
    return;
  }

  let content = readFileSync(notePath, 'utf-8');

  let workText = '';
  if (sectionTitle) workText += `\n### ${sectionTitle}\n\n`;

  for (const item of workItems) {
    const checkbox = item.completed !== false ? '[x]' : '[ ]';
    workText += `- ${checkbox} **${item.title}**\n`;
    if (item.details && item.details.length > 0) {
      for (const detail of item.details) {
        workText += `  - ${detail}\n`;
      }
    }
  }

  const workDoneMatch = content.match(/## Work Done\n\n(<!-- .*? -->)?/);
  if (workDoneMatch) {
    const insertPoint = content.indexOf(workDoneMatch[0]) + workDoneMatch[0].length;
    content = content.substring(0, insertPoint) + workText + content.substring(insertPoint);
  } else {
    const nextStepsIndex = content.indexOf('## Next Steps');
    if (nextStepsIndex !== -1) {
      content = content.substring(0, nextStepsIndex) + workText + '\n' + content.substring(nextStepsIndex);
    }
  }

  writeFileSync(notePath, content);
  console.error(`Added ${workItems.length} work item(s) to: ${basename(notePath)}`);
}

/**
 * Check if a candidate title is meaningless / garbage.
 * Public wrapper around the internal filter for use by other hooks.
 */
export function isMeaningfulTitle(text: string): boolean {
  return !isMeaninglessCandidate(text);
}

/** Sanitize a string for use in a filename. */
export function sanitizeForFilename(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

/**
 * Return true if the candidate string should be rejected as a meaningful name.
 * Rejects file paths, shebangs, timestamps, system noise, XML tags, hashes, etc.
 */
function isMeaninglessCandidate(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length < 5) return true;                              // too short to be meaningful
  if (t.startsWith('/') || t.startsWith('~')) return true;    // file path
  if (t.startsWith('#!')) return true;                         // shebang
  if (t.includes('[object Object]')) return true;              // serialization artifact
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(t)) return true; // ISO timestamp
  if (/^\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?$/i.test(t)) return true; // time-only
  if (/^<[a-z-]+[\s/>]/i.test(t)) return true;               // XML/HTML tags (<task-notification>, etc.)
  if (/^[0-9a-f]{10,}$/i.test(t)) return true;               // hex hash strings
  if (/^Exit code \d+/i.test(t)) return true;                 // exit code messages
  if (/^Error:/i.test(t)) return true;                        // error messages
  if (/^This session is being continued/i.test(t)) return true; // continuation boilerplate
  if (/^\(Bash completed/i.test(t)) return true;              // bash output noise
  if (/^Task Notification$/i.test(t)) return true;            // literal "Task Notification"
  if (/^New Session$/i.test(t)) return true;                  // placeholder title
  if (/^Recovered Session$/i.test(t)) return true;            // placeholder title
  if (/^Continued Session$/i.test(t)) return true;            // placeholder title
  if (/^Untitled Session$/i.test(t)) return true;             // placeholder title
  if (/^Context Compression$/i.test(t)) return true;          // compression artifact
  if (/^[A-Fa-f0-9]{8,}\s+Output$/i.test(t)) return true;   // hash + "Output" pattern
  return false;
}

/**
 * Extract a meaningful name from session note content and summary.
 * Looks at Work Done section headers, bold text, and summary.
 */
export function extractMeaningfulName(noteContent: string, summary: string): string {
  const workDoneMatch = noteContent.match(/## Work Done\n\n([\s\S]*?)(?=\n---|\n## Next)/);

  if (workDoneMatch) {
    const workDoneSection = workDoneMatch[1];

    const subheadings = workDoneSection.match(/### ([^\n]+)/g);
    if (subheadings && subheadings.length > 0) {
      const firstHeading = subheadings[0].replace('### ', '').trim();
      if (!isMeaninglessCandidate(firstHeading) && firstHeading.length > 5 && firstHeading.length < 60) {
        return sanitizeForFilename(firstHeading);
      }
    }

    const boldMatches = workDoneSection.match(/\*\*([^*]+)\*\*/g);
    if (boldMatches && boldMatches.length > 0) {
      const firstBold = boldMatches[0].replace(/\*\*/g, '').trim();
      if (!isMeaninglessCandidate(firstBold) && firstBold.length > 3 && firstBold.length < 50) {
        return sanitizeForFilename(firstBold);
      }
    }

    const numberedItems = workDoneSection.match(/^\d+\.\s+\*\*([^*]+)\*\*/m);
    if (numberedItems && !isMeaninglessCandidate(numberedItems[1])) {
      return sanitizeForFilename(numberedItems[1]);
    }
  }

  if (summary && summary.length > 5 && summary !== 'Session completed.' && !isMeaninglessCandidate(summary)) {
    const cleanSummary = summary
      .replace(/[^\w\s-]/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .join(' ');
    if (cleanSummary.length > 3 && !isMeaninglessCandidate(cleanSummary)) {
      return sanitizeForFilename(cleanSummary);
    }
  }

  return '';
}

/**
 * Rename a session note with a meaningful name.
 * Always uses "NNNN - YYYY-MM-DD - Description.md" format.
 * Returns the new path, or original path if rename fails.
 */
export function renameSessionNote(notePath: string, meaningfulName: string): string {
  if (!meaningfulName || !existsSync(notePath)) return notePath;

  const dir = join(notePath, '..');
  const oldFilename = basename(notePath);

  const correctMatch = oldFilename.match(/^(\d{3,4}) - (\d{4}-\d{2}-\d{2}) - .*\.md$/);
  const legacyMatch = oldFilename.match(/^(\d{3,4})_(\d{4}-\d{2}-\d{2})_.*\.md$/);
  const match = correctMatch || legacyMatch;
  if (!match) return notePath;

  const [, noteNumber, date] = match;

  const titleCaseName = meaningfulName
    .split(/[\s_-]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .trim();

  const paddedNumber = noteNumber.padStart(4, '0');
  const newFilename = `${paddedNumber} - ${date} - ${titleCaseName}.md`;
  const newPath = join(dir, newFilename);

  if (newFilename === oldFilename) return notePath;

  try {
    renameSync(notePath, newPath);
    console.error(`Renamed note: ${oldFilename} → ${newFilename}`);
    return newPath;
  } catch (error) {
    console.error(`Could not rename note: ${error}`);
    return notePath;
  }
}

/** Update the session note's H1 title and rename the file. */
export function updateSessionNoteTitle(notePath: string, newTitle: string): void {
  if (!existsSync(notePath)) {
    console.error(`Note file not found: ${notePath}`);
    return;
  }

  let content = readFileSync(notePath, 'utf-8');
  content = content.replace(/^# Session \d+:.*$/m, (match) => {
    const sessionNum = match.match(/Session (\d+)/)?.[1] || '';
    return `# Session ${sessionNum}: ${newTitle}`;
  });
  writeFileSync(notePath, content);
  renameSessionNote(notePath, sanitizeForFilename(newTitle));
}

/**
 * Finalize session note — mark as complete, add summary, rename with meaningful name.
 * IDEMPOTENT: subsequent calls are no-ops if already finalized.
 * Returns the final path (may be renamed).
 */
export function finalizeSessionNote(notePath: string, summary: string): string {
  if (!existsSync(notePath)) {
    console.error(`Note file not found: ${notePath}`);
    return notePath;
  }

  let content = readFileSync(notePath, 'utf-8');

  if (content.includes('**Status:** Completed')) {
    console.error(`Note already finalized: ${basename(notePath)}`);
    return notePath;
  }

  content = content.replace('**Status:** In Progress', '**Status:** Completed');

  if (!content.includes('**Completed:**')) {
    const completionTime = new Date().toISOString();
    content = content.replace(
      '---\n\n## Work Done',
      `**Completed:** ${completionTime}\n\n---\n\n## Work Done`
    );
  }

  const nextStepsMatch = content.match(/## Next Steps\n\n(<!-- .*? -->)/);
  if (nextStepsMatch) {
    content = content.replace(
      nextStepsMatch[0],
      `## Next Steps\n\n${summary || 'Session completed.'}`
    );
  }

  writeFileSync(notePath, content);
  console.error(`Session note finalized: ${basename(notePath)}`);

  const meaningfulName = extractMeaningfulName(content, summary);
  if (meaningfulName) {
    return renameSessionNote(notePath, meaningfulName);
  }

  return notePath;
}
