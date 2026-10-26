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

import { currentWorkerId } from "../../../workers/worker-id.js";
import { appendFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { dirname, resolve } from 'path';
import { securityEventsPath } from '../lib/pai-paths.js';
import { isSharedCheckout } from '../lib/shared-checkout.js';
import { maskSecrets } from '../lib/loop-guard.js';
import { decideWorkerGitGuard, workerGitGuardMessage } from '../lib/worker-git-guard.js';
import { detectUnsafePlutil, plutilGuardMessage } from '../lib/plutil-guard.js';
import { loadRules, projectRuleDirs, allRuleDirs } from '../lib/rules/load.js';
import { evaluate } from '../../../guard/evaluate.js';
import { readWorkersSection } from '../../../workers/config.js';
import { workersLogDir } from '../../../workers/paths.js';
import { worktreesDir } from '../../../workers/worktree.js';

// ============================================================================
// ATTACK RULES
// ============================================================================
// Patterns live in *.rule.yaml files: built-ins under antipatterns/shell/
// (embedded at build time), user rules under PAI_HOME/rules and .pai/rules.
// Loaded once per hook process; a broken rule file is skipped, never fatal.

let RULES: ReturnType<typeof loadRules>['rules'] = [];

// ============================================================================
// TYPES
// ============================================================================

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown> | string;
  cwd?: string;
}

/**
 * The worker git guard's worktrees root, resolved once per process from the
 * same workers config every other worker code path reads. Null when the
 * config cannot be read (e.g. no workers.yaml yet); the guard then blocks
 * every tree-rewriting git command for a worker, since it cannot prove the
 * worker's cwd is a worktree.
 */
function privateClone(cwd: string): boolean {
  let logDir: string | null = null;
  try {
    logDir = workersLogDir(readWorkersSection().workers);
  } catch {
    // unresolvable: isSharedCheckout fails closed
  }
  return !isSharedCheckout({ cwd, selfId: currentWorkerId(process.env, logDir ?? undefined), logDir });
}

function resolveWorktreesRoot(): string | null {
  try {
    return resolve(worktreesDir(workersLogDir(readWorkersSection().workers)));
  } catch {
    return null;
  }
}

/**
 * Claude Code reads the deny reason from stderr on exit code 2, not from the
 * stdout JSON — a deny that only writes stdout is invisible to the model,
 * which then retries blindly. Nothing else consumes this stdout JSON, so
 * the reason goes to stderr only.
 */
function deny(reason: string): never {
  process.stderr.write(`Blocked by PAI security validator: ${reason}\n`);
  process.exit(2);
}

// ============================================================================
// DETECTION LOGIC
// ============================================================================

interface DetectionResult {
  blocked: boolean;
  requiresConfirmation?: boolean;
  warned?: boolean;
  category?: string;
  pattern?: string;
}

/** Shell-rule verdict for a command, decided by evaluate(); the hook only maps it to its block/confirm/warn outcomes. */
function detectAttack(content: string, ctx: { cwd?: string; sessionId?: string } = {}): DetectionResult {
  const d = evaluate({ kind: 'tool_call', tool: 'Bash', input: { command: content }, cwd: ctx.cwd ?? process.cwd(), sessionId: ctx.sessionId }, { env: process.env, shellRules: RULES });
  if (d.mode !== 'enforce' || !d.rule) return { blocked: false };
  if (d.rule.timedOut) logSecurityEvent({ type: 'project_rule_timeout', note: `${d.patternId}: regex over the time guard, counted as a hit` });
  const hit = { category: d.rule.category, pattern: d.rule.pattern };
  if (d.rule.severity === 'block') return { blocked: true, ...hit };
  if (d.rule.severity === 'confirm') return { blocked: false, requiresConfirmation: true, ...hit };
  return { blocked: false, warned: true, ...hit };
}

// ============================================================================
// ASYNC LOGGING (fire-and-forget on block only)
// ============================================================================

function logSecurityEvent(event: Record<string, unknown>): void {
  const logPath = securityEventsPath();
  if (typeof event.command === 'string') event = { ...event, command: maskSecrets(event.command) };
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n';

  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, entry, { mode: 0o600 });
    chmodSync(logPath, 0o600);
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
    // Read stdin to end of input; the timer only bounds a hung pipe.
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<Buffer[]>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), 2000);
    });
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
      // Without the payload the delete and git guards cannot run: fail closed.
      deny('The hook input could not be read in time, so the command cannot be checked. Retry the command.');
    } finally {
      clearTimeout(timer);
    }

    if (!text.trim()) {
      console.log(JSON.stringify({ permissionDecision: 'allow' }));
      return;
    }

    input = JSON.parse(text);
  } catch {
    // Unparseable payload: the command is unknown, so the guards cannot run.
    deny('The hook input could not be parsed, so the command cannot be checked. Retry the command.');
  }

  // Rules load against the hook input's cwd (the session's project), not the
  // hook process's; a project file that tried to disable a rule is logged.
  const loaded = loadRules(allRuleDirs(input.cwd || process.cwd()), { projectDirs: projectRuleDirs(input.cwd || process.cwd()) });
  RULES = loaded.rules;
  for (const note of loaded.ignored) {
    logSecurityEvent({ type: 'project_rule_ignored', note, session_id: input.session_id });
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

  // plutil in-place rewrite guard: -extract/-replace/-insert/-remove/
  // -convert/-create without -o write the result back into the source file
  // instead of printing it. Applies in every session, not only workers.
  const plutilGuard = detectUnsafePlutil(command);
  if (plutilGuard.blocked) {
    logSecurityEvent({
      type: 'attack_blocked',
      category: 'plutil_guard',
      pattern: plutilGuard.invocation,
      command: command.slice(0, 200),
      session_id: input.session_id,
    });

    deny(plutilGuardMessage(plutilGuard.verb || 'this verb'));
  }

  // In-place worker git guard: a worker with no worktree runs in the shared
  // checkout, where a tree-rewriting git command (stash, reset, clean, ...)
  // can drop or conflict with another worker's in-flight edits.
  const isWorker = process.env.PAI_WORKER === '1';
  if (isWorker) {
    const cwd = input.cwd || process.cwd();
    const guard = decideWorkerGitGuard(command, isWorker, resolve(cwd), resolveWorktreesRoot());
    if (guard.blocked && privateClone(resolve(cwd))) guard.blocked = false;
    if (guard.blocked) {
      logSecurityEvent({
        type: 'attack_blocked',
        category: 'worker_git_guard',
        pattern: guard.cmd,
        command: command.slice(0, 200),
        session_id: input.session_id,
      });

      deny(workerGitGuardMessage(guard.cmd || 'this git command'));
    }
  }

  // Check all patterns
  const result = detectAttack(command, { cwd: input.cwd, sessionId: input.session_id });

  if (result.blocked) {
    // Log and block
    logSecurityEvent({
      type: 'attack_blocked',
      category: result.category,
      pattern: result.pattern,
      command: command.slice(0, 200), // Truncate for log
      session_id: input.session_id,
    });

    deny(`This command matched a security pattern (${result.category}). If this is legitimate, please rephrase the command.`);
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

    deny(`This is a dangerous operation (${command.slice(0, 50)}...). This can cause data loss. If you're sure, explicitly confirm this command.`);
  }

  if (result.warned) {
    // Log the security event but allow the command.
    logSecurityEvent({
      type: 'security_warning',
      category: result.category,
      pattern: result.pattern,
      command: command.slice(0, 200),
      session_id: input.session_id,
    });
  }

  // Allow - no further logging, immediate exit
  console.log(JSON.stringify({ permissionDecision: 'allow' }));
}

// ============================================================================
// RUN
// ============================================================================

main().catch(() => {
  // On any error, fail open
  console.log(JSON.stringify({ permissionDecision: 'allow' }));
});
