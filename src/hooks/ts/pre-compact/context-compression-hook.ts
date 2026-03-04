#!/usr/bin/env node
/**
 * PreCompact Hook - Triggered before context compression
 *
 * Two critical jobs:
 * 1. Save checkpoint to session note + send notification (existing)
 * 2. OUTPUT session state to stdout so it gets injected into the conversation
 *    as a <system-reminder> BEFORE compaction. This ensures the compaction
 *    summary retains awareness of what was being worked on.
 *
 * Without (2), compaction produces a generic summary and the session loses
 * critical context: current task, recent requests, file paths, decisions.
 */

import { readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  sendNtfyNotification,
  getCurrentNotePath,
  appendCheckpoint,
  addWorkToSessionNote,
  findNotesDir,
  findTodoPath,
  addTodoCheckpoint,
  calculateSessionTokens,
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
// Session state extraction
// ---------------------------------------------------------------------------

/**
 * Extract structured session state from the transcript JSONL.
 * Returns a human-readable summary (<2000 chars) suitable for injection
 * into the conversation before compaction.
 */
function extractSessionState(transcriptPath: string, cwd?: string): string | null {
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n');

    const userMessages: string[] = [];
    const summaries: string[] = [];
    const captures: string[] = [];
    let lastCompleted = '';
    const filesModified = new Set<string>();

    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }

      // --- User messages ---
      if (entry.type === 'user' && entry.message?.content) {
        const text = contentToText(entry.message.content).slice(0, 300);
        if (text) userMessages.push(text);
      }

      // --- Assistant structured sections ---
      if (entry.type === 'assistant' && entry.message?.content) {
        const text = contentToText(entry.message.content);

        const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
        if (summaryMatch) {
          const s = summaryMatch[1].trim();
          if (s.length > 5 && !summaries.includes(s)) summaries.push(s);
        }

        const captureMatch = text.match(/CAPTURE:\s*(.+?)(?:\n|$)/i);
        if (captureMatch) {
          const c = captureMatch[1].trim();
          if (c.length > 5 && !captures.includes(c)) captures.push(c);
        }

        const completedMatch = text.match(/COMPLETED:\s*(.+?)(?:\n|$)/i);
        if (completedMatch) {
          lastCompleted = completedMatch[1].trim().replace(/\*+/g, '');
        }
      }

      // --- Tool use: file modifications ---
      if (entry.type === 'assistant' && entry.message?.content && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use') {
            const tool = block.name;
            if ((tool === 'Edit' || tool === 'Write') && block.input?.file_path) {
              filesModified.add(block.input.file_path);
            }
          }
        }
      }
    }

    // Build the output — keep it concise
    const parts: string[] = [];

    if (cwd) {
      parts.push(`Working directory: ${cwd}`);
    }

    // Last 3 user messages
    const recentUser = userMessages.slice(-3);
    if (recentUser.length > 0) {
      parts.push('\nRecent user requests:');
      for (const msg of recentUser) {
        // Trim to first line or 200 chars
        const firstLine = msg.split('\n')[0].slice(0, 200);
        parts.push(`- ${firstLine}`);
      }
    }

    // Summaries (last 3)
    const recentSummaries = summaries.slice(-3);
    if (recentSummaries.length > 0) {
      parts.push('\nWork summaries:');
      for (const s of recentSummaries) {
        parts.push(`- ${s.slice(0, 150)}`);
      }
    }

    // Captures (last 5)
    const recentCaptures = captures.slice(-5);
    if (recentCaptures.length > 0) {
      parts.push('\nCaptured context:');
      for (const c of recentCaptures) {
        parts.push(`- ${c.slice(0, 150)}`);
      }
    }

    // Files modified (last 10)
    const files = Array.from(filesModified).slice(-10);
    if (files.length > 0) {
      parts.push('\nFiles modified this session:');
      for (const f of files) {
        parts.push(`- ${f}`);
      }
    }

    if (lastCompleted) {
      parts.push(`\nLast completed: ${lastCompleted.slice(0, 150)}`);
    }

    const result = parts.join('\n');
    return result.length > 50 ? result : null;
  } catch (err) {
    console.error(`extractSessionState error: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Work item extraction (same pattern as stop-hook.ts)
// ---------------------------------------------------------------------------

function extractWorkFromTranscript(transcriptPath: string): WorkItem[] {
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n');
    const workItems: WorkItem[] = [];
    const seenSummaries = new Set<string>();

    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry.type === 'assistant' && entry.message?.content) {
        const text = contentToText(entry.message.content);

        const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
        if (summaryMatch) {
          const summary = summaryMatch[1].trim();
          if (summary && !seenSummaries.has(summary) && summary.length > 5) {
            seenSummaries.add(summary);
            const details: string[] = [];
            const actionsMatch = text.match(/ACTIONS:\s*(.+?)(?=\n[A-Z]+:|$)/is);
            if (actionsMatch) {
              const actionLines = actionsMatch[1].split('\n')
                .map(l => l.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '').trim())
                .filter(l => l.length > 3 && l.length < 100);
              details.push(...actionLines.slice(0, 3));
            }
            workItems.push({ title: summary, details: details.length > 0 ? details : undefined, completed: true });
          }
        }

        const completedMatch = text.match(/COMPLETED:\s*(.+?)(?:\n|$)/i);
        if (completedMatch && workItems.length === 0) {
          const completed = completedMatch[1].trim().replace(/\*+/g, '');
          if (completed && !seenSummaries.has(completed) && completed.length > 5) {
            seenSummaries.add(completed);
            workItems.push({ title: completed, completed: true });
          }
        }
      }
    }
    return workItems;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
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
    // Persist session state to numbered session note (like "pause session")
    // -----------------------------------------------------------------
    const state = extractSessionState(hookInput.transcript_path, hookInput.cwd);

    try {
      // Find notes dir — prefer local, fallback to central
      const notesInfo = hookInput.cwd
        ? findNotesDir(hookInput.cwd)
        : { path: join(dirname(hookInput.transcript_path), 'Notes'), isLocal: false };
      const currentNotePath = getCurrentNotePath(notesInfo.path);

      if (currentNotePath) {
        // 1. Write rich checkpoint with full session state
        const checkpointBody = state
          ? `Context compression triggered at ~${tokenDisplay} tokens with ${stats.messageCount} messages.\n\n${state}`
          : `Context compression triggered at ~${tokenDisplay} tokens with ${stats.messageCount} messages.`;
        appendCheckpoint(currentNotePath, checkpointBody);

        // 2. Write work items to "Work Done" section (same as stop-hook)
        const workItems = extractWorkFromTranscript(hookInput.transcript_path);
        if (workItems.length > 0) {
          addWorkToSessionNote(currentNotePath, workItems, `Pre-Compact (~${tokenDisplay} tokens)`);
          console.error(`Added ${workItems.length} work item(s) to session note`);
        }

        console.error(`Rich checkpoint saved: ${basename(currentNotePath)}`);
      }
    } catch (noteError) {
      console.error(`Could not save checkpoint: ${noteError}`);
    }

    // -----------------------------------------------------------------
    // Update TODO.md with checkpoint (like "pause session")
    // -----------------------------------------------------------------
    if (hookInput.cwd && state) {
      try {
        addTodoCheckpoint(hookInput.cwd, `Pre-compact checkpoint (~${tokenDisplay} tokens):\n${state}`);
        console.error('TODO.md checkpoint added');
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
    // -----------------------------------------------------------------------
    if (state && hookInput.session_id) {
      const injection = [
        '<system-reminder>',
        `SESSION STATE RECOVERED AFTER COMPACTION (${compactType}, ~${tokenDisplay} tokens)`,
        '',
        state,
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
