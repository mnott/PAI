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
import { allow, deny as block, readGateInput } from "../lib/gate-io.js";
import { evaluate } from "../../../guard/evaluate.js";

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

async function main(): Promise<void> {
  const input = await readGateInput<{ cwd?: string; tool_input?: { file_path?: string; notebook_path?: string } }>();
  if (!input) return allow();

  const d = evaluate(
    { kind: "tool_call", tool: "Edit", input: input.tool_input, cwd: input.cwd ?? process.cwd() },
    { env: process.env, gates: { edit: { isExemptPrefix: (abs) => exemptPrefixes().some((p) => isUnder(abs, p)), isGitWorkTree: inGitWorkTree }, testGovernance: true } },
  );
  if (d.action === "deny") return block(d.message!);
  return allow();
}

main().catch(() => process.exit(0));
