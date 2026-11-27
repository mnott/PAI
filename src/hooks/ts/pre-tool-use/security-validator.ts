#!/usr/bin/env node

/**
 * security-validator.ts - PreToolUse Security Validation Hook
 *
 * Fast pattern-based security validation for Bash commands.
 * Blocks commands matching known attack patterns before execution.
 *
 * Design Principles:
 * - Fast path: Most commands allowed with minimal processing
 * - Pre-compiled regex patterns at module load
 * - Only log/block on high-confidence attack detection
 * - Fail open on errors (don't break legitimate work)
 *
 * CUSTOMIZATION REQUIRED:
 * This template includes basic examples. Add your own security patterns
 * based on your threat model and environment.
 */

import { readStdinToEnd } from '../lib/read-stdin.js';
import { decide, denyDecision, type HookInput } from './security-decision.js';

// ============================================================================
// MAIN HOOK LOGIC
// ============================================================================

async function main(): Promise<void> {
  let input: HookInput;

  try {
    // Wait for EOF; the load-scaled bound only catches a hung pipe.
    let text = '';
    try {
      text = await readStdinToEnd();
    } catch {
      // Without the payload the delete and git guards cannot run: fail closed.
      emit(denyDecision('The hook input could not be read in time, so the command cannot be checked. Retry the command.'));
      return;
    }

    if (!text.trim()) {
      console.log(JSON.stringify({ permissionDecision: 'allow' }));
      return;
    }

    input = JSON.parse(text);
  } catch {
    // Unparseable payload: the command is unknown, so the guards cannot run.
    emit(denyDecision('The hook input could not be parsed, so the command cannot be checked. Retry the command.'));
    return;
  }

  emit(decide(input));
}

function emit(d: { status: number; stdout: string; stderr: string }): void {
  if (d.stderr) process.stderr.write(d.stderr);
  if (d.stdout) process.stdout.write(d.stdout);
  if (d.status !== 0) process.exit(d.status);
}

main().catch(() => {
  // On any error, fail open
  console.log(JSON.stringify({ permissionDecision: 'allow' }));
});
