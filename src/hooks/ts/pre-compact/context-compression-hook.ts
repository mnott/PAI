#!/usr/bin/env node
/**
 * PreCompact Hook - Triggered before context compression
 *
 * Three critical jobs:
 * 1. Save rich checkpoint to session note — work items, state, meaningful rename
 * 2. Update TODO.md with a proper ## Continue section for the next session
 * 3. Save session state to temp file for post-compact injection via SessionStart(compact)
 *
 * Uses a CUMULATIVE state file (.compact-state.json) that persists across
 * compactions. This ensures that even after multiple compactions (where the
 * transcript becomes thin), we still have rich data for titles, summaries,
 * and work items from earlier in the session.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  sendNtfyNotification,
  getCurrentNotePath,
  createSessionNote,
  appendCheckpoint,
  addWorkToSessionNote,
  findNotesDir,
  renameSessionNote,
  updateTodoContinue,
  calculateSessionTokens,
  isProbeSession,
  WorkItem,
} from '../lib/project-utils';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd?: string;
  hook_event_name: string;
  compact_type?: string;
  trigger?: string;
}

/** Structured data extracted from a transcript in a single pass. */
interface TranscriptData {
  userMessages: string[];
  summaries: string[];
  captures: string[];
  lastCompleted: string;
  filesModified: string[];
  workItems: WorkItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Turn Claude content (string or content block array) into plain text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c?.text) return c.text;
        if (c?.content) return String(c.content);
        return '';
      })
      .join(' ')
      .trim();
  }
  return '';
}

function getTranscriptStats(transcriptPath: string): { messageCount: number; isLarge: boolean } {
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');
    let userMessages = 0;
    let assistantMessages = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user') userMessages++;
        else if (entry.type === 'assistant') assistantMessages++;
      } catch { /* skip */ }
    }
    const totalMessages = userMessages + assistantMessages;
    return { messageCount: totalMessages, isLarge: totalMessages > 50 };
  } catch {
    return { messageCount: 0, isLarge: false };
  }
}

// ---------------------------------------------------------------------------
// Unified transcript parser — single pass extracts everything
// ---------------------------------------------------------------------------

function parseTranscript(transcriptPath: string): TranscriptData {
  const data: TranscriptData = {
    userMessages: [],
    summaries: [],
    captures: [],
    lastCompleted: '',
    filesModified: [],
    workItems: [],
  };

  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n');
    const seenSummaries = new Set<string>();

    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }

      // --- User messages ---
      if (entry.type === 'user' && entry.message?.content) {
        const text = contentToText(entry.message.content).slice(0, 300);
        if (text) data.userMessages.push(text);
      }

      // --- Assistant content ---
      if (entry.type === 'assistant' && entry.message?.content) {
        const text = contentToText(entry.message.content);

        // Summaries → also create work items
        const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
        if (summaryMatch) {
          const s = summaryMatch[1].trim();
          if (s.length > 5 && !data.summaries.includes(s)) {
            data.summaries.push(s);
            if (!seenSummaries.has(s)) {
              seenSummaries.add(s);
              const details: string[] = [];
              const actionsMatch = text.match(/ACTIONS:\s*(.+?)(?=\n[A-Z]+:|$)/is);
              if (actionsMatch) {
                const actionLines = actionsMatch[1].split('\n')
                  .map(l => l.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '').trim())
                  .filter(l => l.length > 3 && l.length < 100);
                details.push(...actionLines.slice(0, 3));
              }
              data.workItems.push({ title: s, details: details.length > 0 ? details : undefined, completed: true });
            }
          }
        }

        // Captures
        const captureMatch = text.match(/CAPTURE:\s*(.+?)(?:\n|$)/i);
        if (captureMatch) {
          const c = captureMatch[1].trim();
          if (c.length > 5 && !data.captures.includes(c)) data.captures.push(c);
        }

        // Completed
        const completedMatch = text.match(/COMPLETED:\s*(.+?)(?:\n|$)/i);
        if (completedMatch) {
          data.lastCompleted = completedMatch[1].trim().replace(/\*+/g, '');
          if (data.workItems.length === 0 && !seenSummaries.has(data.lastCompleted) && data.lastCompleted.length > 5) {
            seenSummaries.add(data.lastCompleted);
            data.workItems.push({ title: data.lastCompleted, completed: true });
          }
        }

        // File modifications (from tool_use blocks)
        if (Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'tool_use') {
              const tool = block.name;
              if ((tool === 'Edit' || tool === 'Write') && block.input?.file_path) {
                if (!data.filesModified.includes(block.input.file_path)) {
                  data.filesModified.push(block.input.file_path);
                }
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`parseTranscript error: ${err}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Format session state as human-readable string
// ---------------------------------------------------------------------------

function formatSessionState(data: TranscriptData, cwd?: string): string | null {
  const parts: string[] = [];

  if (cwd) parts.push(`Working directory: ${cwd}`);

  const recentUser = data.userMessages.slice(-3);
  if (recentUser.length > 0) {
    parts.push('\nRecent user requests:');
    for (const msg of recentUser) {
      parts.push(`- ${msg.split('\n')[0].slice(0, 200)}`);
    }
  }

  const recentSummaries = data.summaries.slice(-3);
  if (recentSummaries.length > 0) {
    parts.push('\nWork summaries:');
    for (const s of recentSummaries) parts.push(`- ${s.slice(0, 150)}`);
  }

  const recentCaptures = data.captures.slice(-5);
  if (recentCaptures.length > 0) {
    parts.push('\nCaptured context:');
    for (const c of recentCaptures) parts.push(`- ${c.slice(0, 150)}`);
  }

  const files = data.filesModified.slice(-10);
  if (files.length > 0) {
    parts.push('\nFiles modified this session:');
    for (const f of files) parts.push(`- ${f}`);
  }

  if (data.lastCompleted) {
    parts.push(`\nLast completed: ${data.lastCompleted.slice(0, 150)}`);
  }

  const result = parts.join('\n');
  return result.length > 50 ? result : null;
}

// ---------------------------------------------------------------------------
// Derive a meaningful title for the session note
// ---------------------------------------------------------------------------

function deriveTitle(data: TranscriptData): string {
  let title = '';

  // 1. Last work item title (most descriptive of what was accomplished)
  if (data.workItems.length > 0) {
    title = data.workItems[data.workItems.length - 1].title;
  }
  // 2. Last summary
  else if (data.summaries.length > 0) {
    title = data.summaries[data.summaries.length - 1];
  }
  // 3. Last completed marker
  else if (data.lastCompleted && data.lastCompleted.length > 5) {
    title = data.lastCompleted;
  }
  // 4. Last substantive user message
  else if (data.userMessages.length > 0) {
    for (let i = data.userMessages.length - 1; i >= 0; i--) {
      const msg = data.userMessages[i].split('\n')[0].trim();
      if (msg.length > 10 && msg.length < 80 &&
          !msg.toLowerCase().startsWith('yes') &&
          !msg.toLowerCase().startsWith('ok')) {
        title = msg;
        break;
      }
    }
  }
  // 5. Derive from files modified
  if (!title && data.filesModified.length > 0) {
    const basenames = data.filesModified.slice(-5).map(f => {
      const b = basename(f);
      return b.replace(/\.[^.]+$/, '');
    });
    const unique = [...new Set(basenames)];
    title = unique.length <= 3
      ? `Updated ${unique.join(', ')}`
      : `Modified ${data.filesModified.length} files`;
  }

  // Clean up for filename use
  return title
    .replace(/[^\w\s-]/g, ' ')   // Remove special chars
    .replace(/\s+/g, ' ')        // Normalize whitespace
    .trim()
    .substring(0, 60);
}

// ---------------------------------------------------------------------------
// Cumulative state — persists across compactions in .compact-state.json
// ---------------------------------------------------------------------------

const CUMULATIVE_STATE_FILE = '.compact-state.json';

function loadCumulativeState(notesDir: string): TranscriptData | null {
  try {
    const filePath = join(notesDir, CUMULATIVE_STATE_FILE);
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    return {
      userMessages: raw.userMessages || [],
      summaries: raw.summaries || [],
      captures: raw.captures || [],
      lastCompleted: raw.lastCompleted || '',
      filesModified: raw.filesModified || [],
      workItems: raw.workItems || [],
    };
  } catch {
    return null;
  }
}

function mergeTranscriptData(accumulated: TranscriptData | null, current: TranscriptData): TranscriptData {
  if (!accumulated) return current;

  const mergeArrays = (a: string[], b: string[]): string[] => {
    const seen = new Set(a);
    return [...a, ...b.filter(x => !seen.has(x))];
  };

  const seenTitles = new Set(accumulated.workItems.map(w => w.title));
  const newWorkItems = current.workItems.filter(w => !seenTitles.has(w.title));

  return {
    userMessages: mergeArrays(accumulated.userMessages, current.userMessages).slice(-20),
    summaries: mergeArrays(accumulated.summaries, current.summaries),
    captures: mergeArrays(accumulated.captures, current.captures),
    lastCompleted: current.lastCompleted || accumulated.lastCompleted,
    filesModified: mergeArrays(accumulated.filesModified, current.filesModified),
    workItems: [...accumulated.workItems, ...newWorkItems],
  };
}

function saveCumulativeState(notesDir: string, data: TranscriptData, notePath: string | null): void {
  try {
    const filePath = join(notesDir, CUMULATIVE_STATE_FILE);
    writeFileSync(filePath, JSON.stringify({
      ...data,
      notePath,
      lastUpdated: new Date().toISOString(),
    }, null, 2));
    console.error(`Cumulative state saved (${data.workItems.length} work items, ${data.filesModified.length} files)`);
  } catch (err) {
    console.error(`Failed to save cumulative state: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Skip probe/health-check sessions (e.g. CodexBar ClaudeProbe)
  if (isProbeSession()) {
    process.exit(0);
  }

  let hookInput: HookInput | null = null;

  try {
    const decoder = new TextDecoder();
    let input = '';
    const timeoutPromise = new Promise<void>((resolve) => { setTimeout(resolve, 500); });
    const readPromise = (async () => {
      for await (const chunk of process.stdin) {
        input += decoder.decode(chunk, { stream: true });
      }
    })();
    await Promise.race([readPromise, timeoutPromise]);
    if (input.trim()) {
      hookInput = JSON.parse(input) as HookInput;
    }
  } catch {
    // Silently handle input errors
  }

  const compactType = hookInput?.compact_type || hookInput?.trigger || 'auto';
  let tokenCount = 0;

  if (hookInput?.transcript_path) {
    const stats = getTranscriptStats(hookInput.transcript_path);
    tokenCount = calculateSessionTokens(hookInput.transcript_path);
    const tokenDisplay = tokenCount > 1000
      ? `${Math.round(tokenCount / 1000)}k`
      : String(tokenCount);

    // -----------------------------------------------------------------
    // Single-pass transcript parsing + cumulative state merge
    // -----------------------------------------------------------------
    const data = parseTranscript(hookInput.transcript_path);

    // Find notes directory early — needed for cumulative state
    let notesInfo: { path: string; isLocal: boolean };
    try {
      notesInfo = hookInput.cwd
        ? findNotesDir(hookInput.cwd)
        : { path: join(dirname(hookInput.transcript_path), 'Notes'), isLocal: false };
    } catch {
      notesInfo = { path: join(dirname(hookInput.transcript_path), 'Notes'), isLocal: false };
    }

    // Load accumulated state from previous compactions and merge
    const accumulated = loadCumulativeState(notesInfo.path);
    const merged = mergeTranscriptData(accumulated, data);
    const state = formatSessionState(merged, hookInput.cwd);

    if (accumulated) {
      console.error(`Loaded cumulative state: ${accumulated.workItems.length} work items, ${accumulated.filesModified.length} files from previous compaction(s)`);
    }

    // -----------------------------------------------------------------
    // Persist session state to numbered session note (like "pause session")
    // -----------------------------------------------------------------
    let notePath: string | null = null;

    try {
      notePath = getCurrentNotePath(notesInfo.path);

      // If no note found, or the latest note is completed, create a new one
      if (!notePath) {
        console.error('No session note found — creating one for checkpoint');
        notePath = createSessionNote(notesInfo.path, 'Recovered Session');
      } else {
        try {
          const noteContent = readFileSync(notePath, 'utf-8');
          if (noteContent.includes('**Status:** Completed') || noteContent.includes('**Completed:**')) {
            console.error(`Latest note is completed (${basename(notePath)}) — creating new one`);
            notePath = createSessionNote(notesInfo.path, 'Continued Session');
          }
        } catch { /* proceed with existing note */ }
      }

      // 1. Write rich checkpoint with full session state
      const checkpointBody = state
        ? `Context compression triggered at ~${tokenDisplay} tokens with ${stats.messageCount} messages.\n\n${state}`
        : `Context compression triggered at ~${tokenDisplay} tokens with ${stats.messageCount} messages.`;
      appendCheckpoint(notePath, checkpointBody);

      // 2. Write work items to "Work Done" section (uses merged cumulative data)
      if (merged.workItems.length > 0) {
        addWorkToSessionNote(notePath, merged.workItems, `Pre-Compact (~${tokenDisplay} tokens)`);
        console.error(`Added ${merged.workItems.length} work item(s) to session note`);
      }

      // 3. Rename session note with a meaningful title (uses merged data for richer titles)
      const title = deriveTitle(merged);
      if (title) {
        const newPath = renameSessionNote(notePath, title);
        if (newPath !== notePath) {
          // Update H1 title inside the note to match
          try {
            let noteContent = readFileSync(newPath, 'utf-8');
            noteContent = noteContent.replace(
              /^(# Session \d+:)\s*.*$/m,
              `$1 ${title}`
            );
            writeFileSync(newPath, noteContent);
            console.error(`Updated note H1 to match rename`);
          } catch { /* ignore */ }
          notePath = newPath;
        }
      }

      console.error(`Rich checkpoint saved: ${basename(notePath)}`);
    } catch (noteError) {
      console.error(`Could not save checkpoint: ${noteError}`);
    }

    // Save cumulative state for next compaction
    saveCumulativeState(notesInfo.path, merged, notePath);

    // -----------------------------------------------------------------
    // Update TODO.md with proper ## Continue section (like "pause session")
    // -----------------------------------------------------------------
    if (hookInput.cwd && notePath) {
      try {
        const noteFilename = basename(notePath);
        updateTodoContinue(hookInput.cwd, noteFilename, state, tokenDisplay);
        console.error('TODO.md ## Continue section updated');
      } catch (todoError) {
        console.error(`Could not update TODO.md: ${todoError}`);
      }
    }

    // -----------------------------------------------------------------------
    // Save session state to temp file for post-compact injection.
    //
    // PreCompact hooks have NO stdout support (Claude Code ignores it).
    // Instead, we write the injection payload to a temp file keyed by
    // session_id. The SessionStart(compact) hook reads it and outputs
    // to stdout, which IS injected into the post-compaction context.
    //
    // Always fires (even with thin state) — includes note path so the AI
    // can enrich the session note post-compaction using its own context.
    // -----------------------------------------------------------------------
    if (hookInput.session_id) {
      const stateText = state || `Working directory: ${hookInput.cwd || 'unknown'}`;
      const noteInfo = notePath
        ? `\nSESSION NOTE: ${notePath}\nIf this note still has a generic title (e.g. "New Session", "Context Compression"),\nrename it based on actual work done and add a rich summary.`
        : '';

      const injection = [
        '<system-reminder>',
        `SESSION STATE RECOVERED AFTER COMPACTION (${compactType}, ~${tokenDisplay} tokens)`,
        '',
        stateText,
        noteInfo,
        '',
        'IMPORTANT: This session state was captured before context compaction.',
        'Use it to maintain continuity. Continue the conversation from where',
        'it left off without asking the user to repeat themselves.',
        'Continue with the last task that you were asked to work on.',
        '</system-reminder>',
      ].join('\n');

      try {
        const stateFile = join(tmpdir(), `pai-compact-state-${hookInput.session_id}.txt`);
        writeFileSync(stateFile, injection, 'utf-8');
        console.error(`Session state saved to ${stateFile} (${injection.length} chars)`);
      } catch (err) {
        console.error(`Failed to save state file: ${err}`);
      }
    }
  }

  // Send ntfy.sh notification
  const ntfyMessage = tokenCount > 0
    ? `Auto-pause: ~${Math.round(tokenCount / 1000)}k tokens`
    : 'Context compressing';
  await sendNtfyNotification(ntfyMessage);

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
