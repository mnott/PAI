#!/usr/bin/env node
/**
 * PreCompact Hook - Triggered before context compression
 * Extracts context information from transcript and notifies about compression
 *
 * Enhanced to:
 * - Save checkpoint to current session note
 * - Send ntfy.sh notification
 * - Calculate approximate token count
 */

import { readFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import {
  sendNtfyNotification,
  getCurrentNotePath,
  appendCheckpoint,
  calculateSessionTokens
} from '../lib/project-utils';

interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
  compact_type?: string;
}

interface TranscriptEntry {
  type: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text: string;
    }>
  };
  timestamp?: string;
}

/**
 * Count messages in transcript to provide context
 */
function getTranscriptStats(transcriptPath: string): { messageCount: number; isLarge: boolean } {
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');

    let userMessages = 0;
    let assistantMessages = 0;

    for (const line of lines) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line) as TranscriptEntry;
          if (entry.type === 'user') {
            userMessages++;
          } else if (entry.type === 'assistant') {
            assistantMessages++;
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    }

    const totalMessages = userMessages + assistantMessages;
    const isLarge = totalMessages > 50; // Consider large if more than 50 messages

    return { messageCount: totalMessages, isLarge };
  } catch (error) {
    return { messageCount: 0, isLarge: false };
  }
}

async function main() {
  let hookInput: HookInput | null = null;

  try {
    // Read the JSON input from stdin
    const decoder = new TextDecoder();
    let input = '';

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500);
    });

    const readPromise = (async () => {
      for await (const chunk of process.stdin) {
        input += decoder.decode(chunk, { stream: true });
      }
    })();

    await Promise.race([readPromise, timeoutPromise]);

    if (input.trim()) {
      hookInput = JSON.parse(input) as HookInput;
    }
  } catch (error) {
    // Silently handle input errors
  }

  // Determine the type of compression
  const compactType = hookInput?.compact_type || 'auto';
  let message = 'Compressing context to continue';

  // Get transcript statistics if available
  let tokenCount = 0;
  if (hookInput && hookInput.transcript_path) {
    const stats = getTranscriptStats(hookInput.transcript_path);

    // Calculate approximate token count
    tokenCount = calculateSessionTokens(hookInput.transcript_path);
    const tokenDisplay = tokenCount > 1000
      ? `${Math.round(tokenCount / 1000)}k`
      : String(tokenCount);

    if (stats.messageCount > 0) {
      if (compactType === 'manual') {
        message = `Manually compressing ${stats.messageCount} messages (~${tokenDisplay} tokens)`;
      } else {
        message = stats.isLarge
          ? `Auto-compressing large context (~${tokenDisplay} tokens)`
          : `Compressing context (~${tokenDisplay} tokens)`;
      }
    }

    // Save checkpoint to session note before compression
    try {
      const transcriptDir = dirname(hookInput.transcript_path);
      const notesDir = join(transcriptDir, 'Notes');
      const currentNotePath = getCurrentNotePath(notesDir);

      if (currentNotePath) {
        const checkpoint = `Context compression triggered at ~${tokenDisplay} tokens with ${stats.messageCount} messages.`;
        appendCheckpoint(currentNotePath, checkpoint);
        console.error(`Checkpoint saved before compression: ${basename(currentNotePath)}`);
      }
    } catch (noteError) {
      console.error(`Could not save checkpoint: ${noteError}`);
    }
  }

  // Send ntfy.sh notification
  const ntfyMessage = tokenCount > 0
    ? `Auto-pause: ~${Math.round(tokenCount / 1000)}k tokens`
    : 'Context compressing';
  await sendNtfyNotification(ntfyMessage);

  process.exit(0);
}

// Run the hook
main().catch(() => {
  process.exit(0);
});
