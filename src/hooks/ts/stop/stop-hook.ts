#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import {
  sendNtfyNotification,
  getCurrentNotePath,
  finalizeSessionNote,
  moveSessionFilesToSessionsDir,
  addWorkToSessionNote,
  findNotesDir,
  isProbeSession,
  updateTodoContinue,
  WorkItem
} from '../lib/project-utils';

/**
 * Extract work items from transcript for session note
 * Looks for SUMMARY, ACTIONS, RESULTS sections in assistant responses
 */
function extractWorkFromTranscript(lines: string[]): WorkItem[] {
  const workItems: WorkItem[] = [];
  const seenSummaries = new Set<string>();

  // Process all assistant messages to find work summaries
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'assistant' && entry.message?.content) {
        const content = contentToText(entry.message.content);

        // Look for SUMMARY: lines (our standard format)
        const summaryMatch = content.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
        if (summaryMatch) {
          const summary = summaryMatch[1].trim();
          if (summary && !seenSummaries.has(summary) && summary.length > 5) {
            seenSummaries.add(summary);

            // Try to extract details from ACTIONS or RESULTS
            const details: string[] = [];

            const actionsMatch = content.match(/ACTIONS:\s*(.+?)(?=\n[A-Z]+:|$)/is);
            if (actionsMatch) {
              // Extract bullet points or numbered items
              const actionLines = actionsMatch[1].split('\n')
                .map(l => l.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '').trim())
                .filter(l => l.length > 3 && l.length < 100);
              details.push(...actionLines.slice(0, 3)); // Max 3 action items
            }

            workItems.push({
              title: summary,
              details: details.length > 0 ? details : undefined,
              completed: true
            });
          }
        }

        // Also look for COMPLETED: lines as backup
        const completedMatch = content.match(/COMPLETED:\s*(.+?)(?:\n|$)/i);
        if (completedMatch && workItems.length === 0) {
          const completed = completedMatch[1].trim().replace(/\*+/g, '');
          if (completed && !seenSummaries.has(completed) && completed.length > 5) {
            seenSummaries.add(completed);
            workItems.push({
              title: completed,
              completed: true
            });
          }
        }
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  return workItems;
}

/**
 * Generate 4-word tab title summarizing what was done
 */
function generateTabTitle(prompt: string, completedLine?: string): string {
  // If we have a completed line, try to use it for a better summary
  if (completedLine) {
    const cleanCompleted = completedLine
      .replace(/\*+/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/COMPLETED:\s*/gi, '')
      .trim();

    // Extract meaningful words from the completed line
    const completedWords = cleanCompleted.split(/\s+/)
      .filter(word => word.length > 2 &&
        !['the', 'and', 'but', 'for', 'are', 'with', 'his', 'her', 'this', 'that', 'you', 'can', 'will', 'have', 'been', 'your', 'from', 'they', 'were', 'said', 'what', 'them', 'just', 'told', 'how', 'does', 'into', 'about', 'completed'].includes(word.toLowerCase()))
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());

    if (completedWords.length >= 2) {
      // Build a 4-word summary from completed line
      const summary = completedWords.slice(0, 4);
      while (summary.length < 4) {
        summary.push('Done');
      }
      return summary.slice(0, 4).join(' ');
    }
  }

  // Fall back to parsing the prompt
  const cleanPrompt = prompt.replace(/[^\w\s]/g, ' ').trim();
  const words = cleanPrompt.split(/\s+/).filter(word =>
    word.length > 2 &&
    !['the', 'and', 'but', 'for', 'are', 'with', 'his', 'her', 'this', 'that', 'you', 'can', 'will', 'have', 'been', 'your', 'from', 'they', 'were', 'said', 'what', 'them', 'just', 'told', 'how', 'does', 'into', 'about'].includes(word.toLowerCase())
  );

  const lowerPrompt = prompt.toLowerCase();

  // Find action verb if present
  const actionVerbs = ['test', 'rename', 'fix', 'debug', 'research', 'write', 'create', 'make', 'build', 'implement', 'analyze', 'review', 'update', 'modify', 'generate', 'develop', 'design', 'deploy', 'configure', 'setup', 'install', 'remove', 'delete', 'add', 'check', 'verify', 'validate', 'optimize', 'refactor', 'enhance', 'improve', 'send', 'email', 'help', 'updated', 'fixed', 'created', 'built', 'added'];

  let titleWords: string[] = [];

  // Check for action verb
  for (const verb of actionVerbs) {
    if (lowerPrompt.includes(verb)) {
      // Convert to past tense for summary
      let pastTense = verb;
      if (verb === 'write') pastTense = 'Wrote';
      else if (verb === 'make') pastTense = 'Made';
      else if (verb === 'send') pastTense = 'Sent';
      else if (verb.endsWith('e')) pastTense = verb.charAt(0).toUpperCase() + verb.slice(1, -1) + 'ed';
      else pastTense = verb.charAt(0).toUpperCase() + verb.slice(1) + 'ed';

      titleWords.push(pastTense);
      break;
    }
  }

  // Add most meaningful remaining words
  const remainingWords = words
    .filter(word => !actionVerbs.includes(word.toLowerCase()))
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());

  // Fill up to 4 words total
  for (const word of remainingWords) {
    if (titleWords.length < 4) {
      titleWords.push(word);
    } else {
      break;
    }
  }

  // If we don't have enough words, add generic ones
  if (titleWords.length === 0) {
    titleWords.push('Completed');
  }
  if (titleWords.length === 1) {
    titleWords.push('Task');
  }
  if (titleWords.length === 2) {
    titleWords.push('Successfully');
  }
  if (titleWords.length === 3) {
    titleWords.push('Done');
  }

  return titleWords.slice(0, 4).join(' ');
}

/**
 * Set terminal tab title (works with Kitty, Ghostty, iTerm2, etc.)
 */
function setTerminalTabTitle(title: string): void {
  const term = process.env.TERM || '';

  if (term.includes('ghostty')) {
    process.stderr.write(`\x1b]2;${title}\x07`);
    process.stderr.write(`\x1b]0;${title}\x07`);
    process.stderr.write(`\x1b]7;${title}\x07`);
    process.stderr.write(`\x1b]2;${title}\x1b\\`);
  } else if (term.includes('kitty')) {
    process.stderr.write(`\x1b]0;${title}\x07`);
    process.stderr.write(`\x1b]2;${title}\x07`);
    process.stderr.write(`\x1b]30;${title}\x07`);
  } else {
    process.stderr.write(`\x1b]0;${title}\x07`);
    process.stderr.write(`\x1b]2;${title}\x07`);
  }

  if (process.stderr.isTTY) {
    process.stderr.write('');
  }
}

// Helper to safely turn Claude content (string or array of blocks) into plain text
function contentToText(content: any): string {
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

async function main() {
  // Skip probe/health-check sessions (e.g. CodexBar ClaudeProbe)
  if (isProbeSession()) {
    process.exit(0);
  }

  const timestamp = new Date().toISOString();
  console.error(`\nSTOP-HOOK TRIGGERED AT ${timestamp}`);

  // Get input
  let input = '';
  const decoder = new TextDecoder();

  try {
    for await (const chunk of process.stdin) {
      input += decoder.decode(chunk, { stream: true });
    }
  } catch (e) {
    console.error(`Error reading input: ${e}`);
    process.exit(0);
  }

  if (!input) {
    console.error('No input received');
    process.exit(0);
  }

  let transcriptPath: string;
  let cwd: string;
  try {
    const parsed = JSON.parse(input);
    transcriptPath = parsed.transcript_path;
    cwd = parsed.cwd || process.cwd();
    console.error(`Transcript path: ${transcriptPath}`);
    console.error(`Working directory: ${cwd}`);
  } catch (e) {
    console.error(`Error parsing input JSON: ${e}`);
    process.exit(0);
  }

  if (!transcriptPath) {
    console.error('No transcript_path in input');
    process.exit(0);
  }

  // Read the transcript
  let transcript;
  try {
    transcript = readFileSync(transcriptPath, 'utf-8');
    console.error(`Transcript loaded: ${transcript.split('\n').length} lines`);
  } catch (e) {
    console.error(`Error reading transcript: ${e}`);
    process.exit(0);
  }

  // Parse the JSON lines to find what happened in this session
  const lines = transcript.trim().split('\n');

  // Get the last user query for context
  let lastUserQuery = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'user' && entry.message?.content) {
        const content = entry.message.content;
        if (typeof content === 'string') {
          lastUserQuery = content;
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'text' && item.text) {
              lastUserQuery = item.text;
              break;
            }
          }
        }
        if (lastUserQuery) break;
      }
    } catch (e) {
      // Skip invalid JSON
    }
  }

  // Extract the completion message from the last assistant response
  let message = '';

  const lastResponse = lines[lines.length - 1];
  try {
    const entry = JSON.parse(lastResponse);
    if (entry.type === 'assistant' && entry.message?.content) {
      const content = contentToText(entry.message.content);

      // Look for COMPLETED line
      const completedMatch = content.match(/COMPLETED:\s*(.+?)(?:\n|$)/i);
      if (completedMatch) {
        message = completedMatch[1].trim()
          .replace(/\*+/g, '')
          .replace(/\[.*?\]/g, '')
          .trim();
        console.error(`COMPLETION: ${message}`);
      }
    }
  } catch (e) {
    console.error('Error parsing assistant response:', e);
  }

  // Set tab title
  let tabTitle = message || '';

  if (!tabTitle && lastUserQuery) {
    try {
      const entry = JSON.parse(lastResponse);
      if (entry.type === 'assistant' && entry.message?.content) {
        const content = contentToText(entry.message.content);
        const completedMatch = content.match(/COMPLETED:\s*(.+?)(?:\n|$)/im);
        if (completedMatch) {
          tabTitle = completedMatch[1].trim()
            .replace(/\*+/g, '')
            .replace(/\[.*?\]/g, '')
            .trim();
        }
      }
    } catch (e) {}

    if (!tabTitle) {
      tabTitle = generateTabTitle(lastUserQuery, '');
    }
  }

  if (tabTitle) {
    try {
      const escapedTitle = tabTitle.replace(/'/g, "'\\''");
      const { execSync } = await import('child_process');
      execSync(`printf '\\033]0;${escapedTitle}\\007' >&2`);
      execSync(`printf '\\033]2;${escapedTitle}\\007' >&2`);
      execSync(`printf '\\033]30;${escapedTitle}\\007' >&2`);
      console.error(`Tab title set to: "${tabTitle}"`);
    } catch (e) {
      console.error(`Failed to set tab title: ${e}`);
    }
  }

  console.error(`User query: ${lastUserQuery || 'No query found'}`);
  console.error(`Message: ${message || 'No completion message'}`);

  // Final tab title override as the very last action
  if (message) {
    const finalTabTitle = message.slice(0, 50);
    process.stderr.write(`\x1b]2;${finalTabTitle}\x07`);
  }

  // Send ntfy.sh notification
  if (message) {
    await sendNtfyNotification(message);
  } else {
    await sendNtfyNotification('Session ended');
  }

  // Finalize session note if one exists
  try {
    const notesInfo = findNotesDir(cwd);
    console.error(`Notes directory: ${notesInfo.path} (${notesInfo.isLocal ? 'local' : 'central'})`);
    const currentNotePath = getCurrentNotePath(notesInfo.path);

    if (currentNotePath) {
      // FIRST: Extract and add work items from transcript
      const workItems = extractWorkFromTranscript(lines);
      if (workItems.length > 0) {
        addWorkToSessionNote(currentNotePath, workItems);
        console.error(`Added ${workItems.length} work item(s) to session note`);
      } else {
        // If no structured work items found, at least add the completion message
        if (message) {
          addWorkToSessionNote(currentNotePath, [{
            title: message,
            completed: true
          }]);
          console.error(`Added completion message to session note`);
        }
      }

      // THEN: Finalize the note
      const summary = message || 'Session completed.';
      finalizeSessionNote(currentNotePath, summary);
      console.error(`Session note finalized: ${basename(currentNotePath)}`);

      // Update TODO.md ## Continue section so next session has context
      try {
        const stateLines: string[] = [];
        stateLines.push(`Working directory: ${cwd}`);
        if (workItems.length > 0) {
          stateLines.push('');
          stateLines.push('Work completed:');
          for (const item of workItems.slice(0, 5)) {
            stateLines.push(`- ${item.title}`);
          }
        }
        if (message) {
          stateLines.push('');
          stateLines.push(`Last completed: ${message}`);
        }
        const state = stateLines.join('\n');
        updateTodoContinue(cwd, basename(currentNotePath), state, 'session-end');
      } catch (todoError) {
        console.error(`Could not update TODO.md: ${todoError}`);
      }
    }
  } catch (noteError) {
    console.error(`Could not finalize session note: ${noteError}`);
  }

  // Move all session .jsonl files to sessions/ subdirectory
  try {
    const transcriptDir = dirname(transcriptPath);
    const movedCount = moveSessionFilesToSessionsDir(transcriptDir);
    if (movedCount > 0) {
      console.error(`Moved ${movedCount} session file(s) to sessions/`);
    }
  } catch (moveError) {
    console.error(`Could not move session files: ${moveError}`);
  }

  console.error(`STOP-HOOK COMPLETED SUCCESSFULLY at ${new Date().toISOString()}\n`);
}

main().catch(() => {});
