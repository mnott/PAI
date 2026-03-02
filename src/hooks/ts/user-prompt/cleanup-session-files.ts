#!/usr/bin/env node
/**
 * cleanup-session-files.ts
 *
 * UserPromptSubmit hook that moves stray .jsonl files to sessions/ subdirectory.
 * This catches files from previous sessions that didn't exit cleanly.
 *
 * Runs on every user prompt - lightweight check, only moves files if needed.
 */

import { dirname, basename } from 'path';
import { moveSessionFilesToSessionsDir } from '../lib/project-utils';

interface HookInput {
  session_id: string;
  transcript_path: string;
}

async function main() {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString('utf-8');
    if (!input.trim()) return;

    const data: HookInput = JSON.parse(input);
    if (!data.transcript_path) return;

    const projectDir = dirname(data.transcript_path);
    const currentSessionFile = basename(data.transcript_path);

    // Move stray .jsonl files, excluding the current active session (silent mode)
    const movedCount = moveSessionFilesToSessionsDir(projectDir, currentSessionFile, true);

    if (movedCount > 0) {
      console.error(`Cleaned up ${movedCount} session file(s) to sessions/`);
    }
  } catch {
    // Silent failure - don't block user prompts
  }
}

main();
