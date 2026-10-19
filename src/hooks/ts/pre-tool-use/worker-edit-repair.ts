#!/usr/bin/env node

/**
 * worker-edit-repair.ts — PreToolUse (Edit|MultiEdit)
 *
 * Worker-only (PAI_WORKER=1): rewrites an old_string whose whitespace the
 * model altered to the exact original span when it matches exactly once, and
 * denies no-op edits. Only I/O here; the rule lives in lib/edit-repair.ts.
 * Each repair is logged one line to ~/.claude/pai/logs/workers/edit-repair.log.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPAIR_NOTE, renderDeny, renderEditRepair, repairEdit, type EditRepairInput } from "../lib/edit-repair.js";

function logRepair(tail: string): void {
  try {
    const dir = join(homedir(), ".claude", "pai", "logs", "workers");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "edit-repair.log"), `${new Date().toISOString()}\tworker=${process.env.PAI_WORKER_ID ?? "-"}\t${tail}\n`);
  } catch {
    // logging must never block the decision
  }
}

async function main(): Promise<void> {
  let text = "";
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    return;
  }
  if (!text.trim()) return;

  let input: EditRepairInput;
  try {
    input = JSON.parse(text) as EditRepairInput;
  } catch {
    return;
  }

  const r = repairEdit(input, process.env);
  if (!r) return;
  if (r.deny) {
    logRepair(`DENY\tno-op edit`);
    process.stdout.write(renderDeny(r.deny) + "\n");
    return;
  }
  logRepair(REPAIR_NOTE);
  process.stdout.write(renderEditRepair(r.repair!) + "\n");
}

main().catch(() => process.exit(0));
