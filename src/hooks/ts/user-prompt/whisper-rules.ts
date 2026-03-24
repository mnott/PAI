#!/usr/bin/env node

/**
 * whisper-rules.ts
 *
 * UserPromptSubmit hook that injects critical non-negotiable rules into every
 * prompt as a <system-reminder>. This ensures rules survive compaction — even
 * if CLAUDE.md content is lost during context compression, the whisper
 * re-injects the absolute rules on every single turn.
 *
 * Inspired by Letta's "claude-subconscious" whisper pattern.
 *
 * Rules are loaded from ~/.claude/whisper-rules.md if it exists,
 * otherwise falls back to hardcoded critical rules.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WHISPER_FILE = join(homedir(), ".claude", "whisper-rules.md");

function getWhisperRules(): string {
  // User-customizable whisper file takes priority
  if (existsSync(WHISPER_FILE)) {
    try {
      const content = readFileSync(WHISPER_FILE, "utf-8").trim();
      if (content) return content;
    } catch { /* fall through to defaults */ }
  }

  // Hardcoded critical rules — the ones that keep getting violated
  return [
    "NEVER suggest pausing, stopping, or ending the session. The user decides when to stop. Not you. Ever.",
    "NEVER send emails. Always create drafts. No exceptions.",
    "NEVER add Co-Authored-By or AI attribution to git commits.",
  ].join("\n");
}

function main() {
  const rules = getWhisperRules();
  if (!rules) return;

  // Output as system-reminder — Claude Code injects this into the conversation
  console.log(`<system-reminder>
${rules}
</system-reminder>`);
}

main();
