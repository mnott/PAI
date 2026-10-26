#!/usr/bin/env node

/**
 * inbox-inject.ts — UserPromptSubmit hook.
 *
 * Injects operator text the session has not seen yet from its inbox: the
 * project's answers file (Notes/ANSWERS.md when it exists) plus the global
 * ~/.pai/inbox.md. See lib/inbox.ts for the diff rules and the never-echo-
 * own-writes rule; the PostToolUse twin fires after every tool call so a busy
 * session reaches the message mid-turn too.
 *
 * One stat per inbox file per call; the file is read only when its mtime
 * moved. Any error injects nothing — this hook must never fail the prompt.
 */

import { checkInbox, inboxContext, inboxHookOutput } from "../lib/inbox.js";
import { readHookInput } from "../lib/read-stdin.js";

interface HookInput {
  session_id?: string;
  cwd?: string;
}

async function main(): Promise<void> {
  const input = await readHookInput<HookInput>();
  const sessionId = input?.session_id ?? "";
  const cwd = input?.cwd || process.cwd();
  const out = inboxHookOutput("UserPromptSubmit", inboxContext(checkInbox(sessionId, cwd)));
  if (out) process.stdout.write(out);
}

main().catch(() => {
  // an inbox that cannot be read must never fail the prompt
});
