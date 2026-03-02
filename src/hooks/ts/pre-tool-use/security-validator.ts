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

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// ATTACK PATTERNS - CUSTOMIZE THESE FOR YOUR ENVIRONMENT
// ============================================================================

// Example: Reverse Shell Patterns (BLOCK - rarely legitimate)
const REVERSE_SHELL_PATTERNS: RegExp[] = [
  /\/dev\/(tcp|udp)\/[0-9]/,                    // Bash TCP/UDP device
  /bash\s+-i\s+>&?\s*\/dev\//,                  // Interactive bash redirect
  // Add your own reverse shell patterns here
];

// Example: Instruction Override (BLOCK - prompt injection)
const INSTRUCTION_OVERRIDE_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /disregard\s+(all\s+)?(prior|previous)\s+(instructions?|rules?)/i,
  // Add your own prompt injection patterns here
];

// Example: Catastrophic Deletion Patterns (BLOCK - filesystem destruction)
const CATASTROPHIC_DELETION_PATTERNS: RegExp[] = [
  // Trailing tilde bypass
  /\s+~\/?(\s*$|\s+)/,                              // Space then ~/ at end
  /\brm\s+(-[rfivd]+\s+)*\S+\s+~\/?/,               // rm something ~/

  // Relative path recursive deletion
  /\brm\s+(-[rfivd]+\s+)*\.\/\s*$/,                 // rm -rf ./
  /\brm\s+(-[rfivd]+\s+)*\.\.\/\s*$/,               // rm -rf ../

  // Add your own dangerous deletion patterns here
];

// Example: Dangerous File Operations (BLOCK - data destruction)
const DANGEROUS_FILE_OPS_PATTERNS: RegExp[] = [
  /\bchmod\s+(-R\s+)?0{3,}/,                        // chmod 000
  // Add your own dangerous file operation patterns here
];

// OPTIONAL: Operations that require confirmation instead of blocking
const DANGEROUS_GIT_PATTERNS: RegExp[] = [
  /\bgit\s+push\s+.*(-f\b|--force)/i,               // git push --force
  /\bgit\s+reset\s+--hard/i,                        // git reset --hard
  // Add your own git safety patterns here
];

// Combined patterns for fast iteration
const ALL_BLOCK_PATTERNS: { category: string; patterns: RegExp[] }[] = [
  { category: 'reverse_shell', patterns: REVERSE_SHELL_PATTERNS },
  { category: 'instruction_override', patterns: INSTRUCTION_OVERRIDE_PATTERNS },
  { category: 'catastrophic_deletion', patterns: CATASTROPHIC_DELETION_PATTERNS },
  { category: 'dangerous_file_ops', patterns: DANGEROUS_FILE_OPS_PATTERNS },
];

const CONFIRM_PATTERNS: { category: string; patterns: RegExp[] }[] = [
  { category: 'dangerous_git', patterns: DANGEROUS_GIT_PATTERNS },
];

// ============================================================================
// TYPES
// ============================================================================

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown> | string;
}

interface HookOutput {
  permissionDecision: 'allow' | 'deny';
  additionalContext?: string;
  feedback?: string;
}

// ============================================================================
// DETECTION LOGIC
// ============================================================================

interface DetectionResult {
  blocked: boolean;
  requiresConfirmation?: boolean;
  category?: string;
  pattern?: string;
}

function detectAttack(content: string): DetectionResult {
  // First check for hard blocks
  for (const { category, patterns } of ALL_BLOCK_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return { blocked: true, category, pattern: pattern.source };
      }
    }
  }

  // Then check for confirmation-required patterns
  for (const { category, patterns } of CONFIRM_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return { blocked: false, requiresConfirmation: true, category, pattern: pattern.source };
      }
    }
  }

  return { blocked: false };
}

// ============================================================================
// ASYNC LOGGING (fire-and-forget on block only)
// ============================================================================

function logSecurityEvent(event: Record<string, unknown>): void {
  const logPath = `${process.env.PAI_DIR || '~/.claude'}/history/security/security-events.jsonl`;
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n';

  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, entry);
  } catch {
    // Silently fail - logging should never break the hook
  }
}

// ============================================================================
// MAIN HOOK LOGIC
// ============================================================================

async function main(): Promise<void> {
  let input: HookInput;

  try {
    // Read stdin
    const chunks: Buffer[] = [];
    const timeoutPromise = new Promise<Buffer[]>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 100)
    );
    const readPromise = (async () => {
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    let text = '';
    try {
      const result = await Promise.race([readPromise, timeoutPromise]);
      text = Buffer.concat(result).toString('utf-8');
    } catch {
      console.log(JSON.stringify({ permissionDecision: 'allow' }));
      return;
    }

    if (!text.trim()) {
      console.log(JSON.stringify({ permissionDecision: 'allow' }));
      return;
    }

    input = JSON.parse(text);
  } catch {
    // Parse error or timeout - fail open
    console.log(JSON.stringify({ permissionDecision: 'allow' }));
    return;
  }

  // Only validate Bash commands
  if (input.tool_name !== 'Bash') {
    console.log(JSON.stringify({ permissionDecision: 'allow' }));
    return;
  }

  // Extract command string
  const command = typeof input.tool_input === 'string'
    ? input.tool_input
    : (input.tool_input?.command as string) || '';

  if (!command) {
    console.log(JSON.stringify({ permissionDecision: 'allow' }));
    return;
  }

  // Check all patterns
  const result = detectAttack(command);

  if (result.blocked) {
    // Log and block
    logSecurityEvent({
      type: 'attack_blocked',
      category: result.category,
      pattern: result.pattern,
      command: command.slice(0, 200), // Truncate for log
      session_id: input.session_id,
    });

    const output: HookOutput = {
      permissionDecision: 'deny',
      additionalContext: `SECURITY: Blocked ${result.category} pattern`,
      feedback: `This command matched a security pattern (${result.category}). If this is legitimate, please rephrase the command.`,
    };

    console.log(JSON.stringify(output));
    process.exit(2); // Exit 2 = blocking error
  }

  if (result.requiresConfirmation) {
    // Log warning and require confirmation
    logSecurityEvent({
      type: 'confirmation_required',
      category: result.category,
      pattern: result.pattern,
      command: command.slice(0, 200),
      session_id: input.session_id,
    });

    const output: HookOutput = {
      permissionDecision: 'deny',
      additionalContext: `DANGEROUS: ${result.category} operation requires confirmation`,
      feedback: `This is a dangerous operation (${command.slice(0, 50)}...). This can cause data loss. If you're sure, explicitly confirm this command.`,
    };

    console.log(JSON.stringify(output));
    process.exit(2); // Exit 2 = requires user confirmation
  }

  // Allow - no logging, immediate exit
  console.log(JSON.stringify({ permissionDecision: 'allow' }));
}

// ============================================================================
// RUN
// ============================================================================

main().catch(() => {
  // On any error, fail open
  console.log(JSON.stringify({ permissionDecision: 'allow' }));
});
