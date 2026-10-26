#!/usr/bin/env node

/**
 * inbox-inject.ts — PostToolUse hook (all tools).
 *
 * Runs after every tool call, so operator text in the session's inbox
 * (Notes/ANSWERS.md, ~/.pai/inbox.md — see lib/inbox.ts) reaches a busy
 * session mid-turn, not only at the next prompt.
 *
 * Two duties, in this order:
 * 1. If this call was the session's own Write/Edit of an inbox file, record
 *    the file's content as seen (markOwnWrite) — the session's own writes are
 *    never injected back to it.
 * 2. Otherwise check the inbox and inject only new operator text.
 *
 * One stat per inbox file per call; read only on mtime change. Any error
 * injects nothing — this hook must never fail the tool call.
 */

import { checkInbox, inboxContext, inboxHookOutput, isInboxPath, markOwnWrite } from "../lib/inbox.js";
import { readHookInput } from "../lib/read-stdin.js";

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
}

async function main(): Promise<void> {
  const input = await readHookInput<HookInput>();
  const sessionId = input?.session_id ?? "";
  const cwd = input?.cwd || process.cwd();

  const tool = input?.tool_name;
  if ((tool === "Write" || tool === "Edit" || tool === "MultiEdit") && input?.tool_input?.file_path) {
    if (isInboxPath(cwd, input.tool_input.file_path)) {
      markOwnWrite(sessionId, input.tool_input.file_path);
      return;
    }
  }

  const out = inboxHookOutput("PostToolUse", inboxContext(checkInbox(sessionId, cwd)));
  if (out) process.stdout.write(out);
}

main().catch(() => {
  // an inbox that cannot be read must never fail the tool call
});
