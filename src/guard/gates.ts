/**
 * gates.ts — the pure command gates behind evaluate(): plutil rewrite, in-place worker git, the Bash gate chain
 * (main-session git, build doors, model servers, background, sleep-poll) and the worker guard (paths, bench, config).
 *
 * Each gate is a decision over (event, env) plus the facts a caller must look up for it (worktrees root, the daemon's
 * local-model answer, the git context). Those arrive through GateSet as functions, so nothing here reads Claude-Code state.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ORCHESTRATOR_START_BLOCK, QUEUED_CHILD_RULE } from "../workers/report.js";
import { detectUnsafePlutil, plutilGuardMessage } from "../hooks/ts/lib/plutil-guard.js";
import { decideWorkerGitGuard, workerGitGuardMessage } from "../hooks/ts/lib/worker-git-guard.js";
import { mainSessionBashReason } from "../hooks/ts/lib/main-session-git-gate.js";
import { buildGateReason, buildGateRewrite } from "../hooks/ts/lib/build-gate.js";
import { memoryBashRules } from "../hooks/ts/lib/memory-bash-gate.js";
import { modelServerReason } from "../hooks/ts/lib/model-server-guard.js";
import { hostSimulatorReason } from "../hooks/ts/lib/host-simulator-guard.js";
import { apiKeySetMatch, API_KEY_SET_REASON } from "../hooks/ts/lib/api-key-gate.js";
import { headlessReason } from "../hooks/ts/lib/headless-gate.js";
import { backgroundReason } from "../hooks/ts/lib/background-gate.js";
import { decideSleepPollGate } from "../hooks/ts/lib/sleep-poll-gate.js";
import { decideSamplerGate } from "../hooks/ts/lib/sampler-gate.js";
import { raiseWaitTimeout } from "../hooks/ts/lib/wait-timeout.js";
import { decideWorkerGuard, type WorkerGuardContext } from "../hooks/ts/lib/worker-guard.js";
import { decideEditGate, decideOrchestratorBash, decideOrchestratorEdit, decidePlannerLockBash, decidePlannerLockEdit } from "../hooks/ts/lib/edit-gate.js";
import { decideTestGovernance } from "../hooks/ts/lib/test-governance.js";
import { checkCredentialLiteral } from "../hooks/ts/lib/credential-guard.js";
import { dropDataHeredocBodies } from "../hooks/ts/lib/heredoc.js";
import { browserAutomationBashReason, browserAutomationEditReason, addedText } from "../hooks/ts/lib/browser-automation-gate.js";
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
  /** L1 lock (PAI_WORKER_CLASS orchestrate/plan without --orchestrate): edits denied until one child worker has failed. `worktreeRoot` is the cwd's git toplevel — the Bash lock denies only resolved targets inside it. */
  planner?: { childFailed: () => boolean; worktreeRoot?: () => string | null };
  /** Edit routing: code edits in a git work tree are delegated. The path facts are looked up by the caller. */
  edit?: { isExemptPrefix: (abs: string) => boolean; isGitWorkTree: (abs: string) => boolean };
  /** Test governance: a new test file is one-time and lives in .pai-scratch/ unless promoted in tests/KEPT.md. */
  testGovernance?: boolean;
  /** Operator rule: no headless-browser automation (Bash runs/installs, Edit/Write imports). */
  browserAutomation?: boolean;
  /** Worker write-time check for literal credentials in test files. */
  credential?: boolean;
  /** `pai worker kill <id>` by a worker: the state of <id> when it is that worker's own child, else undefined. A queued child may not be killed. */
  ownChildState?: (id: string) => string | undefined;
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
    // an orchestrator reading the long run help is hunting for how to start an implementer: answer once with the compact block
    if (/^\s*pai\s+worker\s+run\s+(--help|-h)(\s|$)/.test((c.input as { command: string }).command) && c.env.TMPDIR) {
      const marker = join(c.env.TMPDIR, ".orchestrator-run-help-shown");
      if (!existsSync(marker)) {
        try { writeFileSync(marker, "1"); } catch { /* unwritable scratch: no denial */ return null; }
        return deny(ORCHESTRATOR_START_BLOCK, "orchestrator-run-help");
      }
    }
  }
  if (g.planner && c.env.PAI_WORKER === "1" && c.env.PAI_WORKER_ORCHESTRATOR !== "1" && (c.env.PAI_WORKER_CLASS === "orchestrate" || c.env.PAI_WORKER_CLASS === "plan")) {
    const ti = c.input as { file_path?: unknown; notebook_path?: unknown; command?: unknown } | undefined;
    const target = ti?.file_path ?? ti?.notebook_path;
    let d: ReturnType<typeof decidePlannerLockEdit> | null = null;
    if (isBash && typeof ti?.command === "string") d = decidePlannerLockBash(ti.command, c.env.TMPDIR, resolve(c.cwd), g.planner.worktreeRoot?.() ?? undefined);
    else if ((c.tool === "Edit" || c.tool === "Write" || c.tool === "NotebookEdit" || c.tool === "MultiEdit") && typeof target === "string" && target) {
      d = decidePlannerLockEdit(resolve(c.cwd, target), resolve(c.cwd), c.env.TMPDIR);
    }
    // ponytail: one failed child unlocks takeover for all packages; per-package unlock if that proves too loose
    if (d?.decision === "block" && !g.planner.childFailed()) return deny(d.reason, "planner-lock");
  }
  if (g.ownChildState && isBash && c.env.PAI_WORKER === "1" && command) {
    for (const m of command.matchAll(/(?:^|[;&|(]\s*)pai\s+worker\s+kill\s+(?:--?\S+\s+(?:"[^"]*"|'[^']*'|\S+)\s+)*?([A-Za-z0-9][\w.-]*)/g)) {
      if (g.ownChildState(m[1]) === "queued") return deny(QUEUED_CHILD_RULE, "queued-child-kill");
    }
  }
  if (g.browserAutomation) {
    const ti = c.input as { file_path?: unknown; command?: unknown } | undefined;
    const why = isBash
      ? (command ? browserAutomationBashReason(command, c.cwd, c.env.TMPDIR) : null)
      : typeof ti?.file_path === "string"
        ? browserAutomationEditReason(resolve(c.cwd, ti.file_path), addedText(c.input as never))
        : null;
    if (why) return deny(why, "browser-automation", { category: "browser_automation" });
  }
  if (g.credential) {
    const why = checkCredentialLiteral({ tool_name: c.tool, tool_input: c.input as never }, c.env);
    if (why) return deny(why, "credential-literal");
  }
  if (g.testGovernance) {
    const ti = c.input as { file_path?: unknown; notebook_path?: unknown; command?: unknown } | undefined;
    const target = ti?.file_path ?? ti?.notebook_path;
    const tg = decideTestGovernance({
      tool: c.tool,
      filePath: typeof target === "string" ? resolve(c.cwd, target) : undefined,
      command: typeof ti?.command === "string" ? (command ?? ti.command) : undefined,
      cwd: c.cwd,
    });
    if (tg.decision === "deny") return deny(tg.reason, "test-governance", { category: "test_governance" });
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
  // operator rule: no command may set ANTHROPIC_API_KEY on a process (workers and L0 alike)
  if (command) {
    const k = apiKeySetMatch(command);
    if (k) return deny(API_KEY_SET_REASON, "api-key-set", { category: "api_key_set", pattern: k });
  }
  if (g.workerGit && command && c.env.PAI_WORKER === "1") {
    const cwd = resolve(c.cwd);
    const w = decideWorkerGitGuard(command, true, cwd, g.workerGit.worktreesRoot);
    if (w.blocked && !g.workerGit.privateClone(cwd)) {
      return deny(workerGitGuardMessage(w.cmd || "this git command"), "worker-git-guard", { category: "worker_git_guard", pattern: w.cmd });
    }
  }
  let memoNote: string | undefined;
  if (g.bash) {
    const ti = c.input as { run_in_background?: boolean; command?: string; timeout?: number } | undefined;
    // a plain build invocation is routed through the queue instead of denied
    const buildRewrite = isBash && typeof ti?.command === "string" && ti.command === (command ?? ti.command) ? buildGateRewrite(ti.command, c.cwd) : null;
    const why = !isBash
      ? null
      : (typeof ti?.command === "string"
        ? (c.env.PAI_WORKER !== "1" ? mainSessionBashReason(command ?? ti.command, c.cwd) : null) ??
          (buildRewrite ? null : buildGateReason(command ?? ti.command, c.cwd)) ??
          headlessReason(command ?? ti.command, c.env, c.cwd) ??
          modelServerReason(command ?? ti.command, c.env, g.bash.localAnswer()) ??
          hostSimulatorReason(command ?? ti.command, c.env)
        : null) ?? backgroundReason(ti, c.env);
    if (why) return deny(why, "bash-gate");
    if (isBash && typeof ti?.command === "string") {
      const m = memoryBashRules(command ?? ti.command, c.env, c.cwd);
      if (m.deny) return deny(m.deny, "memory-bash-gate");
      if (m.note) memoNote = m.note;
    }
    const sp = decideSleepPollGate({ tool_name: c.tool, tool_input: ti }, c.env);
    if (sp.decision === "deny") return deny(sp.reason, "sleep-poll-gate");
    const sg = decideSamplerGate({ tool_name: c.tool, tool_input: ti });
    if (sg.decision === "deny") return deny(sg.reason, "sampler-gate");
    if (buildRewrite) return { action: "allow", updatedInput: { ...ti, command: buildRewrite.command }, message: [buildRewrite.note, memoNote].filter(Boolean).join("; ") };
    if (c.env.PAI_WORKER !== "1") {
      const raised = raiseWaitTimeout(ti);
      if (raised) return { action: "allow", updatedInput: raised, message: memoNote };
    }
  }
  return memoNote ? { action: "note", patternId: "memory-bash-gate", message: memoNote } : null;
}

/** The worker guard as a Decision: deny with its reason, or allow with the rewritten input / advisory context. */
export function decideWorkerGate(c: Call, g: GateSet): Decision | null {
  if (!g.worker) return null;
  const d = decideWorkerGuard({ tool_name: c.tool, cwd: c.cwd, tool_input: c.input as never }, c.env, g.worker);
  if (d.decision === "deny") return deny(d.reason, "worker-guard");
  if (d.decision === "ask") return deny(d.reason, "worker-guard");
  return d.updatedInput || d.context ? { action: "allow", updatedInput: d.updatedInput, message: d.context } : null;
}
