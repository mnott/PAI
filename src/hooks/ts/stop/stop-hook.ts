#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, basename, dirname } from 'path';
import { connect } from 'net';
import { randomUUID } from 'crypto';
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAEMON_SOCKET = process.env.PAI_SOCKET ?? '/tmp/pai.sock';
const DAEMON_TIMEOUT_MS = 3_000;

/**
 * How many human messages must accumulate before triggering a mid-session
 * auto-save. Overrideable via the PAI_AUTO_SAVE_INTERVAL env var.
 */
const AUTO_SAVE_INTERVAL = (() => {
  const raw = process.env.PAI_AUTO_SAVE_INTERVAL;
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 15;
})();

// ---------------------------------------------------------------------------
// Session-state helpers (mid-session auto-save)
// ---------------------------------------------------------------------------

const SESSION_STATE_DIR = join(
  process.env.HOME ?? '/tmp',
  '.config',
  'pai',
  'session-state'
);

interface SessionState {
  humanMessageCount: number;
}

function readSessionState(sessionId: string): SessionState {
  try {
    const stateFile = join(SESSION_STATE_DIR, `${sessionId}.json`);
    if (!existsSync(stateFile)) return { humanMessageCount: 0 };
    const raw = readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    return {
      humanMessageCount: typeof parsed.humanMessageCount === 'number' ? parsed.humanMessageCount : 0,
    };
  } catch {
    return { humanMessageCount: 0 };
  }
}

function writeSessionState(sessionId: string, state: SessionState): void {
  try {
    mkdirSync(SESSION_STATE_DIR, { recursive: true });
    const stateFile = join(SESSION_STATE_DIR, `${sessionId}.json`);
    writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error(`STOP-HOOK: Could not write session state: ${e}`);
  }
}

function deleteSessionState(sessionId: string): void {
  try {
    const stateFile = join(SESSION_STATE_DIR, `${sessionId}.json`);
    if (existsSync(stateFile)) {
      unlinkSync(stateFile);
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Count human (user-role) messages in the transcript lines.
 */
function countHumanMessages(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.role === 'user') {
        count++;
      }
    } catch {
      // Skip invalid JSON
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Helper: safely convert Claude content (string | Block[]) to plain text
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: extract COMPLETED: line from the last assistant response
// ---------------------------------------------------------------------------

function extractCompletedMessage(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'assistant' && entry.message?.content) {
        const content = contentToText(entry.message.content);
        const m = content.match(/COMPLETED:\s*(.+?)(?:\n|$)/i);
        if (m) {
          return m[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
        }
      }
    } catch {
      // Skip invalid JSON
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Daemon IPC relay — fast path
// ---------------------------------------------------------------------------

/**
 * Try to enqueue work with the daemon over its Unix socket.
 * Returns true on success, false if the daemon is unreachable.
 * Times out after DAEMON_TIMEOUT_MS so the hook doesn't block.
 */
function enqueueWithDaemon(payload: {
  transcriptPath: string;
  cwd: string;
  message: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    function finish(ok: boolean): void {
      if (done) return;
      done = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      try { client.destroy(); } catch { /* ignore */ }
      resolve(ok);
    }

    const client = connect(DAEMON_SOCKET, () => {
      const msg = JSON.stringify({
        id: randomUUID(),
        method: 'work_queue_enqueue',
        params: {
          type: 'session-end',
          priority: 2,
          payload: {
            transcriptPath: payload.transcriptPath,
            cwd: payload.cwd,
            message: payload.message,
          },
        },
      }) + '\n';
      client.write(msg);
    });

    client.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      try {
        const response = JSON.parse(line) as { ok: boolean; error?: string };
        if (response.ok) {
          console.error(`STOP-HOOK: Work enqueued with daemon (id=${(response as any).result?.id}).`);
          finish(true);
        } else {
          console.error(`STOP-HOOK: Daemon rejected enqueue: ${response.error}`);
          finish(false);
        }
      } catch {
        finish(false);
      }
    });

    client.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
        console.error('STOP-HOOK: Daemon not running — falling back to direct execution.');
      } else {
        console.error(`STOP-HOOK: Daemon socket error: ${e.message}`);
      }
      finish(false);
    });

    client.on('end', () => { if (!done) finish(false); });

    timer = setTimeout(() => {
      console.error(`STOP-HOOK: Daemon timeout after ${DAEMON_TIMEOUT_MS}ms — falling back.`);
      finish(false);
    }, DAEMON_TIMEOUT_MS);
  });
}

/**
 * Enqueue a session-summary work item with `force: true` for mid-session auto-save.
 * Like the regular enqueueSessionSummaryWithDaemon but signals the daemon to
 * summarise even though the session is still ongoing.
 */
function enqueueMidSessionSummaryWithDaemon(payload: {
  cwd: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    function finish(ok: boolean): void {
      if (done) return;
      done = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      try { client.destroy(); } catch { /* ignore */ }
      resolve(ok);
    }

    const client = connect(DAEMON_SOCKET, () => {
      const msg = JSON.stringify({
        id: randomUUID(),
        method: 'work_queue_enqueue',
        params: {
          type: 'session-summary',
          priority: 3,
          payload: {
            cwd: payload.cwd,
            force: true,
          },
        },
      }) + '\n';
      client.write(msg);
    });

    client.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      try {
        const response = JSON.parse(line) as { ok: boolean; result?: { id: string } };
        if (response.ok) {
          debug(`STOP-HOOK: Mid-session summary enqueued (id=${response.result?.id}).`);
        }
      } catch { /* ignore */ }
      finish(true);
    });

    client.on('error', () => finish(false));
    client.on('end', () => { if (!done) finish(false); });

    timer = setTimeout(() => finish(false), DAEMON_TIMEOUT_MS);
  });
}

/**
 * Enqueue a session-summary work item with the daemon for AI-powered note generation.
 * Non-blocking — if daemon is unavailable, silently skips (the mechanical note is sufficient).
 *
 * Note: we intentionally omit transcriptPath here to let the worker call findLatestJsonl()
 * itself. At session-end, Claude Code may still be moving the JSONL to sessions/, so a
 * stale path passed from the hook could point to a file that no longer exists.
 */
function enqueueSessionSummaryWithDaemon(payload: {
  cwd: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    function finish(ok: boolean): void {
      if (done) return;
      done = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      try { client.destroy(); } catch { /* ignore */ }
      resolve(ok);
    }

    const client = connect(DAEMON_SOCKET, () => {
      const msg = JSON.stringify({
        id: randomUUID(),
        method: 'work_queue_enqueue',
        params: {
          type: 'session-summary',
          priority: 4,
          payload: {
            cwd: payload.cwd,
            force: true,
          },
        },
      }) + '\n';
      client.write(msg);
    });

    client.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      try {
        const response = JSON.parse(line) as { ok: boolean; result?: { id: string } };
        if (response.ok) {
          debug(`STOP-HOOK: Session summary enqueued (id=${response.result?.id}).`);
        }
      } catch { /* ignore */ }
      finish(true);
    });

    client.on('error', () => finish(false));
    client.on('end', () => { if (!done) finish(false); });

    timer = setTimeout(() => finish(false), DAEMON_TIMEOUT_MS);
  });
}

// ---------------------------------------------------------------------------
// Direct execution — fallback path (original stop-hook logic)
// ---------------------------------------------------------------------------

/**
 * Extract work items from transcript for session note.
 * Looks for SUMMARY, ACTIONS, RESULTS sections in assistant responses.
 */
function extractWorkFromTranscript(lines: string[]): WorkItem[] {
  const workItems: WorkItem[] = [];
  const seenSummaries = new Set<string>();

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

            // Try to extract details from ACTIONS section
            const details: string[] = [];
            const actionsMatch = content.match(/ACTIONS:\s*(.+?)(?=\n[A-Z]+:|$)/is);
            if (actionsMatch) {
              const actionLines = actionsMatch[1].split('\n')
                .map(l => l.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '').trim())
                .filter(l => l.length > 3 && l.length < 100);
              details.push(...actionLines.slice(0, 3));
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
          const completed = completedMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '');
          if (completed && !seenSummaries.has(completed) && completed.length > 5) {
            seenSummaries.add(completed);
            workItems.push({ title: completed, completed: true });
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
 * Generate 4-word tab title summarizing what was done.
 */
function generateTabTitle(prompt: string, completedLine?: string): string {
  if (completedLine) {
    const cleanCompleted = completedLine
      .replace(/\*+/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/COMPLETED:\s*/gi, '')
      .trim();

    const completedWords = cleanCompleted.split(/\s+/)
      .filter(word => word.length > 2 &&
        !['the', 'and', 'but', 'for', 'are', 'with', 'his', 'her', 'this', 'that', 'you', 'can', 'will', 'have', 'been', 'your', 'from', 'they', 'were', 'said', 'what', 'them', 'just', 'told', 'how', 'does', 'into', 'about', 'completed'].includes(word.toLowerCase()))
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());

    if (completedWords.length >= 2) {
      const summary = completedWords.slice(0, 4);
      while (summary.length < 4) summary.push('Done');
      return summary.slice(0, 4).join(' ');
    }
  }

  const cleanPrompt = prompt.replace(/[^\w\s]/g, ' ').trim();
  const words = cleanPrompt.split(/\s+/).filter(word =>
    word.length > 2 &&
    !['the', 'and', 'but', 'for', 'are', 'with', 'his', 'her', 'this', 'that', 'you', 'can', 'will', 'have', 'been', 'your', 'from', 'they', 'were', 'said', 'what', 'them', 'just', 'told', 'how', 'does', 'into', 'about'].includes(word.toLowerCase())
  );

  const lowerPrompt = prompt.toLowerCase();
  const actionVerbs = ['test', 'rename', 'fix', 'debug', 'research', 'write', 'create', 'make', 'build', 'implement', 'analyze', 'review', 'update', 'modify', 'generate', 'develop', 'design', 'deploy', 'configure', 'setup', 'install', 'remove', 'delete', 'add', 'check', 'verify', 'validate', 'optimize', 'refactor', 'enhance', 'improve', 'send', 'email', 'help', 'updated', 'fixed', 'created', 'built', 'added'];
  let titleWords: string[] = [];

  for (const verb of actionVerbs) {
    if (lowerPrompt.includes(verb)) {
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

  const remainingWords = words
    .filter(word => !actionVerbs.includes(word.toLowerCase()))
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());

  for (const word of remainingWords) {
    if (titleWords.length < 4) titleWords.push(word);
    else break;
  }

  if (titleWords.length === 0) titleWords.push('Completed');
  if (titleWords.length === 1) titleWords.push('Task');
  if (titleWords.length === 2) titleWords.push('Successfully');
  if (titleWords.length === 3) titleWords.push('Done');

  return titleWords.slice(0, 4).join(' ');
}

/**
 * Do the heavy work directly in the hook process.
 * Used when the daemon is unreachable.
 */
async function executeDirectly(
  lines: string[],
  transcriptPath: string,
  cwd: string,
  message: string,
  lastUserQuery: string
): Promise<void> {
  // Set terminal tab title
  let tabTitle = message || '';
  if (!tabTitle && lastUserQuery) {
    tabTitle = generateTabTitle(lastUserQuery, '');
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

  // Final tab title override
  if (message) {
    const finalTabTitle = message.slice(0, 50);
    process.stderr.write(`\x1b]2;${finalTabTitle}\x07`);
  }

  // Finalize session note
  try {
    const notesInfo = findNotesDir(cwd);
    const currentNotePath = getCurrentNotePath(notesInfo.path);

    if (currentNotePath) {
      const workItems = extractWorkFromTranscript(lines);
      if (workItems.length > 0) {
        addWorkToSessionNote(currentNotePath, workItems);
        console.error(`Added ${workItems.length} work item(s) to session note`);
      } else if (message) {
        addWorkToSessionNote(currentNotePath, [{ title: message, completed: true }]);
        console.error(`Added completion message to session note`);
      }

      const summary = message || 'Session completed.';
      finalizeSessionNote(currentNotePath, summary);
      console.error(`Session note finalized: ${basename(currentNotePath)}`);

      try {
        const stateLines: string[] = [];
        stateLines.push(`Working directory: ${cwd}`);
        if (workItems.length > 0) {
          stateLines.push('', 'Work completed:');
          for (const item of workItems.slice(0, 5)) {
            stateLines.push(`- ${item.title}`);
          }
        }
        if (message) {
          stateLines.push('', `Last completed: ${message}`);
        }
        updateTodoContinue(cwd, basename(currentNotePath), stateLines.join('\n'), 'session-end');
      } catch (todoError) {
        console.error(`Could not update TODO.md: ${todoError}`);
      }
    }
  } catch (noteError) {
    console.error(`Could not finalize session note: ${noteError}`);
  }

  // Move session .jsonl files to sessions/
  try {
    const transcriptDir = dirname(transcriptPath);
    const movedCount = moveSessionFilesToSessionsDir(transcriptDir);
    if (movedCount > 0) {
      console.error(`Moved ${movedCount} session file(s) to sessions/`);
    }
  } catch (moveError) {
    console.error(`Could not move session files: ${moveError}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Debug logging only when PAI_HOOK_DEBUG=1 — otherwise stop-hook is silent
const DEBUG = process.env.PAI_HOOK_DEBUG === '1';
function debug(msg: string): void {
  if (DEBUG) console.error(msg);
}

async function main() {
  if (isProbeSession()) {
    process.exit(0);
  }

  const timestamp = new Date().toISOString();
  debug(`\nSTOP-HOOK TRIGGERED AT ${timestamp}`);

  // Read stdin
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
  let stopHookActive: boolean = false;
  let sessionId: string = '';
  try {
    const parsed = JSON.parse(input);
    transcriptPath = parsed.transcript_path;
    cwd = parsed.cwd || process.cwd();
    stopHookActive = parsed.stop_hook_active === true;
    // session_id may appear directly or be derivable from the transcript path
    sessionId = parsed.session_id ?? basename(transcriptPath ?? '').replace(/\.jsonl$/, '');
    debug(`Transcript path: ${transcriptPath}`);
    debug(`Working directory: ${cwd}`);
    debug(`stop_hook_active: ${stopHookActive}`);
    debug(`session_id: ${sessionId}`);
  } catch (e) {
    console.error(`Error parsing input JSON: ${e}`);
    process.exit(0);
  }

  if (!transcriptPath) {
    console.error('No transcript_path in input');
    process.exit(0);
  }

  // Read transcript
  let transcript: string;
  try {
    transcript = readFileSync(transcriptPath, 'utf-8');
    debug(`Transcript loaded: ${transcript.split('\n').length} lines`);
  } catch (e) {
    console.error(`Error reading transcript: ${e}`);
    process.exit(0);
  }

  const lines = transcript.trim().split('\n');

  // ---------------------------------------------------------------------------
  // Mid-session auto-save check
  // ---------------------------------------------------------------------------
  // When stop_hook_active is FALSE (normal Stop event, not a re-entry from our
  // own exit-code-2 block), we check whether enough human messages have
  // accumulated to warrant an interim session summary.
  //
  // When stop_hook_active is TRUE the hook is already in the blocked-loop mode
  // we triggered on the previous fire, so we skip the check entirely and proceed
  // with normal session-end logic.
  //
  // Failure of this entire block must never abort the normal flow — wrap it all.
  if (!stopHookActive && sessionId) {
    try {
      const currentMsgCount = countHumanMessages(lines);
      const state = readSessionState(sessionId);
      const prevCount = state.humanMessageCount;
      const newMessages = currentMsgCount - prevCount;

      debug(
        `STOP-HOOK: human messages — total=${currentMsgCount} prev=${prevCount} new=${newMessages} interval=${AUTO_SAVE_INTERVAL}`
      );

      // First-run safeguard: if the state file is missing and we're looking at
      // a session that already has more than 2x the interval in messages, it's
      // an existing long-running session that predates the auto-save feature.
      // Initialize the counter to the current count instead of auto-saving
      // immediately — otherwise every new message triggers a save.
      if (prevCount === 0 && currentMsgCount > AUTO_SAVE_INTERVAL * 2) {
        writeSessionState(sessionId, { humanMessageCount: currentMsgCount });
        debug(
          `STOP-HOOK: First-run safeguard — initializing counter to ${currentMsgCount} (session predates auto-save feature).`
        );
      } else if (newMessages >= AUTO_SAVE_INTERVAL) {
        // Reset the counter so we don't re-trigger on the next fire.
        writeSessionState(sessionId, { humanMessageCount: currentMsgCount });

        debug(`STOP-HOOK: Auto-save threshold reached. Triggering mid-session summary.`);

        // Fire-and-forget: push session-summary to daemon.
        // We used to exit(2) to block the Stop, but Claude Code surfaces that
        // as "Stop hook error" in the terminal — annoying cosmetic noise.
        // The whisper rules already enforce "never stop" behavior, so blocking
        // is redundant. Just fire the work item and exit 0 silently.
        try {
          await enqueueMidSessionSummaryWithDaemon({ cwd });
        } catch { /* daemon may not be running — non-fatal */ }
      } else {
        // Update the stored count so we can measure delta on next fire.
        writeSessionState(sessionId, { humanMessageCount: currentMsgCount });
      }
    } catch (autoSaveError) {
      // Never let auto-save logic block the normal Stop flow.
      console.error(`STOP-HOOK: Auto-save check failed (non-fatal): ${autoSaveError}`);
    }
  }

  // Extract last user query for tab title / fallback
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
    } catch {
      // Skip invalid JSON
    }
  }

  // Extract completion message
  const message = extractCompletedMessage(lines);

  console.error(`User query: ${lastUserQuery || 'No query found'}`);
  console.error(`Message: ${message || 'No completion message'}`);

  // Always set terminal tab title immediately (fast, no daemon needed)
  let tabTitle = message || '';
  if (!tabTitle && lastUserQuery) {
    tabTitle = generateTabTitle(lastUserQuery, '');
  }
  if (tabTitle) {
    try {
      const { execSync } = await import('child_process');
      const escapedTitle = tabTitle.replace(/'/g, "'\\''");
      execSync(`printf '\\033]0;${escapedTitle}\\007' >&2`);
      execSync(`printf '\\033]2;${escapedTitle}\\007' >&2`);
      execSync(`printf '\\033]30;${escapedTitle}\\007' >&2`);
      console.error(`Tab title set to: "${tabTitle}"`);
    } catch (e) {
      console.error(`Failed to set tab title: ${e}`);
    }
  }
  if (message) {
    process.stderr.write(`\x1b]2;${message.slice(0, 50)}\x07`);
  }

  // Send ntfy.sh notification (fast, fire-and-forget)
  if (message) {
    await sendNtfyNotification(message);
  } else {
    await sendNtfyNotification('Session ended');
  }

  // -----------------------------------------------------------------------
  // Relay heavy work to daemon — fall back to direct execution if unavailable
  // -----------------------------------------------------------------------
  const relayed = await enqueueWithDaemon({
    transcriptPath,
    cwd,
    message,
  });

  if (!relayed) {
    console.error('STOP-HOOK: Using direct execution fallback.');
    await executeDirectly(lines, transcriptPath, cwd, message, lastUserQuery);
  }

  // Also enqueue a session-summary for AI-powered note generation.
  // We omit transcriptPath so the worker resolves it via findLatestJsonl(),
  // avoiding a race where the session-end hook moves the JSONL before the worker reads it.
  await enqueueSessionSummaryWithDaemon({ cwd });

  // Clean up the session-state file now that the session has truly ended.
  if (sessionId) {
    deleteSessionState(sessionId);
    debug(`STOP-HOOK: Session state cleaned up for ${sessionId}.`);
  }

  debug(`STOP-HOOK COMPLETED SUCCESSFULLY at ${new Date().toISOString()}\n`);
}

main().catch(() => {});
