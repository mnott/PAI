#!/usr/bin/env node

/**
 * whisper-reinject — put the output-shape rules back in view mid-turn.
 *
 * The whisper rules are injected once per user message, by the UserPromptSubmit
 * hook. That is the wrong place for the rules that govern how a turn is
 * *written*, because a long turn does not write its answer next to that
 * injection: it runs twenty tool calls first. Attention follows the tool
 * output, the injected block scrolls out of working memory, and by the time the
 * answer is composed the rules are gone. Nothing in the loop re-checks them, so
 * compliance decays with turn length — exactly the turns where it matters most.
 *
 * This fires after a tool call instead, so the reminder lands where the decay
 * happens. It stays quiet for short sequences (nothing has decayed yet) and
 * emits a compressed set — not all of them — every few calls after that. The
 * full rule set is deliberately not repeated: a wall of text re-read every few
 * calls is skimmed, and it costs context that the actual work needs.
 *
 * Only rules about the shape of the reply belong here. Rules about actions
 * (what may be sent, published, or committed) are enforced at the point of
 * action, not by reminding.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/** Stay silent below this many tool calls — a short turn has not drifted yet. */
const QUIET_BELOW = 6;

/** Re-emit every N calls once past QUIET_BELOW. */
const EVERY = 8;

function counterFile(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "") || "nosession";
  return join(tmpdir(), "pai-whisper-reinject", `${safe}.count`);
}

function bump(path: string): number {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const n = existsSync(path) ? Number.parseInt(readFileSync(path, "utf-8").trim(), 10) || 0 : 0;
    const next = n + 1;
    writeFileSync(path, String(next));
    return next;
  } catch {
    return 0;
  }
}

function localTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function main(): void {
  let sessionId = "";
  try {
    const raw = readStdin();
    if (raw.trim()) sessionId = (JSON.parse(raw) as { session_id?: string }).session_id ?? "";
  } catch { /* no session id — fall back to a shared counter */ }

  const n = bump(counterFile(sessionId));
  if (n < QUIET_BELOW || n % EVERY !== 0) return;

  const lines = [
    `CURRENT LOCAL TIME: ${localTime()} — use verbatim for any [YYYY-MM-DD HH:MM] stamp. Never estimate it, never increment a previous one.`,
    `You are ${n} tool calls into this turn. Before the next one, check:`,
    "- One command at a time: say what you are about to run, run it, say what came back. Do not batch several steps into one call.",
    "- Report what CHANGED, not what you learned. A finding is not a deliverable.",
    "- Prove it: show the reading that says it failed before and works now.",
    "- Found a fault while working? Fix it. Filing it is not fixing it.",
    "- Corrections stay to one line. No re-litigating your own mistakes.",
  ];

  console.log(`<system-reminder>\n${lines.join("\n")}\n</system-reminder>`);
}

main();
