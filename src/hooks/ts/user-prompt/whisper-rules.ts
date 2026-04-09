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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WHISPER_FILE = join(homedir(), ".claude", "whisper-rules.md");
const ADVISOR_FILE = join(homedir(), ".claude", "advisor-mode.json");

function getWhisperRules(): string {
  if (existsSync(WHISPER_FILE)) {
    try {
      const content = readFileSync(WHISPER_FILE, "utf-8").trim();
      if (content) return content;
    } catch { /* ignore */ }
  }
  return "";
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

  // Determine mode
  let mode = config.mode ?? "auto";
  if (mode === "auto" && typeof config.weeklyBudgetPercent === "number") {
    const pct = config.weeklyBudgetPercent;
    if (pct < 70) mode = "normal";
    else if (pct < 85) mode = "conservative";
    else if (pct < 95) mode = "strict";
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
        "Use HAIKU for all subagents (Agent tool, model: haiku) unless the task explicitly requires deep reasoning.",
        "Main context stays on the current model. Only escalate subagents to sonnet if haiku output quality is insufficient.",
        "Prefer fewer, more focused subagent calls over many parallel ones.",
      ].join(" ");

    case "strict":
      return [
        `ADVISOR MODE (strict — weekly budget at ${config.weeklyBudgetPercent ?? "?"}%):`,
        "Use HAIKU for ALL subagents without exception (Agent tool, model: haiku).",
        "Minimize subagent spawning — do simple tasks directly in main context.",
        "Only spawn subagents for genuinely independent parallel work.",
        "Never spawn opus subagents.",
      ].join(" ");

    case "critical":
      return [
        `ADVISOR MODE (critical — weekly budget at ${config.weeklyBudgetPercent ?? "?"}%):`,
        "MINIMIZE ALL TOKEN USAGE. Do NOT spawn subagents unless absolutely essential.",
        "Work directly in main context. Keep responses concise.",
        "Use haiku model if you must spawn a subagent.",
        "Skip background research, parallel exploration, and spotchecks.",
        "The user is near their weekly limit — every token counts.",
      ].join(" ");

    default:
      return "";
  }
}

function main() {
  const parts: string[] = [];

  const rules = getWhisperRules();
  if (rules) parts.push(rules);

  const advisor = getAdvisorGuidance();
  if (advisor) parts.push(advisor);

  if (parts.length === 0) return;

  console.log(`<system-reminder>\n${parts.join("\n")}\n</system-reminder>`);
}

main();
