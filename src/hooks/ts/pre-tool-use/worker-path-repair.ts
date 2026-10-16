#!/usr/bin/env node

/**
 * worker-path-repair.ts — PreToolUse (Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep)
 *
 * Worker-only (PAI_WORKER=1): rewrites a mistyped absolute path whose leading
 * components are a near-miss of the cwd; in isolated A/B arms also the
 * absolute-path tokens of Bash commands. Only I/O here; the rule lives in
 * lib/path-repair.ts. Each repair is logged one line to
 * ~/.claude/pai/logs/workers/path-repair.log. A no-op in interactive sessions.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { armGuardReason, denyReason, renderDeny, repairPath, renderRepair, type PathRepairInput } from "../lib/path-repair.js";

async function main(): Promise<void> {
  let text = "";
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    return;
  }
  if (!text.trim()) return;

  let input: PathRepairInput;
  try {
    input = JSON.parse(text) as PathRepairInput;
  } catch {
    return;
  }

  const guard = armGuardReason(input, process.env);
  const repair = guard ? null : repairPath(input, process.env, existsSync);
  const reason = guard ?? (repair ? null : denyReason(input, process.env));
  if (!repair && !reason) return;
  try {
    const dir = join(homedir(), ".claude", "pai", "logs", "workers");
    mkdirSync(dir, { recursive: true });
    const what = repair
      ? `${repair.old}\t${repair.new}`
      : `DENY\t${input.tool_name}\t${JSON.stringify(input.tool_input)}`;
    appendFileSync(join(dir, "path-repair.log"), `${new Date().toISOString()}\tcwd=${input.cwd}\t${what}\n`);
  } catch {
    // logging must never block the decision
  }
  process.stdout.write((repair ? renderRepair(repair, input.tool_name) : renderDeny(reason!)) + "\n");
}

main().catch(() => process.exit(0));
