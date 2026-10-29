#!/usr/bin/env node

/**
 * worker-guard.ts — PreToolUse (every tool: the loop guard counts them all)
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
import { markToolWait } from "../../../workers/tool-wait.js";
import { isWorkerSession } from "../lib/worker-session.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { renderDecision } from "../lib/render-decision.js";
import { isSharedCheckout } from "../lib/shared-checkout.js";
import { readWorkersSection } from "../../../workers/config.js";
import { expandHome } from "../../../daemon/config.js";
import { workersLogDir } from "../../../workers/paths.js";
import { recordLoopTelemetry } from "../lib/loop-guard-telemetry.js";
import { failLedgerOn } from "../lib/fail-ledger.js";
import { evaluate } from "../../../guard/evaluate.js";
import { loadBuildsConfig, runsDoor } from "../lib/build-gate.js";
import { operatorTestsReason } from "../lib/worker-test-rules.js";
import { loopDenyReason, actionKey, worktreeFingerprint } from "../lib/loop-guard.js";
import { loadLoopState, loopStateFile, saveLoopState } from "../lib/loop-guard-state.js";
import { recordToolError } from "../../../workers/tool-errors.js";
import { requestLoopStop } from "../../../workers/loop-stop.js";
import { isTestCommand, wrapTestCommand } from "../../../workers/hang-probe.js";
import { type WorkerGuardContext, type WorkerGuardInput } from "../lib/worker-guard.js";

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
      let benchTreesDir: string | null = null;
      try {
        const w = readWorkersSection().workers;
        logDir = workersLogDir(w);
        benchTreesDir = expandHome(w.benchTreesDir);
      } catch {
        // unresolvable: isSharedCheckout fails closed
      }
      return isSharedCheckout({ cwd, selfId: currentWorkerId(process.env, logDir ?? undefined), logDir, benchTreesDir });
    },
    testScript: () => {
      try {
        const pkg = JSON.parse(readFileSync(join(worktreeRoot ?? cwd, "package.json"), "utf8"));
        return typeof pkg?.scripts?.test === "string" ? pkg.scripts.test : null;
      } catch {
        return null;
      }
    },
    isIgnored: (p: string, dir: string) => git(dir, ["check-ignore", "-q", "--", p]) !== null,
    // tests: operator: a test runner or a door run in test mode (`sh tools/build.sh test …`)
    testCommand: (command: string) => operatorTestsReason(command, (ws, dir) => runsDoor(ws, dir, loadBuildsConfig(dir)), cwd),
  };
}

function shortKey(key = ""): string {
  const k = key.replace(/^\w+: /, "");
  return k.length > 80 ? `${k.slice(0, 77)}...` : k;
}

/** Per-worker repeat window in <logDir>/loop-guard/<id>.json; deny reason when this call is a loop repeat, else null. */
function loopRepeat(input: WorkerGuardInput, env: NodeJS.ProcessEnv): { reason: string; stopReason?: string } | { note: string } | null {
  const id = currentWorkerId(env, env.PAI_WORKER_LOOP_DIR || undefined);
  if (env.PAI_WORKER !== "1" || !id || !input.tool_name) return null;
  try {
    const logDir = env.PAI_WORKER_LOOP_DIR || workersLogDir(readWorkersSection().workers);
    const file = loopStateFile(logDir, id);
    const state = loadLoopState(file);
    const command = (input.tool_input as { command?: unknown } | undefined)?.command;
    const bashCmd = input.tool_name === "Bash" && typeof command === "string" ? command : undefined;
    const cwd = input.cwd || process.cwd();
    const decision = evaluate(
      { kind: "tool_call", tool: input.tool_name, input: input.tool_input, cwd, workerId: id },
      {
        env,
        loop: {
          state,
          fingerprint: bashCmd !== undefined && actionKey(bashCmd) !== null ? worktreeFingerprint(cwd) : null,
          now: Date.now(),
          echo: readWorkersSection().workers.loopGuard,
          failLedger: !!failLedgerOn(env, readWorkersSection().workers.failLedger),
        },
      },
    );
    const r = decision.loop!;
    if (r.state !== state) saveLoopState(file, r.state);
    recordLoopTelemetry(r, { cwd: input.cwd, sessionId: (input as { session_id?: string }).session_id, fallbackText: input.tool_name });
    if (r.deny) {
      recordToolError(logDir, {
        worker: id,
        provider: env.PAI_WORKER_PROVIDER ?? "?",
        label: env.PAI_WORKER_LABEL ?? "?",
        tool: input.tool_name,
        text: r.stop
          ? r.reason ?? `loop guard: ${input.tool_name} ${shortKey(r.key)} repeated ${r.count} times without a change; session stopped`
          : r.evasion
            ? `LOOP-GUARD-EVASION: loop guard: same command ${typeof command === "string" ? command : ""} (touching a file does not change the worktree)`
            : input.tool_name === "Bash"
              ? `loop guard: same command ${typeof command === "string" ? command : ""}`
              : `loop guard: same ${input.tool_name} ${shortKey(r.key)} (${r.count}x)`,
        input: input.tool_input,
      });
    }
    if (!r.deny) return r.note ? { note: r.note } : null;
    // Claude Code ignores "continue": false from a headless PreToolUse hook: end the worker ourselves
    if (r.stop)
      requestLoopStop(logDir, id, r.reason ?? `${input.tool_name} ${shortKey(r.key)} repeated ${r.count} times without a change`, {
        // a loop dir override marks a probe run by hand from a worker's Bash: its parent chain leads to the real claude
        claudePid: env.PAI_LOOP_STOP_PID ? () => Number(env.PAI_LOOP_STOP_PID) : env.PAI_WORKER_LOOP_DIR ? () => undefined : undefined,
      });
    return {
      reason: r.reason ?? loopDenyReason(input.tool_name, r.count),
      stopReason: r.stop
        ? r.reason ?? `loop guard: ${input.tool_name} ${shortKey(r.key)} repeated ${r.count} times without a change; stopping so the orchestrator can decide`
        : undefined,
    };
  } catch {
    return null; // a guard fault must never block work
  }
}

/** A worker starting a Bash command: stamp it, so a long one lends the slot (tool-wait.ts). Best effort. */
function markToolWaitOf(input: WorkerGuardInput): void {
  try {
    if (input.tool_name !== "Bash" || !isWorkerSession()) return;
    const logDir = process.env.PAI_WORKER_LOOP_DIR || workersLogDir(readWorkersSection().workers);
    const id = currentWorkerId(process.env, logDir);
    if (id) markToolWait(logDir, id);
  } catch {
    /* a stamp that cannot be written never blocks the tool call */
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

  markToolWaitOf(input);
  const cwd = input.cwd || process.cwd();
  const orch = evaluate({ kind: "tool_call", tool: input.tool_name as string, input: input.tool_input, cwd }, { env: process.env, gates: { orchestrator: true } });
  if (orch.action === "deny") {
    process.stdout.write(renderDecision({ decision: "deny", reason: orch.message! }) + "\n");
    return;
  }

  const loop = loopRepeat(input, process.env);
  if (loop && "note" in loop) {
    // advisory: the call goes ahead, the note rides along as context
    process.stdout.write(renderDecision({ decision: "allow", context: loop.note }) + "\n");
    return;
  }
  if (loop) {
    const out = JSON.parse(renderDecision({ decision: "deny", reason: loop.reason }));
    if (loop.stopReason) Object.assign(out, { continue: false, stopReason: loop.stopReason });
    process.stdout.write(JSON.stringify(out) + "\n");
    return;
  }

  const decision = evaluate(
    { kind: "tool_call", tool: input.tool_name as string, input: input.tool_input, cwd: input.cwd || process.cwd() },
    { env: process.env, gates: { worker: () => buildContext(input.cwd || process.cwd()) } },
  );
  if (decision.action === "deny") {
    process.stdout.write(renderDecision({ decision: "deny", reason: decision.message! }) + "\n");
    return;
  }
  if (decision.updatedInput) {
    process.stdout.write(renderDecision({ decision: "allow", updatedInput: decision.updatedInput, ...(decision.message && { context: decision.message }) }) + "\n");
    return;
  }
  // test runs (worker or main session) go through test-run: it takes the machine-wide test slot and probes a silent run
  const command = (input.tool_input as { command?: unknown } | undefined)?.command;
  if (input.tool_name === "Bash" && typeof command === "string" && process.env.PAI_WORKER_ALLOW_TESTS !== "1" && isTestCommand(command)) {
    process.stdout.write(renderDecision({ decision: "allow", updatedInput: { ...(input.tool_input as object), command: wrapTestCommand(command) } }) + "\n");
  }
}

main().catch(() => process.exit(0));
