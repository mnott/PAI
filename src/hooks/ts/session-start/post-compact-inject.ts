#!/usr/bin/env node

/**
 * post-compact-inject.ts — SessionStart hook (matcher: "compact")
 *
 * Fires AFTER auto/manual compaction. Reads the session state that
 * the PreCompact hook saved to a temp file and outputs it to stdout,
 * which Claude Code injects into the post-compaction context.
 *
 * This is the ONLY way to influence what Claude knows after compaction:
 * PreCompact hooks have no stdout support, but SessionStart does.
 *
 * Flow:
 *   PreCompact → context-compression-hook.ts saves state to /tmp/pai-compact-state-{sessionId}.txt
 *   Compaction runs (conversation is summarized)
 *   SessionStart(compact) → THIS HOOK reads that file → stdout → context
 */

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  source?: string;
}

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

  if (!hookInput?.session_id) {
    console.error('post-compact-inject: no session_id, exiting');
    process.exit(0);
  }

  // Look for the state file saved by context-compression-hook during PreCompact
  const stateFile = join(tmpdir(), `pai-compact-state-${hookInput.session_id}.txt`);

  if (!existsSync(stateFile)) {
    console.error(`post-compact-inject: no state file found at ${stateFile}`);
    process.exit(0);
  }

  try {
    const state = readFileSync(stateFile, 'utf-8').trim();

    if (state.length > 0) {
      // Output to stdout — Claude Code injects this into the post-compaction context
      console.log(state);
      console.error(`post-compact-inject: injected ${state.length} chars of session state`);
    }

    // Clean up the temp file
    unlinkSync(stateFile);
    console.error(`post-compact-inject: cleaned up ${stateFile}`);
  } catch (err) {
    console.error(`post-compact-inject: error reading state file: ${err}`);
  }

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
