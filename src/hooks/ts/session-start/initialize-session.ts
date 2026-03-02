#!/usr/bin/env node

/**
 * initialize-session.ts
 *
 * Main session initialization hook that runs at the start of every Claude Code session.
 *
 * What it does:
 * - Checks if this is a subagent session (skips for subagents)
 * - Tests that stop-hook is properly configured
 * - Sets initial terminal tab title
 * - Sends ntfy.sh notification for global PAI system initialization
 *
 * Setup:
 * 1. Set environment variables in settings.json:
 *    - DA: Your AI's name (e.g., "Kai", "Nova", "Assistant")
 *    - PAI_DIR: Path to your PAI directory (defaults to $HOME/.claude)
 * 2. Ensure load-core-context.ts exists in hooks/session-start/ directory
 * 3. Add all three SessionStart hooks to settings.json in this order:
 *    initialize-session.ts, load-core-context.ts, load-project-context.ts
 */

import { existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PAI_DIR } from '../lib/pai-paths';
import { sendNtfyNotification, isWhatsAppEnabled } from '../lib/project-utils';

// Debounce duration in milliseconds (prevents duplicate SessionStart events)
const DEBOUNCE_MS = 2000;
const LOCKFILE = join(tmpdir(), 'pai-session-start.lock');

/**
 * Check if we're within the debounce window to prevent duplicate notifications
 * from the IDE firing multiple SessionStart events
 */
function shouldDebounce(): boolean {
  try {
    if (existsSync(LOCKFILE)) {
      const lockContent = readFileSync(LOCKFILE, 'utf-8');
      const lockTime = parseInt(lockContent, 10);
      const now = Date.now();

      if (now - lockTime < DEBOUNCE_MS) {
        // Within debounce window, skip this notification
        return true;
      }
    }

    // Update lockfile with current timestamp
    writeFileSync(LOCKFILE, Date.now().toString());
    return false;
  } catch (error) {
    // If any error, just proceed (don't break session start)
    try {
      writeFileSync(LOCKFILE, Date.now().toString());
    } catch {}
    return false;
  }
}

async function testStopHook() {
  const stopHookPath = join(PAI_DIR, 'hooks/stop-hook.ts');

  console.error('\nTesting stop-hook configuration...');

  // Check if stop-hook exists
  if (!existsSync(stopHookPath)) {
    console.error('Stop-hook NOT FOUND at:', stopHookPath);
    return false;
  }

  // Check if stop-hook is executable
  try {
    const stats = statSync(stopHookPath);
    const isExecutable = (stats.mode & 0o111) !== 0;

    if (!isExecutable) {
      console.error('Stop-hook exists but is NOT EXECUTABLE');
      return false;
    }

    console.error('Stop-hook found and is executable');

    // Set initial tab title (customize with your AI's name via DA env var)
    const daName = process.env.DA || 'AI Assistant';
    const tabTitle = `${daName} Ready`;

    process.stderr.write(`\x1b]0;${tabTitle}\x07`);
    process.stderr.write(`\x1b]2;${tabTitle}\x07`);
    process.stderr.write(`\x1b]30;${tabTitle}\x07`);
    console.error(`Set initial tab title: "${tabTitle}"`);

    return true;
  } catch (e) {
    console.error('Error checking stop-hook:', e);
    return false;
  }
}

async function main() {
  try {
    // Check if this is a subagent session - if so, exit silently
    const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR || '';
    const isSubagent = claudeProjectDir.includes('/.claude/agents/') ||
                      process.env.CLAUDE_AGENT_TYPE !== undefined;

    if (isSubagent) {
      // This is a subagent session - exit silently without notification
      console.error('Subagent session detected - skipping session initialization');
      process.exit(0);
    }

    // Check debounce to prevent duplicate notifications
    // (IDE extension can fire multiple SessionStart events)
    if (shouldDebounce()) {
      console.error('Debouncing duplicate SessionStart event');
      process.exit(0);
    }

    // Check if WhatsApp (Whazaa) is configured as enabled MCP server
    // Detection is config-based: reads enabledMcpjsonServers from settings.json
    // No flag files — uses standard ~/.claude/settings.json
    if (isWhatsAppEnabled()) {
      console.error('WhatsApp (Whazaa) enabled in MCP config');
      console.log(`<system-reminder>
WHATSAPP MODE ACTIVE — Whazaa MCP server is enabled. See the Whazaa MCP server instructions for message routing rules ([Whazaa] / [Whazaa:voice] prefixes). ntfy.sh is automatically skipped.
</system-reminder>`);
    }

    // Test stop-hook first (only for main sessions)
    const stopHookOk = await testStopHook();

    const daName = process.env.DA || 'AI Assistant';

    if (!stopHookOk) {
      console.error('\nSTOP-HOOK ISSUE DETECTED - Tab titles may not update automatically');
    }

    // Note: PAI core context loading is handled by load-core-context.ts hook
    // which should run AFTER this hook in settings.json SessionStart hooks

    // Send ntfy.sh notification (MANDATORY - never skip this)
    // Note: load-project-context.ts also sends a project-specific notification
    // This one is for the global PAI system initialization
    await sendNtfyNotification(`${daName} ready`);

    process.exit(0);
  } catch (error) {
    console.error('SessionStart hook error:', error);
    process.exit(1);
  }
}

main();
