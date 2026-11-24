#!/usr/bin/env node

/**
 * worker-result-hint.ts — PostToolUse Bash
 *
 * Worker-only (PAI_WORKER=1) and local-provider-only: after a Bash call, tells
 * the model what the result means so it does not re-issue the identical call.
 * Empty output → "the command succeeded"; a grep whose output contains none
 * of the searched names → "the name is probably different". A no-op in
 * interactive sessions and on cloud workers.
 */

import { readFileSync } from "node:fs";
import { isWorkerSession } from "../lib/worker-session.js";
import { bashResultHint, isLocalWorkerProvider } from "../lib/worker-result-hint.js";

function readStdin(): string {
  try {
    return process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(): void {
  if (!isWorkerSession() || !isLocalWorkerProvider()) return;
  const raw = readStdin();
  if (!raw) return;
  let j: { tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown };
  try {
    j = JSON.parse(raw);
  } catch {
    return;
  }
  if (j.tool_name !== "Bash") return;
  const command = typeof j.tool_input?.command === "string" ? j.tool_input.command : "";
  if (!command) return;
  const output = typeof j.tool_response === "string" ? j.tool_response : JSON.stringify(j.tool_response ?? "");
  const hint = bashResultHint(command, output);
  if (!hint) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: hint } }) + "\n");
}

main();
