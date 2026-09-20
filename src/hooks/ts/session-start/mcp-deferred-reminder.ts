#!/usr/bin/env node

/**
 * mcp-deferred-reminder.ts — SessionStart hook (matchers: resume, compact)
 *
 * Resumed sessions can inherit stale deferred MCP tool handles (a mid-session
 * server re-registration) together with a stale "the MCP server is
 * disconnected" conclusion from before the restart — a combination that makes
 * the session skip the retry the call-time gate would need in order to fire.
 * This hook injects the counter-instruction at session start, before any tool
 * call: see ../lib/mcp-deferred-reminder.ts for the rationale and text.
 *
 * stdout is captured by Claude Code and injected into the session context,
 * same channel as session-commands/inject-observations. Never blocks session
 * start: always exits 0.
 */

import { decideMcpDeferredReminder, type ReminderHookInput } from "../lib/mcp-deferred-reminder.js";
import { isWorkerSession } from "../lib/worker-session.js";

async function main() {
  if (isWorkerSession()) return; // disposable worker: no per-session bookkeeping
  let input: ReminderHookInput = {};

  try {
    const decoder = new TextDecoder();
    let raw = '';
    const timeoutPromise = new Promise<void>((resolve) => { setTimeout(resolve, 500); });
    const readPromise = (async () => {
      for await (const chunk of process.stdin) {
        raw += decoder.decode(chunk, { stream: true });
      }
    })();
    await Promise.race([readPromise, timeoutPromise]);
    if (raw.trim()) {
      input = JSON.parse(raw) as ReminderHookInput;
    }
  } catch {
    // Junk input: stay silent, exit 0
    process.exit(0);
  }

  const reminder = decideMcpDeferredReminder(input);
  if (reminder) {
    console.log(reminder);
    console.error(`mcp-deferred-reminder: injected reminder for source=${input.source}`);
  }

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
