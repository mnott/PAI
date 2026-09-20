#!/usr/bin/env node

/**
 * route-edits-to-worker.ts — PreToolUse (Edit|MultiEdit|Write)
 *
 * The outer orchestrator session does not edit code files; code changes go
 * through `pai worker run`. Allowed through silently:
 *   - worker sessions (the runner sets PAI_WORKER=1)
 *   - paths outside any git work tree
 *   - the exempt scratch prefixes (.claude incl. memory dirs, the local
 *     notes/tasks/scratchpad dirs, the OS temp dir)
 *   - prose: notes, session logs, handovers — see lib/edit-gate.ts isProseEdit
 * Everything else inside a git work tree is blocked with the worker command.
 *
 * This file is only I/O: read stdin, resolve the path, ask lib/edit-gate for
 * the decision, print it. The decision itself lives in lib/edit-gate.ts and
 * is tested there.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { decideEditGate, type EditGateContext } from "../lib/edit-gate.js";

function isUnder(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(prefix + sep);
}

// A .git entry in any ancestor marks a git work tree (.git is a directory in
// a normal repo, a file in a linked worktree — existsSync covers both).
function inGitWorkTree(p: string): boolean {
  let dir = resolve(p);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function exemptPrefixes(): string[] {
  const home = homedir();
  return [
    join(home, ".claude"),
    join(home, "colibri", "Notes"),
    join(home, "colibri", "tasks"),
    join(home, "colibri", "scratchpad"),
    tmpdir(),
    "/tmp",
  ];
}

function allow(): void {
  process.exit(0);
}

function block(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
}

async function main(): Promise<void> {
  let text = "";
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    return allow();
  }
  if (!text.trim()) return allow();

  let input: { cwd?: string; tool_input?: { file_path?: string } };
  try {
    input = JSON.parse(text);
  } catch {
    return allow();
  }

  const filePath =
    input.tool_input && typeof input.tool_input.file_path === "string" ? input.tool_input.file_path : "";
  if (!filePath) return allow();

  const abs = resolve(input.cwd ?? process.cwd(), filePath);

  const ctx: EditGateContext = {
    filePath: abs,
    isPaiWorker: process.env.PAI_WORKER === "1",
    isExemptPrefix: exemptPrefixes().some((p) => isUnder(abs, p)),
    isGitWorkTree: inGitWorkTree(abs),
  };

  const decision = decideEditGate(ctx);
  if (decision.decision === "block") return block(decision.reason);
  return allow();
}

main().catch(() => process.exit(0));
