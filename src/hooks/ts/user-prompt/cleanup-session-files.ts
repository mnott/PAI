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
import { archiveSessionFilesToSessionsDir } from '../lib/project-utils';

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

    // Archive stray .jsonl files, excluding this session's own transcript.
    //
    // That exclusion is narrow, and worth stating precisely because it is easy to
    // read as more: it keeps a hook from archiving the very file it is watching
    // being written. It does NOT make the archive "finished sessions only" — it
    // excludes exactly one file, the caller's. With two sessions live in one
    // project, each one's prompt still archives the other's in-progress
    // transcript.
    //
    // Harmless now that archiving is a hardlink and nothing is destroyed. If a
    // consumer ever needs "finished only", the guard belongs in that consumer —
    // session-summary-worker could skip a transcript modified seconds ago, or one
    // whose uuid is in AIBroker's live-session list. The archiver cannot know
    // what is live and should not pretend to.
    const archivedCount = archiveSessionFilesToSessionsDir(projectDir, currentSessionFile, true);

    if (archivedCount > 0) {
      console.error(`Archived ${archivedCount} session file(s) to sessions/`);
    }
  } catch {
    // Silent failure - don't block user prompts
  }
}

main();
