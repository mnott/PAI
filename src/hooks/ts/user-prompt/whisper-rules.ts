#!/usr/bin/env node

/**
 * whisper-rules.ts
 *
 * UserPromptSubmit hook that injects:
 * 1. User-defined whisper rules from ~/.claude/whisper-rules.md
 * 2. Budget-aware model tiering guidance from ~/.claude/advisor-mode.json
 *
 * The advisor mode implements the "advisor strategy" pattern:
 * - Normal (budget < 70%): use any model freely
 * - Conservative (70-85%): prefer haiku for subagents, sonnet for main work
 * - Strict (85-95%): haiku only for subagents, main context stays on current model
 * - Critical (>95%): minimize all subagent spawning, essential work only
 *
 * Budget percentage is written by the statusline or manually to advisor-mode.json,
 * stamped with the epoch second it was read. If the file doesn't exist, or its
 * reading is too old to still describe the current window, no advisor guidance
 * is injected — see lib/advisor-budget.ts for why that direction is the safe one.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { resolveAdvisorMode, type AdvisorConfig } from "../lib/advisor-budget.js";

const WHISPER_FILE = join(homedir(), ".claude", "whisper-rules.md");
const ADVISOR_FILE = join(homedir(), ".claude", "advisor-mode.json");

/** A "# N. TITLE" section header: the start of a new section, tag reset. */
function isSectionHeader(line: string): boolean {
  return /^#\s*\d+\.\s/.test(line);
}

/**
 * Read the rule file, dropping everything that is there for the author rather
 * than for the reader: "#" comment lines and blank lines.
 *
 * The rules are injected on every single prompt, so each line is paid for on
 * every turn — which is the standing argument against letting the file grow
 * headings and explanations. Stripping them here settles that: the file may be
 * organised into sections with as much commentary as it takes to keep it
 * maintainable, and none of it reaches the prompt. Only the rules do.
 *
 * A line whose rule text legitimately starts with "#" can be escaped as "\\#".
 *
 * Section tags: this file is injected into every claude process, spawned
 * workers included, and some rules (e.g. "delegate to workers") are true only
 * for the interactive orchestrating session. A comment line "# @orchestrator"
 * marks every following rule as orchestrator-only, "# @worker" marks
 * worker-only, until the next "# N. TITLE" section header resets the tag (a
 * section's own header/divider box, which the tag line sits inside, does not
 * count as the next section). An untagged section reaches both. `isWorker`
 * selects which side of the tag this process is on — see PAI_WORKER in
 * run-env.ts.
 */
function getWhisperRules(isWorker: boolean): string {
  if (!existsSync(WHISPER_FILE)) return "";
  try {
    const lines = readFileSync(WHISPER_FILE, "utf-8").split("\n");
    const out: string[] = [];
    let tag: "orchestrator" | "worker" | null = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (line.startsWith("#")) {
        if (isSectionHeader(line)) tag = null;
        else if (line === "# @orchestrator") tag = "orchestrator";
        else if (line === "# @worker") tag = "worker";
        continue;
      }
      if (tag === "orchestrator" && isWorker) continue;
      if (tag === "worker" && !isWorker) continue;
      out.push(line.startsWith("\\#") ? line.slice(1) : line);
    }
    return out.join("\n").trim();
  } catch {
    return "";
  }
}

function getAdvisorGuidance(): string {
  if (!existsSync(ADVISOR_FILE)) return "";

  let config: AdvisorConfig;
  try {
    config = JSON.parse(readFileSync(ADVISOR_FILE, "utf-8"));
  } catch {
    return "";
  }

  // Determine mode: the manual one if set, else derived from a budget reading
  // that is current. No current reading and no manual mode means say nothing —
  // guessing is how a wrong number gets obeyed for a day and a half. See
  // lib/advisor-budget.ts.
  const { mode, percent: pct } = resolveAdvisorMode(config, Math.floor(Date.now() / 1000));
  if (mode === undefined) return "";

  // Force model override
  if (config.forceModel) {
    return `ADVISOR MODE: Use model "${config.forceModel}" for ALL subagents (Agent tool calls). This is a manual override.`;
  }

  switch (mode) {
    case "normal":
      return "";  // No constraints — use models freely

    case "conservative":
      return [
        `ADVISOR MODE (conservative — weekly budget at ${pct ?? "?"}%):`,
        "Main context is opus (most expensive — 20x haiku, 5x sonnet). Delegate aggressively to subagents.",
        "Default subagents to SONNET (Agent tool, model: sonnet). Use haiku for simple lookups/verification.",
        "For substantial tasks, use swarm mode: spawn a sonnet orchestrator that delegates to haiku workers.",
        "Keep main context responses short — the goal is to minimize opus token burn.",
      ].join(" ");

    case "strict":
      return [
        `ADVISOR MODE (strict — weekly budget at ${pct ?? "?"}%):`,
        "Main context is opus (most expensive — 20x haiku, 5x sonnet). Minimize work done here.",
        "Default subagents to SONNET (Agent tool, model: sonnet) for implementation and research. Use haiku for simple tasks.",
        "For any substantial task, use swarm mode: spawn ONE sonnet orchestrator that delegates to haiku workers.",
        "Keep main context responses short — receive results from agents, summarize briefly, done.",
        "Never spawn opus subagents. Every line of opus output costs 5x what sonnet costs.",
      ].join(" ");

    case "critical":
      return [
        `ADVISOR MODE (critical — weekly budget at ${pct ?? "?"}%):`,
        "MINIMIZE ALL TOKEN USAGE. Main context is opus — the most expensive model (20x haiku, 5x sonnet).",
        "For ANY non-trivial task, immediately spawn a sonnet orchestrator agent and let it handle everything.",
        "Main context should only send the task and receive the final result — do not do work here.",
        "Keep main context responses extremely concise — short answers, minimal explanation.",
        "Use sonnet for orchestration, haiku for workers. Never spawn opus subagents. Skip spotchecks.",
        "The user is near their weekly limit — do as little as possible in opus main context.",
      ].join(" ");

    default:
      return "";
  }
}

/**
 * Local wall-clock time, as data rather than as an instruction to go and look.
 *
 * A rule that says "use the local timestamp" is only ever as reliable as the
 * model's willingness to stop and fetch one; the cheap substitute is a guess,
 * and a guessed clock is worse than none — it reads as a measurement. Putting
 * the real value in front of the model removes the choice.
 */
function currentLocalTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Reset the mid-turn tool-call counter that whisper-reinject increments.
 *
 * This hook fires exactly once per user message, which is the only place that
 * knows where one turn ends and the next begins. Without the reset the counter
 * is a session total, and "you are N tool calls into this turn" stops being
 * true after the first turn — a reminder that misstates its own trigger is one
 * the reader learns to discount.
 */
function resetReinjectCounter(): void {
  try {
    const raw = readFileSync(0, "utf-8");
    const sessionId = raw.trim() ? (JSON.parse(raw) as { session_id?: string }).session_id ?? "" : "";
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "") || "nosession";
    const f = join(tmpdir(), "pai-whisper-reinject", `${safe}.count`);
    if (existsSync(f)) unlinkSync(f);
  } catch { /* best effort — a stale count is not worth failing the hook over */ }
}

function main() {
  resetReinjectCounter();

  const isWorker = process.env.PAI_WORKER === "1";
  const parts: string[] = [];

  parts.push(`CURRENT LOCAL TIME: ${currentLocalTime()} — use this verbatim for any [YYYY-MM-DD HH:MM] stamp; never estimate or increment it.`);

  const rules = getWhisperRules(isWorker);
  if (rules) parts.push(rules);

  const advisor = getAdvisorGuidance();
  if (advisor) parts.push(advisor);

  if (parts.length === 0) return;

  console.log(`<system-reminder>\n${parts.join("\n")}\n</system-reminder>`);
}

main();
