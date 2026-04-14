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
