#!/usr/bin/env node

/**
 * SessionEnd Hook - Captures session summary for UOCS
 *
 * Generates a session summary document when a Claude Code session ends,
 * documenting what was accomplished during the session.
 */

import { paiSocketPath } from "../../../runtime-paths.js";
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { historyDir } from '../lib/pai-paths.js';
import { analyzeSession, formatSessionDocument } from '../lib/session-summary.js';

interface SessionData {
  session_id: string;
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
    // The detached child has stdin ignored; its payload comes from the temp file.
    if ((!input || input.trim() === '') && !process.env.__PAI_HOOK_INPUT_FILE) {
      process.exit(0);
    }

    // Fork: re-exec ourselves with --background flag and hand the stdin data over via a private temp file
    // (an env var is visible to ps eww and hits E2BIG on large payloads).
    // This detaches the heavy work (JSONL scan, IPC) from CC's abort signal.
    if (!process.env.__PAI_HOOK_BG) {
      const { spawn } = await import('child_process');
      const inputFile = join(tmpdir(), `pai-session-end-${process.pid}-${Date.now()}.json`);
      writeFileSync(inputFile, input, { mode: 0o600 });
      const child = spawn(process.execPath, [process.argv[1], '--background'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, __PAI_HOOK_BG: '1', __PAI_HOOK_INPUT_FILE: inputFile },
      });
      child.unref();
      process.exit(0); // Return immediately — CC sees success, abort signal is harmless
    }

    // Background mode: we're detached, safe from abort signals
    const inputFile = process.env.__PAI_HOOK_INPUT_FILE;
    let raw = input;
    if (inputFile) {
      raw = readFileSync(inputFile, 'utf-8');
      try { unlinkSync(inputFile); } catch { /* ignore */ }
    }
    const data: SessionData = JSON.parse(raw);

    // Generate timestamp for filename
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/:/g, '')
      .replace(/\..+/, '')
      .replace('T', '-'); // YYYY-MM-DD-HHMMSS

    const yearMonth = timestamp.substring(0, 7); // YYYY-MM

    // Try to extract session info from raw outputs
    const sessionInfo = await analyzeSession(data.session_id, yearMonth);

    // Generate filename
    const filename = `${timestamp}_SESSION_${sessionInfo.focus}.md`;

    // Ensure directory exists
    const sessionDir = join(historyDir(), 'sessions', yearMonth);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    // Generate session document
    const sessionDoc = formatSessionDocument(timestamp, data, sessionInfo);

    // Write session file
    writeFileSync(join(sessionDir, filename), sessionDoc);

    // Also store structured summary via daemon IPC for the observations system
    await storeStructuredSummary(data.session_id, sessionInfo);

    // Exit successfully
    process.exit(0);
  } catch (error) {
    // Silent failure - don't disrupt workflow
    console.error(`[UOCS] SessionEnd hook error: ${error}`);
    process.exit(0);
  }
}

async function storeStructuredSummary(
  sessionId: string,
  info: { focus: string; filesChanged: string[]; commandsExecuted: string[]; toolsUsed: string[]; duration: number }
): Promise<void> {
  try {
    const cwd = process.cwd();
    const net = await import('net');

    await new Promise<void>((resolve, _reject) => {
      const client = net.createConnection(paiSocketPath(), () => {
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
