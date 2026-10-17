#!/usr/bin/env node

/**
 * worker-tool-name-repair.ts — PreToolUse (*)
 *
 * Worker-only (PAI_WORKER=1): rewrites a dotted tool name whose last segment
 * names a known tool (`Glob.glob` → `Glob`, `Bash.Bash` → `Bash`); anything
 * else passes untouched. Only I/O here; the rule lives in
 * lib/tool-name-repair.ts. Each repair is logged one line to
 * ~/.claude/pai/logs/workers/tool-repair.log. A no-op in interactive sessions.
 * Denies the "R" tool call in workers.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderRepair, repairToolName, type ToolNameRepairInput, reportToolDenial, renderToolDenial } from "../lib/tool-name-repair.js";

async function main(): Promise<void> {
  let text = "";
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    return;
  }
  if (!text.trim()) return;

  let input: ToolNameRepairInput;
  try {
    input = JSON.parse(text) as ToolNameRepairInput;
  } catch {
    return;
  }

  const denial = reportToolDenial(input, process.env);
  if (denial) {
    process.stdout.write(renderToolDenial(denial) + "\n");
    return;
  }

  const repair = repairToolName(input, process.env);
  if (!repair) return;
  try {
    const dir = join(homedir(), ".claude", "pai", "logs", "workers");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "tool-repair.log"),
      `${new Date().toISOString()}\tworker=${process.env.PAI_WORKER_ID ?? "-"}\t${repair.old}\t${repair.new}\n`,
    );
  } catch {
    // logging must never block the decision
  }
  process.stdout.write(renderRepair(repair) + "\n");
}

main().catch(() => process.exit(0));
