#!/usr/bin/env node

/**
 * SessionEnd Hook - Captures session summary for UOCS
 *
 * Generates a session summary document when a Claude Code session ends,
 * documenting what was accomplished during the session.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PAI_DIR, HISTORY_DIR } from '../lib/pai-paths';

interface SessionData {
  conversation_id: string;
  timestamp: string;
  [key: string]: any;
}

async function main() {
  try {
    // Read input from stdin FIRST — this must complete before CC's abort signal fires.
    // Then fork the heavy work into a detached child so CC can't kill it.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString('utf-8');
    if (!input || input.trim() === '') {
      process.exit(0);
    }

    // Fork: re-exec ourselves with --background flag and pipe the stdin data via env.
    // This detaches the heavy work (JSONL scan, IPC) from CC's abort signal.
    if (!process.env.__PAI_HOOK_BG) {
      const { spawn } = await import('child_process');
      const child = spawn(process.execPath, [process.argv[1], '--background'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, __PAI_HOOK_BG: '1', __PAI_HOOK_INPUT: input },
      });
      child.unref();
      process.exit(0); // Return immediately — CC sees success, abort signal is harmless
    }

    // Background mode: we're detached, safe from abort signals
    const data: SessionData = JSON.parse(process.env.__PAI_HOOK_INPUT || input);

    // Generate timestamp for filename
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/:/g, '')
      .replace(/\..+/, '')
      .replace('T', '-'); // YYYY-MM-DD-HHMMSS

    const yearMonth = timestamp.substring(0, 7); // YYYY-MM

    // Try to extract session info from raw outputs
    const sessionInfo = await analyzeSession(data.conversation_id, yearMonth);

    // Generate filename
    const filename = `${timestamp}_SESSION_${sessionInfo.focus}.md`;

    // Ensure directory exists
    const sessionDir = join(HISTORY_DIR, 'sessions', yearMonth);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    // Generate session document
    const sessionDoc = formatSessionDocument(timestamp, data, sessionInfo);

    // Write session file
    writeFileSync(join(sessionDir, filename), sessionDoc);

    // Also store structured summary via daemon IPC for the observations system
    await storeStructuredSummary(data.conversation_id, sessionInfo);

    // Exit successfully
    process.exit(0);
  } catch (error) {
    // Silent failure - don't disrupt workflow
    console.error(`[UOCS] SessionEnd hook error: ${error}`);
    process.exit(0);
  }
}

async function analyzeSession(conversationId: string, yearMonth: string): Promise<any> {
  // Try to read raw outputs for this session
  const rawOutputsDir = join(HISTORY_DIR, 'raw-outputs', yearMonth);

  let filesChanged: string[] = [];
  let commandsExecuted: string[] = [];
  let toolsUsed: Set<string> = new Set();

  try {
    if (existsSync(rawOutputsDir)) {
      // Only scan today's file — not the entire month (which can be 400MB+).
      // JSONL filenames are prefixed with YYYY-MM-DD.
      const todayPrefix = new Date().toISOString().substring(0, 10);
      const files = readdirSync(rawOutputsDir).filter(
        f => f.endsWith('.jsonl') && f.startsWith(todayPrefix)
      );

      for (const file of files) {
        const filePath = join(rawOutputsDir, file);
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.session === conversationId) {
              toolsUsed.add(entry.tool);

              // Extract file changes
              if (entry.tool === 'Edit' || entry.tool === 'Write') {
                if (entry.input?.file_path) {
                  filesChanged.push(entry.input.file_path);
                }
              }

              // Extract bash commands
              if (entry.tool === 'Bash' && entry.input?.command) {
                commandsExecuted.push(entry.input.command);
              }
            }
          } catch (e) {
            // Skip invalid JSON lines
          }
        }
      }
    }
  } catch (error) {
    // Silent failure
  }

  return {
    focus: 'general-work',
    filesChanged: [...new Set(filesChanged)].slice(0, 10), // Unique, max 10
    commandsExecuted: commandsExecuted.slice(0, 10), // Max 10
    toolsUsed: Array.from(toolsUsed),
    duration: 0 // Unknown
  };
}

function formatSessionDocument(timestamp: string, data: SessionData, info: any): string {
  const date = timestamp.substring(0, 10); // YYYY-MM-DD
  const time = timestamp.substring(11).replace(/-/g, ':'); // HH:MM:SS
  const da = process.env.DA || 'PAI';

  return `---
capture_type: SESSION
timestamp: ${new Date().toISOString()}
session_id: ${data.conversation_id}
duration_minutes: ${info.duration}
executor: ${da}
---

# Session: ${info.focus}

**Date:** ${date}
**Time:** ${time}
**Session ID:** ${data.conversation_id}

---

## Session Overview

**Focus:** General development work
**Duration:** ${info.duration > 0 ? `${info.duration} minutes` : 'Unknown'}

---

## Tools Used

${info.toolsUsed.length > 0 ? info.toolsUsed.map((t: string) => `- ${t}`).join('\n') : '- None recorded'}

---

## Files Modified

${info.filesChanged.length > 0 ? info.filesChanged.map((f: string) => `- \`${f}\``).join('\n') : '- None recorded'}

**Total Files Changed:** ${info.filesChanged.length}

---

## Commands Executed

${info.commandsExecuted.length > 0 ? '```bash\n' + info.commandsExecuted.join('\n') + '\n```' : 'None recorded'}

---

## Notes

This session summary was automatically generated by the UOCS SessionEnd hook.

For detailed tool outputs, see: \`\${PAI_DIR}/History/raw-outputs/${timestamp.substring(0, 7)}/\`

---

**Session Outcome:** Completed
**Generated:** ${new Date().toISOString()}
`;
}

async function storeStructuredSummary(
  sessionId: string,
  info: { focus: string; filesChanged: string[]; commandsExecuted: string[]; toolsUsed: string[]; duration: number }
): Promise<void> {
  try {
    const cwd = process.cwd();
    const net = await import('net');

    await new Promise<void>((resolve, _reject) => {
      const client = net.createConnection('/tmp/pai.sock', () => {
        const msg = JSON.stringify({
          id: 1,
          method: 'session_summary_store',
          params: {
            session_id: sessionId,
            cwd,
            request: null,      // We don't have the original request
            investigated: null,
            learned: null,
            completed: info.filesChanged.length > 0
              ? `Modified ${info.filesChanged.length} file(s): ${info.filesChanged.slice(0, 5).join(', ')}`
              : null,
            next_steps: null,
            observation_count: 0,   // Will be filled by daemon from actual count
          }
        }) + '\n';
        client.write(msg);
      });

      client.on('data', () => { client.end(); resolve(); });
      client.on('error', () => resolve());  // Silent failure
      setTimeout(() => { client.destroy(); resolve(); }, 3000);
    });
  } catch {
    // Silent failure — don't disrupt session end
  }
}

main();
