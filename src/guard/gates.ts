/**
 * gates.ts — the pure command gates behind evaluate(): plutil rewrite, in-place worker git, the Bash gate chain
 * (main-session git, build doors, model servers, background, sleep-poll) and the worker guard (paths, bench, config).
 *
 * Each gate is a decision over (event, env) plus the facts a caller must look up for it (worktrees root, the daemon's
 * local-model answer, the git context). Those arrive through GateSet as functions, so nothing here reads Claude-Code state.
 */

import { resolve } from "node:path";
import { detectUnsafePlutil, plutilGuardMessage } from "../hooks/ts/lib/plutil-guard.js";
import { decideWorkerGitGuard, workerGitGuardMessage } from "../hooks/ts/lib/worker-git-guard.js";
import { mainSessionBashReason } from "../hooks/ts/lib/main-session-git-gate.js";
import { buildGateReason } from "../hooks/ts/lib/build-gate.js";
import { modelServerReason } from "../hooks/ts/lib/model-server-guard.js";
import { backgroundReason } from "../hooks/ts/lib/background-gate.js";
import { decideSleepPollGate } from "../hooks/ts/lib/sleep-poll-gate.js";
import { raiseWaitTimeout } from "../hooks/ts/lib/wait-timeout.js";
import { decideWorkerGuard, type WorkerGuardContext } from "../hooks/ts/lib/worker-guard.js";
import { decideEditGate, decideOrchestratorBash, decideOrchestratorEdit } from "../hooks/ts/lib/edit-gate.js";
import { checkCredentialLiteral } from "../hooks/ts/lib/credential-guard.js";
import { dropDataHeredocBodies } from "../hooks/ts/lib/heredoc.js";
import type { Decision } from "./evaluate.js";

export interface GateSet {
  /** plutil edit verbs without -o. */
  plutil?: boolean;
  /** In-place worker git guard: the worktrees root (null: unresolvable, fails closed) and whether cwd is a private clone. */
  workerGit?: { worktreesRoot: string | null; privateClone: (cwd: string) => boolean };
  /** The Bash gate chain; `localAnswer` is the daemon's cached local-model answer line. */
  bash?: { localAnswer: () => string };
  /** Orchestrator worker (PAI_WORKER_ORCHESTRATOR=1): Bash may not write code in place. */
  orchestrator?: boolean;
  /** Edit routing: code edits in a git work tree are delegated. The path facts are looked up by the caller. */
  edit?: { isExemptPrefix: (abs: string) => boolean; isGitWorkTree: (abs: string) => boolean };
  /** Worker write-time check for literal credentials in test files. */
  credential?: boolean;
  /** The worker guard (PAI_WORKER only): git/worktree context for its path, bench and config rules. */
  worker?: () => WorkerGuardContext;
}

type Call = { tool: string; input: unknown; cwd: string; env: NodeJS.ProcessEnv };

const deny = (message: string, patternId: string, guard?: Decision["guard"]): Decision => ({ action: "deny", message, patternId, mode: "enforce", guard });

const commandOf = (input: unknown): string | undefined => {
  const c = typeof input === "string" ? input : (input as { command?: unknown } | undefined)?.command;
  return typeof c === "string" && c ? c : undefined;
};

/** The command text shell rules and gates match: heredoc bodies that only feed a file are dropped (see dropDataHeredocBodies). */
export const scannedCommand = (command: string | undefined): string | undefined => (command === undefined ? undefined : dropDataHeredocBodies(command));

/** Gates that run before the shell rules. A deny wins; an allow that rewrites the input is returned only when nothing denies. */
export function decidePreGates(c: Call, g: GateSet): Decision | null {
  const isBash = c.tool === "Bash";
  // heredoc bodies written to a file are data, not commands: the gates match what runs
  const command = isBash ? scannedCommand(commandOf(c.input)) : undefined;

  if (g.orchestrator && isBash && c.env.PAI_WORKER_ORCHESTRATOR === "1" && c.env.PAI_WORKER === "1" && typeof (c.input as { command?: unknown } | undefined)?.command === "string") {
    const o = decideOrchestratorBash((c.input as { command: string }).command);
    if (o.decision === "block") return deny(o.reason, "orchestrator-bash");
  }
  if (g.credential) {
    const why = checkCredentialLiteral({ tool_name: c.tool, tool_input: c.input as never }, c.env);
    if (why) return deny(why, "credential-literal");
  }
  if (g.edit) {
    const ti = c.input as { file_path?: unknown; notebook_path?: unknown } | undefined;
    const target = ti?.file_path ?? ti?.notebook_path;
    if (typeof target === "string" && target) {
      const abs = resolve(c.cwd, target);
      const e = c.env.PAI_WORKER_ORCHESTRATOR === "1"
        ? decideOrchestratorEdit(abs)
        : decideEditGate({ filePath: abs, isPaiWorker: c.env.PAI_WORKER === "1", isExemptPrefix: g.edit.isExemptPrefix(abs), isGitWorkTree: g.edit.isGitWorkTree(abs) });
      if (e.decision === "block") return deny(e.reason, "edit-gate");
    }
  }

  if (g.plutil && command) {
    const p = detectUnsafePlutil(command);
    if (p.blocked) return deny(plutilGuardMessage(p.verb || "this verb"), "plutil-guard", { category: "plutil_guard", pattern: p.invocation });
  }
  if (g.workerGit && command && c.env.PAI_WORKER === "1") {
    const cwd = resolve(c.cwd);
    const w = decideWorkerGitGuard(command, true, cwd, g.workerGit.worktreesRoot);
    if (w.blocked && !g.workerGit.privateClone(cwd)) {
      return deny(workerGitGuardMessage(w.cmd || "this git command"), "worker-git-guard", { category: "worker_git_guard", pattern: w.cmd });
    }
  }
  if (g.bash) {
    const ti = c.input as { run_in_background?: boolean; command?: string; timeout?: number } | undefined;
    const why = !isBash
      ? null
      : (typeof ti?.command === "string"
        ? (c.env.PAI_WORKER !== "1" ? mainSessionBashReason(command ?? ti.command, c.cwd) : null) ??
          buildGateReason(command ?? ti.command, c.cwd) ??
          modelServerReason(command ?? ti.command, c.env, g.bash.localAnswer())
        : null) ?? backgroundReason(ti, c.env);
    if (why) return deny(why, "bash-gate");
    const sp = decideSleepPollGate({ tool_name: c.tool, tool_input: ti }, c.env);
    if (sp.decision === "deny") return deny(sp.reason, "sleep-poll-gate");
    if (c.env.PAI_WORKER !== "1") {
      const raised = raiseWaitTimeout(ti);
      if (raised) return { action: "allow", updatedInput: raised };
    }
  }
  return null;
}

/** The worker guard as a Decision: deny with its reason, or allow with the rewritten input / advisory context. */
export function decideWorkerGate(c: Call, g: GateSet): Decision | null {
  if (!g.worker) return null;
  const d = decideWorkerGuard({ tool_name: c.tool, cwd: c.cwd, tool_input: c.input as never }, c.env, g.worker);
  if (d.decision === "deny") return deny(d.reason, "worker-guard");
  return d.updatedInput || d.context ? { action: "allow", updatedInput: d.updatedInput, message: d.context } : null;
}
