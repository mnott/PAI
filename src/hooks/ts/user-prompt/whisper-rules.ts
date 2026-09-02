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
 * Budget percentage is written by the statusline or manually to advisor-mode.json.
 * If the file doesn't exist, no advisor guidance is injected.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const WHISPER_FILE = join(homedir(), ".claude", "whisper-rules.md");
const ADVISOR_FILE = join(homedir(), ".claude", "advisor-mode.json");

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
 */
function getWhisperRules(): string {
  if (!existsSync(WHISPER_FILE)) return "";
  try {
    return readFileSync(WHISPER_FILE, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((l) => (l.startsWith("\\#") ? l.slice(1) : l))
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

interface AdvisorConfig {
  weeklyBudgetPercent?: number;  // 0-100, written by statusline or manually
  mode?: "normal" | "conservative" | "strict" | "critical" | "auto";
  forceModel?: string;  // override: always use this model for subagents
}

function getAdvisorGuidance(): string {
  if (!existsSync(ADVISOR_FILE)) return "";

  let config: AdvisorConfig;
  try {
    config = JSON.parse(readFileSync(ADVISOR_FILE, "utf-8"));
  } catch {
    return "";
  }

  // Determine mode.
  //
  // `??` only substitutes on null/undefined, so a config written as
  // {"mode": ""} — which is what the statusline produces when it has no manual
  // override — left mode as the empty string. That matched no case below, so
  // the advisor silently returned nothing regardless of budget. A budget guard
  // that quietly does nothing is worse than none, because you believe you have
  // one. Treat anything that is not a recognised mode as "auto".
  const VALID = ["normal", "conservative", "strict", "critical", "auto"] as const;
  let mode: string =
    config.mode && (VALID as readonly string[]).includes(config.mode) ? config.mode : "auto";
  if (mode === "auto" && typeof config.weeklyBudgetPercent === "number") {
    const pct = config.weeklyBudgetPercent;
    if (pct < 60) mode = "normal";
    else if (pct < 80) mode = "conservative";
    else if (pct < 92) mode = "strict";
    else mode = "critical";
  }

  // Force model override
  if (config.forceModel) {
    return `ADVISOR MODE: Use model "${config.forceModel}" for ALL subagents (Agent tool calls). This is a manual override.`;
  }

  switch (mode) {
    case "normal":
      return "";  // No constraints — use models freely

    case "conservative":
      return [
        `ADVISOR MODE (conservative — weekly budget at ${config.weeklyBudgetPercent ?? "?"}%):`,
        "Main context is opus (most expensive — 20x haiku, 5x sonnet). Delegate aggressively to subagents.",
        "Default subagents to SONNET (Agent tool, model: sonnet). Use haiku for simple lookups/verification.",
        "For substantial tasks, use swarm mode: spawn a sonnet orchestrator that delegates to haiku workers.",
        "Keep main context responses short — the goal is to minimize opus token burn.",
      ].join(" ");

    case "strict":
      return [
        `ADVISOR MODE (strict — weekly budget at ${config.weeklyBudgetPercent ?? "?"}%):`,
        "Main context is opus (most expensive — 20x haiku, 5x sonnet). Minimize work done here.",
        "Default subagents to SONNET (Agent tool, model: sonnet) for implementation and research. Use haiku for simple tasks.",
        "For any substantial task, use swarm mode: spawn ONE sonnet orchestrator that delegates to haiku workers.",
        "Keep main context responses short — receive results from agents, summarize briefly, done.",
        "Never spawn opus subagents. Every line of opus output costs 5x what sonnet costs.",
      ].join(" ");

    case "critical":
      return [
        `ADVISOR MODE (critical — weekly budget at ${config.weeklyBudgetPercent ?? "?"}%):`,
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

  const parts: string[] = [];

  parts.push(`CURRENT LOCAL TIME: ${currentLocalTime()} — use this verbatim for any [YYYY-MM-DD HH:MM] stamp; never estimate or increment it.`);

  const rules = getWhisperRules();
  if (rules) parts.push(rules);

  const advisor = getAdvisorGuidance();
  if (advisor) parts.push(advisor);

  if (parts.length === 0) return;

  console.log(`<system-reminder>\n${parts.join("\n")}\n</system-reminder>`);
}

main();
