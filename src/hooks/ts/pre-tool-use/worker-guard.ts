#!/usr/bin/env node

/**
 * worker-guard.ts — PreToolUse (Bash|Edit|Write|MultiEdit|NotebookEdit)
 *
 * Worker-only (PAI_WORKER=1) enforcement of the git/worktree rules every
 * worker spec used to repeat in prose and workers still broke: no symlinks
 * out of the worktree, no repo copies, no push/publish/tag/version, no
 * tree-rewriting git in a shared checkout, no cd into the main checkout,
 * no Notes/TODO.md or live config writes, no `bun test` on a vitest repo.
 * A no-op in interactive sessions.
 *
 * This file is only I/O: read stdin, gather the git context, print the
 * decision. The decision lives in lib/worker-guard.ts and is tested there
 * and through this entry.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { renderDecision } from "../lib/sleep-poll-gate.js";
import { decideWorkerGuard, type WorkerGuardContext, type WorkerGuardInput } from "../lib/worker-guard.js";

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function buildContext(cwd: string): WorkerGuardContext {
  const worktreeRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = git(cwd, ["rev-parse", "--absolute-git-dir"]);
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const inWorktree = !!gitDir && !!common && gitDir !== common;
  return {
    cwd,
    home: homedir(),
    worktreeRoot,
    inWorktree,
    mainCheckout: inWorktree && common ? dirname(common) : null,
    testScript: () => {
      try {
        const pkg = JSON.parse(readFileSync(join(worktreeRoot ?? cwd, "package.json"), "utf8"));
        return typeof pkg?.scripts?.test === "string" ? pkg.scripts.test : null;
      } catch {
        return null;
      }
    },
  };
}

async function main(): Promise<void> {
  let text = "";
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    return;
  }
  if (!text.trim()) return;

  let input: WorkerGuardInput;
  try {
    input = JSON.parse(text) as WorkerGuardInput;
  } catch {
    return;
  }

  const decision = decideWorkerGuard(input, process.env, () => buildContext(input.cwd || process.cwd()));
  if (decision.decision === "deny") process.stdout.write(renderDecision(decision) + "\n");
}

main().catch(() => process.exit(0));
