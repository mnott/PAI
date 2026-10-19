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

import { currentWorkerId } from "../../../workers/worker-id.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { renderDecision } from "../lib/render-decision.js";
import { isSharedCheckout } from "../lib/shared-checkout.js";
import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir } from "../../../workers/paths.js";
import { decideOrchestratorBash } from "../lib/edit-gate.js";
import { emptyLoopState, loopDenyReason, stepLoopGuard, type LoopState } from "../lib/loop-guard.js";
import { recordToolError } from "../../../workers/tool-errors.js";
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
    sharedCheckout: () => {
      let logDir: string | null = null;
      try {
        logDir = workersLogDir(readWorkersSection().workers);
      } catch {
        // unresolvable: isSharedCheckout fails closed
      }
      return isSharedCheckout({ cwd, selfId: currentWorkerId(process.env, logDir ?? undefined), logDir });
    },
    testScript: () => {
      try {
        const pkg = JSON.parse(readFileSync(join(worktreeRoot ?? cwd, "package.json"), "utf8"));
        return typeof pkg?.scripts?.test === "string" ? pkg.scripts.test : null;
      } catch {
        return null;
      }
    },
    isIgnored: (p: string) => git(cwd, ["check-ignore", "-q", "--", p]) !== null,
  };
}

/** Per-worker repeat window in <logDir>/loop-guard/<id>.json; deny reason when this call is a loop repeat, else null. */
function loopRepeat(input: WorkerGuardInput, env: NodeJS.ProcessEnv): string | null {
  const id = currentWorkerId(env, env.PAI_WORKER_LOOP_DIR || undefined);
  if (env.PAI_WORKER !== "1" || !id || !input.tool_name) return null;
  try {
    const logDir = env.PAI_WORKER_LOOP_DIR || workersLogDir(readWorkersSection().workers);
    const dir = join(logDir, "loop-guard");
    const file = join(dir, `${id.replace(/[^\w.-]/g, "_")}.json`);
    let state: LoopState = emptyLoopState();
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as LoopState;
      if (Array.isArray(j.window)) state = j;
    } catch {
      // first call or damaged state: start a fresh window
    }
    const command = (input.tool_input as { command?: unknown } | undefined)?.command;
    const r = stepLoopGuard(state, input.tool_name, typeof command === "string" ? command : undefined);
    if (r.state !== state) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(r.state));
    }
    if (r.deny) {
      recordToolError(logDir, {
        worker: id,
        provider: env.PAI_WORKER_PROVIDER ?? "?",
        label: env.PAI_WORKER_LABEL ?? "?",
        tool: "Bash",
        text: `loop guard: same command ${typeof command === "string" ? command : ""}`,
        input: input.tool_input,
      });
    }
    return r.deny ? loopDenyReason(!!r.testRun) : null;
  } catch {
    return null; // a guard fault must never block work
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

  let input: WorkerGuardInput;
  try {
    input = JSON.parse(text) as WorkerGuardInput;
  } catch {
    return;
  }

  if (process.env.PAI_WORKER_ORCHESTRATOR === "1" && process.env.PAI_WORKER === "1" && input.tool_name === "Bash") {
    const command = (input.tool_input as { command?: unknown } | undefined)?.command;
    const d = typeof command === "string" ? decideOrchestratorBash(command) : { decision: "allow" as const };
    if (d.decision === "block") {
      process.stdout.write(renderDecision({ decision: "deny", reason: d.reason }) + "\n");
      return;
    }
  }

  const loopReason = loopRepeat(input, process.env);
  if (loopReason) {
    process.stdout.write(renderDecision({ decision: "deny", reason: loopReason }) + "\n");
    return;
  }

  const decision = decideWorkerGuard(input, process.env, () => buildContext(input.cwd || process.cwd()));
  if (decision.decision === "deny" || decision.updatedInput) process.stdout.write(renderDecision(decision) + "\n");
}

main().catch(() => process.exit(0));
