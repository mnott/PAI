/**
 * run.ts — the worker runner (port of the glm / glm-run pair, provider-neutral).
 *
 * One claude-code process per call, pointed at the chosen provider:
 *
 *   - env: ANTHROPIC_BASE_URL/AUTH_TOKEN from the provider (token from its
 *     key file, never from the environment), the three DEFAULT_*_MODEL vars,
 *     the provider's extra env, nonessential traffic off, and ANTHROPIC_API_KEY
 *     stripped so nothing can fall back to Anthropic billing. Headless runs
 *     also drop the spawner's session identity (messaging socket, session id,
 *     nesting markers) — inherited, a worktree child starts tool-blind.
 *     OpenAI-protocol providers point at the PAI proxy instead (started on
 *     demand, the provider name in the URL path); codex-engine providers run
 *     the Codex CLI.
 *   - headless (-p): strict empty MCP config unless the caller brings one or
 *     names servers via --mcp / a role (then a filtered <id>.mcp.json), the
 *     core tool grants the caller did not bring (a headless run cannot
 *     approve a permission-gated tool mid-flight — with no grant at all,
 *     claude drops the file/shell tools entirely and the worker is
 *     tool-blind), PAI_WORKER=1 so PAI's per-session hooks leave it alone,
 *     the worker
 *     contract appended to the system prompt, `--input-format stream-json`
 *     with the prompt as the first stdin user message (the operator socket
 *     can add more mid-run), stream-json mirroring (every line stamped `_ts`)
 *     into <logDir>/<id>.jsonl, a live <id>.status for ps/follow/status line
 *     (context meter included), ledger lines, result printed in the caller's
 *     --output-format (json adds the parsed `report`), and the follow pane
 *     (unless --no-pane).
 *   - interactive: no MCP/tool restriction by default, no pane,
 *     ENABLE_TOOL_SEARCH=true. A project that pinned a list with `pai
 *     project mcp` / `pai project tools` gets `--strict-mcp-config
 *     --mcp-config <filtered>` / `--tools <list>` built the same way a
 *     headless run's allowlist is; an explicit --mcp or --tools on this
 *     command line still wins over the project's pin.
 *
 * Auto-routed runs that die of a quota error before the first tool call are
 * restarted on the next provider in routing order (WORKER-REROUTE ledger line).
 */

import { grantedToolNames, recordToolError } from "./tool-errors.js";
import { editHintFor } from "./edit-assist.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  writeSync,
} from "node:fs";
import { appendSystemPromptArgs, parseRunnerArgs, shortText, stripPromptValues } from "./args.js";
import {
  ANTHROPIC_NATIVE,
  assertProviderRunnable,
  classModelCapability,
  isModelCapability,
  NATIVE_ANTHROPIC_MODELS,
  readWorkersSection,
  resolveModelCapability,
  type WorkerProvider,
} from "./config.js";
import { buildRunEnv, claudeCommand, isLoopbackProvider, routeLoopbackViaRouter } from "./run-env.js";
import { resolveLocalProvider } from "./local-provider.js";
import { probeRouter } from "../router/supervisor.js";
import { detectCurrentModel } from "./launch.js";

export { buildRunEnv } from "./run-env.js";
import { appendLedger } from "./ledger.js";
import { decideEndReason, endFields, parentInfo, type EndInfo } from "./endreason.js";
import { takeLoopStop } from "./loop-stop.js";
import {
  ensureNoMcpConfig,
  eventsPath,
  ledgerPath,
  noMcpConfigPath,
  workersLogDir,
} from "./paths.js";
import { slimProfileArgs, WORKER_BRIEF } from "./slim-profile.js";
import {
  type WorkerStatus,
  newWorkerId,
  loadStatus,
  saveStatus,
  markStartFailed,
  describeTool,
  nowStamp,
  parseSleepSecs,
  UNLABELED,
} from "./status.js";
import { certainContextWindow } from "../utils/model-window.js";
import { resolveSession, resolveSpawnerSession } from "./scope.js";
import { applySessionProviderEnv } from "./session-provider.js";
import { returnControlsIfHeld } from "./controls.js";
import { fallThroughReason, isLocalProvider, routeRun, type RouteInfo } from "./policy.js";
import { capacityGate, resolveCap } from "./capacity.js";
import { recordWarmup, staggerGate } from "./stagger.js";
import {
  autoOrder,
  capabilityForRun,
  isQuotaFailure,
  nextAutoProvider,
  recordBudgetCooldowns,
  resolveCapabilityRun,
  resolveTarget,
  setCooldown,
  type CapabilityRunResolution,
} from "./routing.js";
import { budgetCache } from "./budget.js";
import { runImageCapability } from "./engines/image.js";
import { ALLOW_HIDDEN_ENV, headlessAllowed, headlessOverridePath, openPaneForWorker, openVerifiedPane, paneBackend, panePlacement, resolveHostSession } from "./pane.js";
import { assertChildAllowed, checkOrphanedChildren, isWorkerId, launchParent } from "./tree.js";
import { deliverHandoff, isHandoffMessage } from "./handoff.js";
import {
  addWorktree,
  adoptTree,
  markResumed,
  salvageOnExit,
  gcWorktreesThrottled,
  inPlaceSystemPrompt,
  recordWorktree,
  worktreeSystemPrompt,
  worktreeWanted,
  type WorktreeInfo,
} from "./worktree.js";
import {
  OPERATOR_MARK,
  AG2_REASK_TEXT,
  promptTrailer,
  workerContractPrompt,
  parseWorkerReport,
  verifyReportChanges,
  verifyFailNote,
  checkProof,
  newUntracked,
  untrackedPaths,
  type BashRun,
  type WorkerReport,
} from "./report.js";
import { recordDenial } from "./denials.js";
import { validateAg2 } from "./agentish.js";
import { loadContractAddendum, type ContractAddendum } from "./contract-addendum.js";
import { loadPreamble, preambleBlock, preambleLine, type Preamble } from "./preamble.js";
import { killTree } from "./kill-tree.js";
import { armDeadline, deadlinePromptLine, resolveLimit, type RunLimit } from "./deadline.js";
import { stripBrowserArgs, stripBrowserNames } from "./browser-tools.js";
import { expandMcpNames, grantsChrome, mcpServersFromToolGrants, writeMcpConfig } from "./mcp.js";
import { pinNotices, projectLaunchConfig, type ProjectLaunchConfig } from "./project-config.js";
import { createOperatorServer } from "./operator.js";
import { inputSideTokens, type UsageBlock } from "../utils/input-side-tokens.js";
import { DEFAULT_PROXY_PORT, ensureProxyRunning } from "./proxy/server.js";
import {
  buildCodexArgs,
  buildCodexEnv,
  codexDroppedFlags,
  codexInstalled,
  emptyCodexResult,
  foldCodexLine,
  parseCodexLine,
} from "./codex.js";
import {
  poolIneligibleReason,
  poolSettings,
  postTaskToPool,
  type PoolTaskResponse,
} from "./pool.js";

export interface RunOptions {
  providerFlag?: string;
  /** --class value (the old --role): a task class from workers.classes. */
  className?: string;
  modelFlag?: string;
  label?: string;
  noPane?: boolean;
  /** --no-stagger: skip the same-provider start gate. */
  noStagger?: boolean;
  /** --no-queue: skip the per-provider concurrency cap. */
  noQueue?: boolean;
  /** --now: wait at the front of the provider's queue (capacity.ts). */
  priority?: "front";
  /** --model fast without a provider: the routed provider's fast model. */
  modelFast?: boolean;
  /** --spec value, resolved for display/recording ("-" for stdin). */
  specPath?: string;
  /** --mcp value: server/set names, comma-separated. */
  mcpFlag?: string;
  /** Everything after `--` (the claude args). */
  claudeArgs: string[];
  /** Working directory for the run (default: this process's cwd). */
  cwd?: string;
  /** Chain stage bookkeeping: the chain id this stage belongs to. */
  parent?: string;
  /** Chain stage bookkeeping: the class name of this stage. */
  stage?: string;
  /** Suppress result printing (MCP worker_run: its stdout is the RPC channel). */
  quiet?: boolean;
  /** Internal: notified with the worker id once it exists (resume uses it). */
  onWorkerStart?: (wid: string) => void;
  /** Internal: preset worker id (the planner mints its id before phase 1). */
  id?: string;
  /** --worktree/--no-worktree; undefined lets the class default decide. */
  worktreeFlag?: boolean;
  /** Resume: the id whose worktree this run takes over (see adoptTree). */
  resumeOf?: string;
  /** --max-minutes: stop the run after N minutes (0 = no limit; default workers.defaultMaxMinutes). */
  maxMinutes?: number;
  /** --deadline HH:MM (local): stop the run then; exclusive with maxMinutes. */
  deadline?: string;
  /** --browser / --no-browser: undefined follows workers.noBrowserByDefault. */
  browser?: boolean;
  /** --print-cmd: print the assembled claude argv as JSON and exit, no spawn. */
  printCmd?: boolean;
  /** "provider/model (why)" — one line on how the provider was chosen. */
  routeWhy?: string;
  /** --urgent: wants a fast turnaround (policy auto/prefer-local route to the cloud). */
  urgent?: boolean;
  /** --local-ok: this run may go local under policy prefer-cloud. */
  localOk?: boolean;
  /** --cloud: this run goes to the cloud under policy prefer-local/auto. */
  cloud?: boolean;
  /** --local: run on the local model server PAI resolves (resolveLocalProvider); beats --provider. */
  localFlag?: boolean;
  /** Internal: the policy already decided (fall-through re-run); carries its route and the run it repeats. */
  _route?: RouteInfo;
  _fallThroughOf?: string;
  /** Internal: suppress recursion depth on reroute. */
  _reroutes?: number;
  /** Internal: this run is the one automatic re-launch after an empty model response. */
  _emptyRetried?: boolean;
  /** Internal: this run is the planner's phase-1 worker, not a new orchestration. */
  _planner?: boolean;
  /** --report json|ag2: which contract/parser the run uses (default: ag2, or PAI_WORKER_REPORT). */
  reportFormatFlag?: "json" | "ag2";
  /** --no-report-retry: skip the one bounded re-ask on an invalid AG2 final message. */
  noReportRetry?: boolean;
  /** --orchestrate: the worker plans and reviews; code edits are denied (PAI_WORKER_ORCHESTRATOR=1). */
  orchestrate?: boolean;
  /** --capability/--for: run through resolveCapability instead of resolveTarget. */
  capabilityFlag?: string;
  /** --out: image-engine output path (default: <logDir>/<id>.png). */
  imageOut?: string;
  /** --size: image-engine "WIDTHxHEIGHT" (default: 1024x1024). */
  imageSize?: string;
  /** --timeout-ms: image-engine request timeout (default: 120000). */
  imageTimeoutMs?: number;
}

/**
 * ag2 unless the caller passed --report json or PAI_WORKER_REPORT=json is
 * set in the environment; an explicit flag always wins over the env default.
 */
export function resolveReportFormat(
  flag: "json" | "ag2" | undefined,
  env: NodeJS.ProcessEnv = process.env
): "json" | "ag2" {
  if (flag) return flag;
  return env.PAI_WORKER_REPORT === "json" ? "json" : "ag2";
}

/** The strict empty MCP config for headless workers, written on demand. */
export { ensureNoMcpConfig } from "./paths.js";

/** A stream-json user message for the child's stdin. */
export function stdinUserMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}

/** An operator line as the worker sees it: carrying the contract's marker. */
export function operatorUserText(text: string): string {
  return `${OPERATOR_MARK} ${text}`;
}

/**
 * ISO stamp with seconds, attached to every mirrored event (2g): local time
 * with its offset (`2026-09-17T14:19:23+02:00`), so the viewer can render the
 * wall clock the operator lives in. `offMin` is east-positive minutes —
 * injectable so tests do not depend on the machine's zone.
 */
export function isoStamp(d = new Date(), offMin = -d.getTimezoneOffset()): string {
  const t = new Date(d.getTime() + offMin * 60_000);
  const sign = offMin < 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${t.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

// a type alias (not an interface): it must stay assignable to
// Record<string, unknown> when written into the event transcript
export type StreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  context_window?: number;
  model_info?: { context_window?: number } | null;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      id?: string;
      tool_use_id?: string;
      input?: unknown;
      /** tool_result blocks: the result payload (string or text blocks). */
      content?: unknown;
      is_error?: boolean;
    }>;
    usage?: UsageBlock;
  };
  usage?: UsageBlock;
  result?: string;
  is_error?: boolean;
  is_compact?: boolean;
  num_turns?: number;
  duration_ms?: number;
  /** API time of the final turn — the TTFT proxy on zeroed per-turn usage. */
  duration_api_ms?: number;
};

/** Context tokens of an assistant/result usage block (input+cache+output). */
export function usageContextTokens(u: UsageBlock | undefined): number | null {
  if (!u) return null;
  const t =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  return t > 0 ? t : null;
}

/** Current context fill of one assistant turn: the input side, no output. */
export function usageContextUsed(u: UsageBlock | undefined): number | null {
  if (!u) return null;
  const t = inputSideTokens(u);
  return t > 0 ? t : null;
}

/**
 * Context never shrinks mid-segment, so the status keeps the high-water
 * mark of the usage it has seen: a smaller later reading (short reply,
 * sidechain answer) must not drag the meter down. Compaction is the one
 * legitimate drop — see `resetContextTokensOnCompact`.
 */
export function bumpContextTokens(status: Pick<WorkerStatus, "contextTokens">, tokens: number | null): void {
  if (tokens === null || tokens <= 0) return;
  status.contextTokens = Math.max(status.contextTokens ?? 0, tokens);
}

/**
 * A compact boundary (`system`/`compact_boundary`, the shape Claude Code
 * writes with `compactMetadata.preTokens`; `compact` kept as the older
 * spelling) legitimately restarts the context at a lower size: the floor
 * drops to the event's own usage — usually none — so the next usage
 * reading re-seeds the meter at the fresh, smaller context.
 */
export function resetContextTokensOnCompact(status: Pick<WorkerStatus, "contextTokens">, e: StreamEvent): void {
  status.contextTokens = usageContextTokens(e.usage) ?? null;
}

/** A compact boundary in a worker's stream, in either event spelling. */
export function isCompactBoundary(e: StreamEvent): boolean {
  return e.type === "system" && (e.subtype === "compact_boundary" || e.subtype === "compact");
}

/** The command string of a Bash tool_use input, "" when there is none. */
function bashCommand(input: unknown): string {
  if (typeof input === "object" && input !== null && typeof (input as { command?: unknown }).command === "string") {
    return (input as { command: string }).command;
  }
  return "";
}

export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : ""
      )
      .join("\n");
  }
  return "";
}

/**
 * Whether a tool_result block is a failed execution: the harness's own
 * is_error flag, or — the older Bash spelling — an "Exit code N" line with a
 * non-zero N in the result text. Feeds the consecFails counter supervision's
 * thrashing detector reads.
 */
export function toolResultFailed(block: { is_error?: boolean; content?: unknown }): boolean {
  if (block.is_error === true) return true;
  const m = toolResultText(block.content).match(/Exit code (\d+)/);
  return m !== null && Number(m[1]) !== 0;
}

/** CLI aliases the built-in provider hands to `--model` (NATIVE_ANTHROPIC_MODELS'
 *  values): a bare name like "sonnet", not a concrete id, so the init event's
 *  resolved id is always the more useful thing to display. */
const NATIVE_MODEL_ALIASES = new Set(Object.values(NATIVE_ANTHROPIC_MODELS));

/**
 * The model the init event announces, adopted into the status when the spawn
 * could not name one (a caller that passed `--model` itself in the claude
 * args, or a provider whose table has no entry for the capability) or named
 * only a CLI alias (the built-in provider's "sonnet"/"haiku", which tracks
 * whatever release is current — the init event says which one actually ran).
 * The run's real model is then only knowable from the first event it sends.
 * Never overwrites a concrete resolved or pinned model — that stays the
 * recorded truth.
 */
export function adoptInitModel(status: Pick<WorkerStatus, "model">, e: StreamEvent): void {
  if (status.model && !NATIVE_MODEL_ALIASES.has(status.model)) return;
  const m = (e.model ?? "").trim();
  if (m) status.model = m;
}

/**
 * The model a run goes out on: an explicit `--model` wins; else the class
 * target's alias ("glm/fast") names the capability; else the capability the
 * class implies (image → image model, spotcheck/simple → fast, everything
 * else → default), resolved against the provider's model table. The built-in
 * anthropic provider resolves through the same table as any other, so a
 * worker never inherits the orchestrator session's model.
 */
export function resolveRunModel(
  target: { provider: WorkerProvider; modelAlias: string | null },
  className?: string,
  modelFlag?: string
): string {
  if (modelFlag) return modelFlag;
  const alias = target.modelAlias;
  const capability =
    alias && isModelCapability(alias) ? alias : classModelCapability(className);
  return resolveModelCapability(target.provider, capability);
}

/**
 * The `--model` part of the claude argv. Skipped when the caller already
 * pinned one in the claude args (it must not be clobbered) or when nothing
 * resolved — `--model ""` would break the spawn.
 */
export function modelArgs(model: string, callerPinned: boolean): string[] {
  return !callerPinned && model ? ["--model", model] : [];
}

/**
 * Two model ids name the same model when their canonical forms do: a
 * bracketed suffix is a context-window variant, not another model
 * ("glm-5.3[1m]" IS "glm-5.3", announced with a 1M window — the same
 * collision the init event's adoptInitModel sees).
 */
export function canonicalModelId(id: string): string {
  return id.trim().replace(/\[[^\]]*\]$/, "");
}

export interface ModelStepDown {
  /** The model id the run goes out on. */
  model: string;
  /** One launch-preamble line, or null when resolution is unchanged. */
  notice: string | null;
}

/**
 * The model step-down: a worker never runs on the orchestrator's own model —
 * enforced here, not remembered (config.ts states the principle). Until
 * 2026-10-17 it was only enforced where a model id is named explicitly: with
 * no --model, the class map's default tier resolved glm's default model —
 * glm-5.3[1m], the very model the orchestrating session itself ran — and
 * nothing detected the equality. Mechanical now: when the resolved id equals
 * the orchestrating session's (detected from the environment exactly the way
 * `pai launch --list --current` does it, launch.ts's detectCurrentModel), the
 * same provider's fast model replaces it. An explicit operator --model always
 * wins, including "use your own model" — the runner's own flag and a --model
 * pinned in the claude args both count as explicit. A provider without a
 * distinct fast model keeps the resolved model with a warning; a run is never
 * refused over this. An undetectable orchestrator model changes nothing.
 */
export function stepDownOrchestratorModel(opts: {
  resolved: string;
  providerName: string;
  provider: Pick<WorkerProvider, "models">;
  /** Explicit --model (the runner's own flag): the operator's choice wins. */
  modelFlag?: string;
  /** The caller pinned --model in the claude args: also explicit. */
  callerPinned?: boolean;
  env?: NodeJS.ProcessEnv;
}): ModelStepDown {
  if (opts.modelFlag || opts.callerPinned) return { model: opts.resolved, notice: null };
  const orchestrator = detectCurrentModel(opts.env ?? process.env);
  if (!orchestrator) return { model: opts.resolved, notice: null };
  if (canonicalModelId(opts.resolved) !== canonicalModelId(orchestrator)) {
    return { model: opts.resolved, notice: null };
  }
  const fast = opts.provider.models.fast;
  if (!fast || canonicalModelId(fast) === canonicalModelId(opts.resolved)) {
    return {
      model: opts.resolved,
      notice:
        `pai: worker model == orchestrator model — provider "${opts.providerName}" has no distinct ` +
        `fast model, keeping ${opts.resolved} (workers never inherit the orchestrator's model)`,
    };
  }
  return {
    model: fast,
    notice:
      `pai: worker model == orchestrator model — stepped down to ${fast} ` +
      `(workers never inherit the orchestrator's model); pass --model to override`,
  };
}

/**
 * Whether the run's assembled cmd gets a forced --model. Headless workers
 * always take the resolved class/provider model — that table exists so
 * spawned subagents stay cheap. An interactive launch (`pai worker run` with
 * no -p) IS the chat pane, not a subagent: with no --model of the caller's
 * own it gets none here either, so Claude Code's own settings.json model
 * applies, exactly as launching `claude` by hand would (2026-09-20: an
 * interactive supervisor came up on the class model instead of the
 * settings.json [1m] variant, then needed a manual /model switch that
 * rebuilt the whole cache). A caller's own --model, headless or not, is
 * already in the passthrough args and must not be duplicated here.
 */
export function modelFlagArgs(headless: boolean, model: string, callerPinned: boolean): string[] {
  return headless ? modelArgs(model, callerPinned) : [];
}

/**
 * The prompt text actually sent to the worker and whether the trailer got
 * appended. An instruction at the END of the user turn outweighs one buried
 * in the system prompt (measured 2026-09-20: the AG2 contract alone was
 * ignored by both Haiku and Sonnet). Never applied to an interactive launch
 * (no -p) or when the caller brought its own --append-system-prompt — the
 * trailer's "format in system prompt" would then point at nothing.
 */
export function headlessPromptText(
  prompt: string | null,
  headless: boolean,
  callerSystemPrompt: boolean,
  format: "ag2" | "json"
): { text: string | null; applied: boolean } {
  const applied = headless && prompt !== null && !callerSystemPrompt;
  return { text: applied ? prompt! + promptTrailer(format) : prompt, applied };
}

/**
 * Whether an invalid final report earns the one bounded re-ask: only when a
 * real validator caught the problem (a missing/broken aibroker must never
 * block the run further), the caller did not opt out, and there is a session
 * to resume into. Cap of exactly one is enforced by the caller never calling
 * this twice for the same run.
 */
export function shouldRetryReport(
  validation: { ok: boolean; validator: "aibroker" | "none" },
  noReportRetry: boolean,
  hasSession: boolean
): boolean {
  return !validation.ok && validation.validator === "aibroker" && !noReportRetry && hasSession;
}

/** Context window announced by the init event, when the endpoint sends one. */
/**
 * An empty model response: the model "answered" without producing anything —
 * no tool ran and the result text is empty. A local model can stop at once with an empty reply;
 * it is a harness failure, not a finished run (rc 0 and a result record
 * notwithstanding). Usage plays no part: local servers report 0/0 on every
 * message, normal ones too.
 */
export function isEmptyResponse(resultText: string | undefined, tools: number): boolean {
  return tools === 0 && (resultText ?? "").trim() === "";
}

/**
 * Did the run end well? A headless run must have produced a stream-json
 * result event that is not an error; an interactive launch IS the chat pane
 * and never emits one, so its clean exit (rc 0) is the whole verdict —
 * without this every interactive session that ends normally was recorded
 * as `failed rc=0` and supervision pinged the spawner about a non-failure.
 */
export function runSucceeded(
  headless: boolean,
  rc: number,
  resultEvent: Pick<StreamEvent, "is_error"> | null,
): boolean {
  if (rc !== 0) return false;
  if (!headless) return true;
  return resultEvent !== null && !resultEvent.is_error;
}

export function initContextWindow(e: StreamEvent): number | null {
  if (typeof e.context_window === "number" && e.context_window > 0) return e.context_window;
  if (e.model_info && typeof e.model_info.context_window === "number" && e.model_info.context_window > 0) {
    return e.model_info.context_window;
  }
  // the `[1m]` model variant announces a 1M-token window by suffix
  if (/\[1m\]$/.test((e.model ?? "").trim())) return 1_000_000;
  return null;
}

/**
 * Run one worker. Returns the process exit code to pass through.
 * Throws WorkersConfigError-shaped Errors for configuration problems.
 */
export async function runWorker(opts: RunOptions): Promise<number> {
  const { raw: _raw, workers: config } = readWorkersSection();
  void _raw;
  if (!config.enabled) {
    throw new Error(
      `workers are off. Turn them on with: pai worker on` +
        `\n(then the Agent-tool hook stops denying Anthropic subagents only when you do)`
    );
  }
  const logDir = workersLogDir(config);
  mkdirSync(logDir, { recursive: true });
  try {
    const gc = gcWorktreesThrottled(logDir)?.filter((r) => r.archive);
    if (gc?.length) process.stderr.write(`pai worker: archived ${gc.length} leftover worktree(s) (pai worker gc)\n`);
  } catch {
    // best effort
  }

  // class plan is not one worker but the planner orchestration (planner.ts)
  if (opts.className === "plan" && !opts._planner) {
    const { runPlanner } = await import("./planner.js");
    return runPlanner(opts);
  }

  // Sub-worker bookkeeping: an explicit parent (chain stage, planner child)
  // wins, else the worker this process runs inside (PAI_WORKER_ID). Both
  // caps from workers.tree apply to parents that are workers themselves.
  const parent = launchParent(opts.parent);
  if (parent) assertChildAllowed(logDir, parent, config.tree);

  // An explicit --provider always bypasses capability resolution entirely;
  // otherwise --capability, or a class whose implied capability is not
  // "default" and names no provider of its own, resolves cross-provider.
  const capability = opts.providerFlag
    ? null
    : capabilityForRun(config, { capabilityFlag: opts.capabilityFlag, className: opts.className });
  const capabilityResolution: CapabilityRunResolution | null = capability
    ? resolveCapabilityRun(config, capability)
    : null;

  // Worker routing policy (policy.ts): picks local or cloud unless the caller named a provider.
  let route = opts._route;
  let providerFlag = opts.providerFlag;
  // --local: PAI resolves the running local server itself (local-provider.ts);
  // the resolved name wins over --provider — a provider literally named
  // "local" is not the mechanism.
  if (opts.localFlag) {
    const res = await resolveLocalProvider(config, logDir);
    providerFlag = res.name;
    if (!opts.quiet) process.stderr.write(`pai worker: local provider ${res.name} (${res.why})\n`);
  }
  if (!route && !providerFlag && !capability && opts.className !== "plan" && parseRunnerArgs(opts.claudeArgs).headless) {
    const routed = await routeRun(config, logDir, opts);
    if (routed) {
      route = routed.route;
      providerFlag = routed.providerFlag ?? undefined;
    }
  }

  // Budget-aware fallback: probe live budgets (5-min cache) and cooldown any
  // provider at/above its wall before the walk, so resolveTarget picks the
  // first priority provider that still has room. Probing must never block a
  // spawn: failures read as "unknown" inside the cache, never as "full".
  if (!providerFlag && !capabilityResolution && config.routing.policy !== "order") {
    try {
      await budgetCache.warm(config);
      recordBudgetCooldowns(config, logDir);
    } catch {
      /* no readings: budget routing degrades to plain order */
    }
  }

  const target = capabilityResolution
    ? {
        providerName: capabilityResolution.providerName,
        provider: capabilityResolution.provider,
        modelAlias: null,
        classMcp: null,
        via: "class" as const,
      }
    : resolveTarget(config, logDir, {
        flagProvider: providerFlag,
        className: opts.className,
        cwd: opts.cwd,
      });
  assertProviderRunnable(target.providerName, target.provider);
  if (opts.modelFast && !opts.modelFlag) target.modelAlias = "fast";

  const noBrowser = opts.browser === undefined ? config.noBrowserByDefault : !opts.browser;
  const parsed = parseRunnerArgs(noBrowser ? stripBrowserArgs(opts.claudeArgs) : opts.claudeArgs);
  // The config default is a headless-run guard; an interactive launch is the operator's own session and is
  // limited only by an explicit --max-minutes / --deadline.
  const limit = resolveLimit(opts, parsed.headless ? config.defaultMaxMinutes : 0);
  const label =
    opts.label ??
    shortText(parsed.prompt ?? UNLABELED, 70);

  let model = capabilityResolution
    ? capabilityResolution.model
    : resolveRunModel(target, opts.className, opts.modelFlag);
  if (!capabilityResolution) {
    // capability runs pin their model on purpose (an image prompt on the
    // image model); the step-down guards the class/provider resolution only
    const step = stepDownOrchestratorModel({
      resolved: model,
      providerName: target.providerName,
      provider: target.provider,
      modelFlag: opts.modelFlag,
      callerPinned: parsed.callerModel,
    });
    model = step.model;
    if (step.notice && !opts.quiet) process.stderr.write(`${step.notice}\n`);
  }
  const reportFormat = resolveReportFormat(opts.reportFormatFlag);
  // the route and why, once (also recorded in the status as routeWhy)
  const routeWhy = target.routeWhy ? `${target.providerName}/${model} (${target.routeWhy})` : undefined;
  if (routeWhy && !opts.quiet) process.stderr.write(`pai worker: route ${routeWhy}\n`);

  // tracked across every engine (including a quota reroute's recursive
  // runWorker call) so the exit hook below knows which status to check,
  // whatever opts.id/onWorkerStart the caller did or didn't pass
  let workerId: string | undefined = opts.id;
  const trackStart = (wid: string) => {
    workerId = wid;
    opts.onWorkerStart?.(wid);
  };

  try {
    let rc: number;
    if (target.provider.engine === "image") {
      rc = await executeImageRun({
        config,
        logDir,
        target,
        model,
        label,
        parsed,
        capability: capability ?? "image",
        outPath: opts.imageOut,
        size: opts.imageSize,
        timeoutMs: opts.imageTimeoutMs,
        cwd: opts.cwd,
        specPath: opts.specPath,
        parent: parent ?? undefined,
        stage: opts.stage,
        quiet: opts.quiet,
        onWorkerStart: trackStart,
        id: opts.id,
      });
    } else if (target.provider.engine === "codex") {
      rc = await executeCodexRun({
        config,
        logDir,
        target,
        model,
        label,
        parsed,
        claudeArgs: opts.claudeArgs,
        noPane: opts.noPane ?? false,
        cwd: opts.cwd,
        specPath: opts.specPath,
        parent: parent ?? undefined,
        stage: opts.stage,
        quiet: opts.quiet,
        onWorkerStart: trackStart,
        id: opts.id,
        worktreeFlag: opts.worktreeFlag,
        className: opts.className,
        reportFormat,
        capability: capability ?? undefined,
        limit,
        noBrowser,
      });
    } else {
      const execArgs: ExecuteArgs = {
        config,
        logDir,
        target,
        model,
        label,
        parsed,
        claudeArgs: opts.claudeArgs,
        noPane: opts.noPane ?? false,
        noStagger: opts.noStagger,
        noQueue: opts.noQueue,
        priority: opts.priority,
        mcpFlag: opts.mcpFlag,
        cwd: opts.cwd,
        specPath: opts.specPath,
        parent: parent ?? undefined,
        stage: opts.stage,
        quiet: opts.quiet,
        onWorkerStart: trackStart,
        id: opts.id,
        capability: capability ?? undefined,
        worktreeFlag: opts.worktreeFlag,
        resumeOf: opts.resumeOf,
        className: opts.className,
        reroutes: opts._reroutes ?? 0,
        emptyRetried: opts._emptyRetried ?? false,
        route,
        routeWhy,
        fallThroughOf: opts._fallThroughOf,
        printCmd: opts.printCmd,
        reportFormat,
        noReportRetry: opts.noReportRetry ?? false,
        orchestrate: opts.orchestrate,
        limit,
        noBrowser,
        opts,
      };
      // the session pool (workers.pool) gets first crack: an eligible task
      // runs as one more turn of a warm claude instead of a fresh spawn
      await gateStart(execArgs);
      const pooledRc = await tryPoolRun(execArgs);
      if (pooledRc !== null) {
        await returnControlsIfHeld(logDir, workerId);
        return pooledRc;
      }
      rc = await executeRun(execArgs);
    }
    await returnControlsIfHeld(logDir, workerId);
    return rc;
  } catch (e) {
    await returnControlsIfHeld(logDir, workerId);
    if (e instanceof Error && e.message.startsWith("key file")) {
      throw new Error(
        `provider "${target.providerName}": ${e.message}` +
          `\nPut the token in that file (chmod 600) or point keyFile elsewhere.`
      );
    }
    throw e;
  }
}

/**
 * The core tools a headless run grants when the caller brings none of its
 * own. Permission-gated tools (Bash, Read, Write, …) are never offered to a
 * headless session that has no allow rule for them — the child starts with
 * only the tools that never ask (tool search, web, cron, tasks) and cannot
 * touch a file or shell (2026-09-18). A caller's own --allowedTools is a
 * deliberate restriction and passes through untouched.
 */
export const DEFAULT_WORKER_TOOLS = "Read,Edit,Write,Bash,Grep,Glob";

/** The --allowedTools args a headless run needs; [] when the caller granted. */
export function headlessToolGrants(allowedTools: string[]): string[] {
  return allowedTools.length ? [] : ["--allowedTools", DEFAULT_WORKER_TOOLS];
}

/**
 * `--tools` narrows which built-in tool *schemas* claude loads into the
 * system prompt — distinct from `--allowedTools`, which narrows which of
 * those loaded tools may run without asking. A headless worker with a small
 * grant (say, just Read) still pays for every built-in schema (Bash, Web*,
 * NotebookEdit, …) it never uses: ~9k tokens per spawn (29,270 -> 20,352,
 * measured 2026-09-20). Passing --tools built from the same grant removes
 * the unused schemas.
 *
 * MCP grants (`mcp__server__tool` / `mcp__server__*`) are left out of the
 * --tools list: they are not built-in tool names, --tools does not
 * recognize them, and the MCP server's tools load through --mcp-config
 * regardless. Tested 2026-09-20: with an --allowedTools grant of
 * `Read,mcp__pai__memory_search`, passing `--tools Read` (mcp name
 * omitted) still let the worker call memory_search successfully; the tool
 * loads from the filtered MCP config, not from --tools.
 */
export function headlessToolsFlag(allowedTools: string[]): string[] {
  const names: string[] = [];
  for (const entry of allowedTools) {
    for (const raw of entry.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (raw.startsWith("mcp__")) continue; // loads via --mcp-config, not --tools
      const patterned = raw.match(/^([A-Za-z]+)\(.*\)$/); // e.g. Bash(git *) -> Bash
      const name = patterned ? patterned[1] : raw;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names.length ? ["--tools", names.join(",")] : [];
}

/**
 * A `--tools` value with no ToolSearch silently disables MCP tool deferral
 * (measured 2026-09-20: a run with `--tools "Bash,Read,Grep,Glob,Agent"` paid
 * 65,300 first-turn tokens with 5 MCP servers, 230,448 with 16, versus
 * 24,889 / 37,133 with ToolSearch present). Applied to the fully-assembled
 * argv so it catches a `--tools` from any source — the computed
 * `headlessToolsFlag`/project-pin flag, or one the caller put directly on
 * the command line.
 */
export function ensureToolSearch(cmd: string[]): string[] {
  const flagIdx = cmd.findIndex((a) => a === "--tools");
  if (flagIdx >= 0 && flagIdx + 1 < cmd.length) {
    const value = cmd[flagIdx + 1];
    if (value && !value.split(",").includes("ToolSearch")) {
      const out = [...cmd];
      out[flagIdx + 1] = `${value},ToolSearch`;
      process.stderr.write("pai: added ToolSearch to --tools (keeps MCP tool deferral on)\n");
      return out;
    }
    return cmd;
  }
  const eqIdx = cmd.findIndex((a) => a.startsWith("--tools="));
  if (eqIdx >= 0) {
    const value = cmd[eqIdx].slice("--tools=".length);
    if (value && !value.split(",").includes("ToolSearch")) {
      const out = [...cmd];
      out[eqIdx] = `--tools=${value},ToolSearch`;
      process.stderr.write("pai: added ToolSearch to --tools (keeps MCP tool deferral on)\n");
      return out;
    }
  }
  return cmd;
}

/**
 * The claude flag that turns on the browser bridge, when the run asked for it.
 *
 * The bridge is not an MCP server — it rides the Chrome native-host channel,
 * is absent from `mcpServers`, and is off in a spawned claude until `--chrome`
 * is passed. A grant such as `mcp__claude-in-chrome__tabs_context_mcp` is
 * therefore a request for that flag, not for a server to load; without this
 * the grant names a tool that never exists. `rest` is the caller's own argv:
 * a `--chrome` they passed themselves is kept rather than duplicated.
 */
export function chromeGrantArgs(wanted: string[], rest: string[] = []): string[] {
  if (rest.includes("--chrome")) return [];
  return grantsChrome(wanted) ? ["--chrome"] : [];
}

/**
 * Which MCP server names and --tools list an interactive launch (`pai
 * worker run`, no -p) uses: an explicit --mcp on this command line beats
 * the project's `pai project mcp` pin; an explicit --tools beats `pai
 * project tools`. Neither given: [] — today's "everything loads" default.
 */
export function interactiveMcpTools(
  explicitMcp: string[],
  callerTools: boolean,
  projectLaunch: Omit<ProjectLaunchConfig, "slug"> | null
): { mcpNames: string[]; tools: string[] } {
  return {
    mcpNames: explicitMcp.length ? explicitMcp : (projectLaunch?.mcp ?? []),
    tools: !callerTools && projectLaunch?.tools?.length ? projectLaunch.tools : [],
  };
}

// ---------------------------------------------------------------------------
// image engine (2i) — no process spawn: one HTTP request, one file written.
// ---------------------------------------------------------------------------

interface ImageExecuteArgs {
  logDir: string;
  target: ReturnType<typeof resolveTarget>;
  model: string;
  label: string;
  parsed: ReturnType<typeof parseRunnerArgs>;
  capability: string;
  outPath?: string;
  size?: string;
  timeoutMs?: number;
  cwd?: string;
  specPath?: string;
  parent?: string;
  stage?: string;
  quiet?: boolean;
  onWorkerStart?: (wid: string) => void;
  id?: string;
}

interface FinaliseArgs {
  logDir: string;
  ledger: string;
  status: WorkerStatus;
  /** The process's real outcome; recordWorktree sees this, never the orphan verdict. */
  ok: boolean;
  rc: number;
  secs: number;
  /** Engine-specific WORKER-END fields (provider, mode, engine, model, label, ...). */
  end: Record<string, unknown>;
  report: WorkerReport | null;
  /** Handoff text when the report has no notes. */
  fallbackText?: string;
  worktree?: WorktreeInfo | null;
  /** The deadline stopped the run after this many minutes. */
  timedOut?: number;
  /**
   * Runs after the worktree outcome is recorded, before the parent handoff
   * (print the result, quota reroute). A returned number ends the run with
   * it, skipping the handoff — the reroute's own run reports instead.
   */
  beforeHandoff?: (status: WorkerStatus, report: WorkerReport | null) => Promise<number | void> | number | void;
}

/**
 * The finalisation every engine shares: orphaned-children check, state, the
 * WORKER-END ledger line, worktree outcome, parent handoff, final rc. A worker
 * owns its children's results (the worker contract says so): if it
 * backgrounded a sub-worker and exited without waiting, the run must not
 * report success, whatever the process returned.
 */
/** Per-git-call bound for the salvage a kill signal runs before exiting. */
const SIGNAL_SALVAGE_MS = 5_000;

/** The deadline fired: record it on the status and in the ledger (the caller then stops the child). */
export function fireDeadline(logDir: string, status: WorkerStatus, ledger: string, limit: RunLimit): void {
  status.timedOut = true;
  status.last = `deadline reached after ${limit.minutes} min`;
  saveStatus(logDir, status);
  appendLedger(ledger, "WORKER-DEADLINE", { id: status.id, minutes: limit.minutes });
  // the deadline stops the run's own process; its sub-workers go with it
  void killTree(logDir, status.id, { skipRoot: true }).catch(() => undefined);
}

/** Decide why a signal ended the run and put it on the status; the caller writes WORKER-END. */
export function recordSignalEnd(logDir: string, status: WorkerStatus, signal: string): EndInfo {
  const end = decideEndReason({
    logDir,
    id: status.id,
    signal,
    timedOut: status.timedOut,
    parentPid: status.parentPid,
    parentComm: status.parentComm,
    parentBackground: status.parentBackground,
  });
  status.endReason = end.reason;
  status.endBy = end.by;
  status.endNote = end.note;
  return end;
}

export async function finaliseRun(f: FinaliseArgs): Promise<number> {
  const { logDir, ledger, ok, rc } = f;
  let { status, report } = f;
  const wid = status.id;
  // first, whatever the outcome (rc 143 included): uncommitted edits in the
  // worktree must reach the branch before anything can drop the worktree
  const salvaged = f.worktree
    ? salvageOnExit(ledger, wid, status.label || UNLABELED, f.worktree.dir)
    : [];
  if (salvaged.length) {
    const msg = `WORKER-SALVAGE: committed uncommitted edits (${salvaged.join(", ")})`;
    report = { ...(report ?? {}), notes: [report?.notes ?? f.fallbackText, msg].filter(Boolean).join("\n"), result: report?.result ?? "-" };
  }
  if (f.timedOut) {
    const reason = `deadline reached after ${f.timedOut} min`;
    status.timedOut = true;
    status.last = reason;
    // partial state = the salvage summary (r=~: stopped, not failed outright)
    report = { ...(report ?? {}), result: "~", why: reason, notes: [reason, report?.notes ?? f.fallbackText].filter(Boolean).join("\n") };
  }
  const loopStop = takeLoopStop(logDir, wid);
  if (loopStop) {
    const reason = `loop-stopped: ${loopStop.reason}`;
    status.loopStopped = true;
    status.last = shortText(reason, 90);
    report = { ...(report ?? {}), result: "-", why: reason, notes: [reason, report?.notes ?? f.fallbackText].filter(Boolean).join("\n") };
  }
  const orphanReason = checkOrphanedChildren(logDir, wid);
  const succeeded = ok && !orphanReason && !f.timedOut && !loopStop;
  status.state = succeeded ? "done" : "failed";
  status.rc = rc;
  status.secs = f.secs;
  if (orphanReason) {
    status.last = shortText(orphanReason, 90);
    report = { ...(report ?? {}), notes: orphanReason, result: "-" };
    appendLedger(ledger, "WORKER-ORPHAN-CHILDREN", { id: wid, reason: orphanReason });
  }
  const end = decideEndReason({ logDir, id: wid, timedOut: f.timedOut !== undefined, loopStopped: !!loopStop });
  status.endReason = end.reason;
  // r=~ (partial) means the work continues: saveStatus then keeps the issue claims
  status.claimsContinue = report?.result === "~";
  saveStatus(logDir, status);
  appendLedger(ledger, "WORKER-END", { id: wid, ...f.end, rc, secs: f.secs, ...endFields(end) });

  if (f.worktree) status = recordWorktree(logDir, status, f.worktree, ok);

  const early = await f.beforeHandoff?.(status, report);
  if (typeof early === "number") return early;

  const finalRc = rc !== 0 ? rc : succeeded ? 0 : 1;
  if (status.parent && isWorkerId(logDir, status.parent)) {
    try {
      await deliverHandoff(logDir, {
        from: wid,
        to: status.parent,
        kind: "result",
        text: shortText(report?.notes ?? f.fallbackText ?? (succeeded ? "done" : "failed"), 400),
        data: {
          rc: finalRc,
          ok: succeeded,
          ...(status.branch ? { branch: status.branch, commits: status.commits ?? 0 } : {}),
          ...(report ? { report } : {}),
        },
      });
    } catch {
      // the inbox line is best effort; it must never fail the exit path
    }
  }
  return finalRc;
}

async function executeImageRun(a: ImageExecuteArgs & { config: ReturnType<typeof readWorkersSection>["workers"] }): Promise<number> {
  const { logDir, target, model, label, parsed } = a;
  if (!parsed.headless || parsed.prompt === null) {
    throw new Error(
      `provider "${target.providerName}" (engine image) supports headless runs only: ` +
        `pass the task with -p '<prompt>'`
    );
  }
  const wid = a.id ?? newWorkerId();
  const cwd = a.cwd ?? process.cwd();
  const term = process.env.ITERM_SESSION_ID ?? "";
  const outPath = a.outPath ?? join(logDir, `${wid}.png`);

  const status: WorkerStatus = {
    id: wid,
    pid: process.pid,
    runPid: process.pid,
    label,
    cwd,
    term,
    provider: target.providerName,
    model,
    state: "running",
    started: nowStamp(),
    updated: nowStamp(),
    turns: 0,
    tools: 0,
    last: "generating image",
    rc: null,
    secs: null,
    origin: "spawn",
    outputFormat: parsed.outputFormat,
    reportFormat: "json",
    ...(a.parent ? { parent: a.parent, stage: a.stage } : {}),
    ...(a.specPath ? { spec: a.specPath } : {}),
  };
  saveStatus(logDir, status);
  a.onWorkerStart?.(wid);
  const ledger = ledgerPath(logDir);
  appendLedger(ledger, "WORKER-START", {
    id: wid,
    provider: target.providerName,
    mode: "headless",
    engine: "image",
    model,
    cwd,
    label,
    capability: a.capability,
    ...(a.specPath ? { spec: a.specPath } : {}),
  });

  const imageEnd = {
    provider: target.providerName,
    mode: "headless",
    engine: "image",
    model,
    label,
    capability: a.capability,
  };
  const t0 = Date.now();
  try {
    const result = await runImageCapability({
      providerName: target.providerName,
      provider: target.provider,
      model,
      prompt: parsed.prompt,
      outPath,
      size: a.size,
      timeoutMs: a.timeoutMs,
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    status.last = `wrote ${result.path}`;
    return await finaliseRun({
      logDir,
      ledger,
      status,
      ok: true,
      rc: 0,
      secs,
      end: imageEnd,
      report: null,
      beforeHandoff: () => {
        if (!a.quiet) process.stdout.write(JSON.stringify(result) + "\n");
      },
    });
  } catch (e) {
    const secs = Math.round((Date.now() - t0) / 1000);
    status.last = e instanceof Error ? e.message : String(e);
    await finaliseRun({ logDir, ledger, status, ok: false, rc: 1, secs, end: imageEnd, report: null });
    throw e;
  }
}

/**
 * The fail-closed pane gate: a headless run proceeds only behind a pane that
 * was opened and verified visible (see openVerifiedPane). Runs BEFORE the
 * worker has an id on disk, so a refusal leaves nothing in `pai worker ps`.
 *
 * Deterministic (no hidden workers): the ONLY skips are headlessAllowed() —
 * a worker's own child (PAI_WORKER=1), the operator's PAI_WORKER_ALLOW_HIDDEN=1
 * or their override file. `dryRun` (--print-cmd audits) skips too: it spawns
 * nothing. An explicit hidden request (noPane from a daemon, keepalive or an
 * in-process caller) without that consent is refused, not silently honoured —
 * a spawning session with no window (daemon) has no pane to attach to and
 * cannot run workers.
 */
export async function requireVisiblePane(
  logDir: string,
  config: ReturnType<typeof readWorkersSection>["workers"],
  wid: string,
  term: string,
  noPane: boolean,
  dryRun: boolean,
  ledger: string
): Promise<boolean> {
  if (dryRun) return false;
  const allow = headlessAllowed();
  if (allow) {
    process.stderr.write(`[pai worker] hidden run allowed for ${wid}: ${allow}\n`);
    return false;
  }
  const how = `hidden runs need the operator's ${ALLOW_HIDDEN_ENV}=1 or ${headlessOverridePath()}`;
  if (noPane) {
    appendLedger(ledger, "WORKER-REFUSED", { id: wid, reason: `headless requested, no override (${how})`.slice(0, 300) });
    throw new Error(`worker not started, no visible pane: headless requested but nothing may run hidden (${how})`);
  }
  try {
    const where = await openVerifiedPane(logDir, config, wid, term);
    process.stderr.write(`[pai worker] pane verified for ${wid}: ${where}\n`);
    return true;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    appendLedger(ledger, "WORKER-REFUSED", { id: wid, reason: `${reason} (${how})`.slice(0, 300) });
    throw new Error(`worker not started, no visible pane: ${reason} (${how})`);
  }
}

/** status.last for a claude start that died before any model event: its stderr, not a bare "starting". */
export function preEventFailure(rc: number, turns: number, stderrTail: string): string | null {
  if (rc === 0 || turns > 0 || !stderrTail.trim()) return null;
  return "failed before any model event: " + shortText(stderrTail, 150);
}

/**
 * Follow pane, made observable on stderr (stdout stays pure JSON for
 * `--output-format json`): one line naming the outcome — opened, skipped
 * (with reason), or failed (with reason, alongside the existing PANE-FAIL
 * ledger line). Fire-and-forget, never blocks the worker.
 */
export async function announcePane(
  logDir: string,
  config: ReturnType<typeof readWorkersSection>["workers"],
  wid: string,
  term: string,
  noPane: boolean,
  ledger: string,
  status?: WorkerStatus
): Promise<void> {
  const setPane = (p: NonNullable<WorkerStatus["pane"]>): void => {
    if (status) status.pane = p;
  };
  const skip = !noPane
    ? !config.pane.enabled
      ? "workers.pane.enabled is false"
      : process.env.PAI_WORKER_AUTOPANE === "0"
        ? "PAI_WORKER_AUTOPANE=0"
        : paneBackend(process.env, process.platform, term) === "none"
          ? "no tmux ($TMUX) or iTerm2 (ITERM_SESSION_ID) here"
          : null
    : "--no-pane";
  if (skip) {
    process.stderr.write(`[pai worker] no pane for ${wid}: ${skip}\n`);
    setPane({ opened: false, reason: skip });
    return;
  }
  try {
    const r = await openPaneForWorker(logDir, config, wid, term);
    const suffix = r.session ? ` (iTerm session ${r.session})` : "";
    process.stderr.write(`[pai worker] pane opened for ${wid}${suffix}\n`);
    setPane({ opened: true, ...(r.session ? { session: r.session } : {}) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pai worker] no pane for ${wid}: ${message.slice(0, 200)}\n`);
    appendLedger(ledger, "PANE-FAIL", { id: wid, error: message.slice(0, 200) });
    setPane({ opened: false, reason: message.slice(0, 200) });
  }
}

export interface ExecuteArgs {
  /** capacity + stagger gates already passed (set by gateStart) */
  gated?: boolean;
  config: ReturnType<typeof readWorkersSection>["workers"];
  logDir: string;
  target: ReturnType<typeof resolveTarget>;
  model: string;
  label: string;
  parsed: ReturnType<typeof parseRunnerArgs>;
  claudeArgs: string[];
  noPane: boolean;
  noStagger?: boolean;
  noQueue?: boolean;
  priority?: "front";
  mcpFlag?: string;
  cwd?: string;
  specPath?: string;
  parent?: string;
  stage?: string;
  quiet?: boolean;
  onWorkerStart?: (wid: string) => void;
  id?: string;
  worktreeFlag?: boolean;
  resumeOf?: string;
  className?: string;
  reroutes: number;
  emptyRetried?: boolean;
  route?: RouteInfo;
  fallThroughOf?: string;
  printCmd?: boolean;
  /** "provider/model (why)" — one line on how the provider was chosen. */
  routeWhy?: string;
  reportFormat: "json" | "ag2";
  noReportRetry?: boolean;
  /** --orchestrate: PAI_WORKER_ORCHESTRATOR=1 in the env and the orchestrator addendum in the contract. */
  orchestrate?: boolean;
  /** Capability name this run resolved through (--capability, or an implied class capability), when it did. */
  capability?: string;
  /** Time limit of the run; null = none. */
  limit: RunLimit | null;
  /** Browser tools are stripped from this run (and denied by the worker guard). */
  noBrowser: boolean;
  /** The options this run was launched with; a relaunch starts from these (see relaunchOptions). */
  opts: RunOptions;
  /** Set once the follow pane was handled (tryPoolRun); executeRun then neither opens nor verifies a second one. */
  panePrepared?: { verified: boolean };
}

/**
 * The worker session pool attempt (src/workers/pool.ts), behind
 * workers.pool.enabled: an eligible headless task is shipped to the pool
 * host and runs as the next user turn of a warm claude slot, so the
 * provider prompt cache carries over. Returns the exit code when the task
 * ran pooled; null sends the caller down the normal fresh-spawn path (host
 * unreachable, or the task needs a setup a slot cannot provide — worktree on a non-loopback provider,
 * own system prompt, MCP, another cwd, native Anthropic).
 */
export async function tryPoolRun(a: ExecuteArgs): Promise<number | null> {
  const settings = poolSettings(a.config);
  if (!settings.enabled || a.orchestrate) return null; // an orchestrator needs its own env and contract, not a warm slot
  const cwd = a.cwd ?? process.cwd();
  const reason = poolIneligibleReason({
    headless: a.parsed.headless,
    prompt: a.parsed.prompt,
    providerName: a.target.providerName,
    provider: a.target.provider,
    nativeAllowed: settings.native,
    worktreeWanted:
      a.parsed.headless && !a.printCmd && worktreeWanted(a.worktreeFlag, { cwd, allowedTools: a.parsed.allowedTools }),
    slotWorktree: isLoopbackProvider(a.target.provider),
    resumeOf: a.resumeOf,
    printCmd: a.printCmd,
    parsed: a.parsed,
    mcpFlag: a.mcpFlag,
    noBrowser: a.noBrowser,
    outputFormat: a.parsed.outputFormat,
    cwd,
  });
  if (reason) {
    appendLedger(ledgerPath(a.logDir), "WORKER-POOL-SKIP", {
      id: a.id ?? "-",
      provider: a.target.providerName,
      reason,
    });
    if (!a.quiet) process.stderr.write(`[pai worker] pool: not pooled (${reason}) — spawning fresh\n`);
    return null;
  }
  const wid = a.id ?? newWorkerId();
  // same follow pane as a fresh spawn, once per run: a decline falls back to executeRun, which reuses this
  if (!a.panePrepared) {
    const term = (await resolveHostSession()).term;
    const ledger = ledgerPath(a.logDir);
    const verified = await requireVisiblePane(a.logDir, a.config, wid, term, a.noPane, false, ledger);
    a.panePrepared = { verified };
    const status = loadStatus(a.logDir, wid);
    if (status) {
      if (verified) status.pane = { opened: true, placement: panePlacement(wid) };
      else await announcePane(a.logDir, a.config, wid, term, a.noPane, ledger, status);
      saveStatus(a.logDir, status);
    } else if (!verified) {
      await announcePane(a.logDir, a.config, wid, term, a.noPane, ledger);
    }
  }
  const limitMinutes = a.limit && a.limit.minutes > 0 ? a.limit.minutes : null;
  // the socket bounds connect+send only; the answer takes as long as the task
  const timeoutMs = limitMinutes ? limitMinutes * 2 * 60_000 + 120_000 : 7_200_000;
  let resp: PoolTaskResponse | null;
  try {
    resp = await postTaskToPool(
      settings.port,
      {
        id: wid,
        label: a.label,
        prompt: a.parsed.prompt ?? "",
        provider: a.target.providerName,
        model: a.model,
        cwd,
        className: a.className,
        capability: a.capability,
        specPath: a.specPath,
        parent: a.parent,
        stage: a.stage,
        clientPid: process.pid,
        reportFormat: a.reportFormat,
        outputFormat: a.parsed.outputFormat === "json" ? "json" : "text",
        maxMinutes: limitMinutes,
        trailer: promptTrailer(a.reportFormat),
        worktree: a.parsed.headless && !a.printCmd && worktreeWanted(a.worktreeFlag, { cwd, allowedTools: a.parsed.allowedTools }),
      },
      timeoutMs
    );
  } catch {
    resp = null;
  }
  if (resp === null) {
    process.stderr.write(`[pai worker] pool: host unreachable on port ${settings.port} — spawning fresh\n`);
    return null;
  }
  if (!resp.pooled) {
    appendLedger(ledgerPath(a.logDir), "WORKER-POOL-SKIP", {
      id: a.id ?? "-",
      provider: a.target.providerName,
      reason: resp.reason ?? "refused",
    });
    if (!a.quiet) process.stderr.write(`[pai worker] pool: not pooled (${resp.reason ?? "refused"}) — spawning fresh\n`);
    return null;
  }
  a.onWorkerStart?.(wid);
  const rc = resp.rc ?? 1;
  if (!a.quiet) {
    printResult(a.parsed.outputFormat, resp.resultEvent ?? null, rc, a.logDir, wid, resp.report);
  }
  return rc;
}

/**
 * Capacity gate, then stagger gate, for one headless run — the single place
 * both the pooled and the fresh-spawn path pass through. `status` is the
 * run's saved status; its capacity/warmup/last fields carry the queue line.
 */
async function runGates(a: ExecuteArgs, wid: string, status: WorkerStatus): Promise<void> {
  const { logDir, target, config } = a;
  const saved = status.last;
  await capacityGate({
    logDir,
    self: { id: wid, provider: target.providerName },
    cap: resolveCap(target.provider.maxConcurrent, isLocalProvider(target.provider.baseUrl)),
    config: config.capacity,
    disabled: a.noQueue,
    priority: a.priority,
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
    onWait: (w) => {
      if (w) {
        status.capacity = { provider: w.provider, cap: w.cap, total: w.total, position: w.position, elapsedSec: w.elapsedSec };
        status.last = w.line;
      } else {
        delete status.capacity;
        status.last = saved;
      }
      saveStatus(logDir, status);
    },
  });
  await staggerGate({
    logDir,
    self: { id: wid, provider: target.providerName },
    local: isLocalProvider(target.provider.baseUrl),
    config: config.stagger,
    disabled: a.noStagger,
    log: (line) => {
      if (!a.quiet) process.stderr.write(`${line}\n`);
    },
    onWait: (w) => {
      if (w) {
        status.warmup = { for: w.predecessor, provider: w.provider, elapsedSec: w.elapsedSec, limitSec: w.limitSec };
        status.last = w.line;
      } else {
        delete status.warmup;
        status.last = saved;
      }
      saveStatus(logDir, status);
    },
  });
}

/**
 * Gate a headless run once, before the pool attempt. A placeholder status
 * (running, this process's pid) is saved first, as a fresh spawn always did,
 * so the run counts as holding a slot the moment it leaves the queue; the pool
 * host or executeRun overwrites it under the same id.
 */
export async function gateStart(a: ExecuteArgs): Promise<void> {
  if (!a.parsed.headless || a.printCmd || a.gated) return;
  const wid = a.id ?? newWorkerId();
  a.id = wid;
  const status: WorkerStatus = {
    id: wid,
    pid: process.pid,
    runPid: process.pid,
    label: a.label,
    cwd: a.cwd ?? process.cwd(),
    term: "",
    provider: a.target.providerName,
    model: a.model,
    state: "running",
    started: nowStamp(),
    updated: nowStamp(),
    turns: 0,
    tools: 0,
    last: "starting",
    rc: null,
    secs: null,
    origin: "spawn",
    outputFormat: a.parsed.outputFormat,
  };
  saveStatus(a.logDir, status);
  await runGates(a, wid, status);
  a.gated = true;
}

async function executeRun(a: ExecuteArgs): Promise<number> {
  const { config, logDir, target, model, label, parsed, noPane, limit, noBrowser } = a;
  const headless = parsed.headless;

  // openai-protocol providers run through the local proxy (started on demand)
  let proxyUrl: string | undefined;
  if (target.provider.protocol === "openai") {
    const base = await ensureProxyRunning(DEFAULT_PROXY_PORT, logDir);
    proxyUrl = `${base}/${target.providerName}`;
  }
  let viaRouter: boolean | undefined;
  if (!proxyUrl && !target.provider.native && isLoopbackProvider(target.provider) && target.provider.router !== false) {
    viaRouter = routeLoopbackViaRouter(target.provider, await probeRouter());
    if (!viaRouter) process.stderr.write(`pai: router down, ${target.providerName} runs direct (no router prefix fix)\n`);
  }
  const env = buildRunEnv(target.provider, headless, proxyUrl, target.providerName, viaRouter, a.orchestrate);

  const wid = a.id ?? newWorkerId();
  // a resume takes over the old id's tree and runs against its repo
  const adopted = a.resumeOf ? adoptTree(logDir, a.resumeOf) : null;
  const cwd = adopted?.cwd ?? a.cwd ?? process.cwd();
  const term = (await resolveHostSession()).term;
  const paneVerified = a.panePrepared
    ? a.panePrepared.verified
    : headless && (await requireVisiblePane(logDir, config, wid, term, noPane, a.printCmd === true, ledgerPath(logDir)));
  const session = resolveSession(term);
  // orchestrator Bash children have no terminal identity (see scope.ts) — the
  // session map supplies the claude session they were spawned by instead
  const spawnerSession = resolveSpawnerSession(logDir, cwd);

  // One worktree per run whose tools can write (Edit/Write/Bash or no
  // restriction), in a git cwd; --worktree/--no-worktree override. A git refusal
  // degrades to an in-place run — the worker itself must still run.
  // Skipped for --print-cmd: it is a dry-run and must not touch git.
  let worktree: WorktreeInfo | null = adopted;
  if (
    !adopted &&
    headless &&
    !a.printCmd &&
    worktreeWanted(a.worktreeFlag, { cwd, allowedTools: parsed.allowedTools })
  ) {
    try {
      worktree = addWorktree(logDir, wid, cwd);
    } catch (e) {
      const why = (e as Error).message;
      process.stderr.write(`pai worker: no worktree (${why}) — running in place\n`);
      appendLedger(ledgerPath(logDir), "WORKER-NOTE", { id: wid, note: `no worktree: ${why}` });
    }
  }
  // project preamble (.pai/worker.md): headless only, oversize refuses the run
  let preamble: Preamble | null = null;
  if (headless) {
    const loaded = loadPreamble(cwd);
    if ("refused" in loaded) {
      process.stderr.write(`pai worker: preamble refused: ${loaded.refused}\n`);
      appendLedger(ledgerPath(logDir), "WORKER-NOTE", { id: wid, note: `preamble refused: ${loaded.refused}` });
      return 1;
    }
    preamble = loaded.preamble;
    if (!a.quiet) process.stderr.write(preambleLine(preamble) + "\n");
  }
  // provider contract addendum (<PAI_HOME>/contracts/<provider>.md): headless, only with the generic contract
  const addendum: ContractAddendum | null =
    headless && !parsed.callerSystemPrompt ? loadContractAddendum(target.providerName, target.provider.contract) : null;
  if (addendum && !a.quiet) process.stderr.write(`contract addendum: ${addendum.path} sha ${addendum.sha}\n`);
  // sub-workers detect themselves (and their parent) through this variable
  env.PAI_WORKER_ID = wid;
  applySessionProviderEnv(env, target);
  if (noBrowser) env.PAI_WORKER_NO_BROWSER = "1";

  const mcpFlag = noBrowser ? stripBrowserNames(a.mcpFlag ? [a.mcpFlag] : [])[0] : a.mcpFlag;
  const classMcp = noBrowser && target.classMcp ? stripBrowserNames(target.classMcp) : target.classMcp;
  if (noBrowser) parsed.mcp = stripBrowserNames(parsed.mcp);
  const chromeArgs = noBrowser
    ? []
    : chromeGrantArgs(
        [...(mcpFlag ? [mcpFlag] : []), ...parsed.mcp, ...(classMcp ?? []), ...parsed.allowedTools],
        parsed.rest
      );

  // MCP / tools: caller config > allowlist (--mcp flag / --mcp args / role /
  // mcp__ grants in --allowedTools) > project pin (interactive only, `pai
  // project mcp` / `pai project tools`) > the strict empty set (headless) /
  // everything (interactive, today's default).
  let mcpArgs: string[] = [];
  // headless without a grant or --tools of its own: load only the default core schemas
  let toolsFlag: string[] = headless ? headlessToolsFlag(parsed.allowedTools) : [];
  if (headless && !parsed.allowedTools.length && !parsed.callerTools) {
    toolsFlag = ["--tools", DEFAULT_WORKER_TOOLS];
  }
  if (headless && !parsed.callerMcpConfig) {
    const wanted = [
      ...(mcpFlag ? [mcpFlag] : []),
      ...parsed.mcp,
      ...(classMcp ?? []),
      ...mcpServersFromToolGrants(parsed.allowedTools),
    ];
    if (wanted.length) {
      const names = expandMcpNames(wanted, config); // unknown names fail fast
      mcpArgs = ["--strict-mcp-config", "--mcp-config", writeMcpConfig(logDir, wid, names)];
    } else {
      mcpArgs = ["--strict-mcp-config", "--mcp-config", ensureNoMcpConfig(logDir)];
    }
  } else if (!headless && !parsed.callerMcpConfig) {
    const explicitMcp = [...(mcpFlag ? [mcpFlag] : []), ...parsed.mcp];
    const projectLaunch = await projectLaunchConfig(cwd);
    const picked = interactiveMcpTools(explicitMcp, parsed.callerTools, projectLaunch);
    // applied pins only: an explicit --mcp / --tools overrides its pin
    const applied = projectLaunch && {
      ...projectLaunch,
      mcp: explicitMcp.length ? undefined : projectLaunch.mcp,
      tools: picked.tools.length ? projectLaunch.tools : undefined,
    };
    for (const line of pinNotices(applied)) console.error(line);
    if (picked.mcpNames.length) {
      const names = expandMcpNames(picked.mcpNames, config);
      mcpArgs = ["--strict-mcp-config", "--mcp-config", writeMcpConfig(logDir, wid, names)];
    }
    if (picked.tools.length) toolsFlag = ["--tools", picked.tools.join(",")];
  }

  // In stdin mode the prompt moves to the first user message on stdin, so it
  // must come off the command line (bare -p stays: stream-json needs --print).
  const restArgs = headless ? stripPromptValues(parsed.rest) : parsed.rest;
  const toolArgs = headless ? headlessToolGrants(parsed.allowedTools) : [];
  // A local server prefix-caches system prompt + tools, and a worktree's id,
  // path, branch and the deadline minute differ per unit: left in the system
  // prompt they cut the shared prefix before the tool definitions (measured
  // 2026-10-17: 3.1k of 38k tokens shared). They go at the head of the task
  // message instead. Anthropic and remote providers keep them in the system prompt.
  const volatileInTask = headless && !target.provider.native && isLoopbackProvider(target.provider);
  const volatileParts = volatileInTask
    ? [
        ...(worktree ? [worktreeSystemPrompt(wid, worktree.branch, worktree.dir, worktree.snapshot)] : []),
        ...(limit ? [deadlinePromptLine(limit)] : []),
      ]
    : [];
  const { text: taskText, applied: trailerApplied } = headlessPromptText(
    parsed.prompt,
    headless,
    parsed.callerSystemPrompt,
    a.reportFormat
  );
  const promptText = taskText !== null && volatileParts.length ? volatileParts.join("\n") + "\n\n" + taskText : taskText;
  const claudeCmd = claudeCommand(env, config.caveman);
  let cmd: string[] = [...claudeCmd];
  cmd.push(...modelFlagArgs(headless, model, Boolean(parsed.callerModel)));
  const slimArgs = headless ? slimProfileArgs(logDir, wid, parsed.rest, env, undefined, target.provider) : [];
  cmd.push(...chromeArgs, ...mcpArgs, ...toolArgs, ...toolsFlag, ...slimArgs, ...restArgs);
  if (headless) {
    cmd.push("--output-format", "stream-json", "--verbose", "--input-format", "stream-json");
  }
  // ONE flag: contract (unless the caller brought their own), placement, caller text
  cmd.push(
    ...appendSystemPromptArgs([
      ...(headless && !parsed.callerSystemPrompt ? [workerContractPrompt(a.className, a.reportFormat, a.orchestrate)] : []),
      ...(addendum ? [addendum.text] : []),
      ...(slimArgs.length ? [WORKER_BRIEF] : []),
      ...(preamble ? [preambleBlock(preamble)] : []),
      ...(headless
        ? [worktree ? (volatileInTask ? "" : worktreeSystemPrompt(wid, worktree.branch, worktree.dir, worktree.snapshot)) : inPlaceSystemPrompt()]
        : []),
      ...(headless && limit && !volatileInTask ? [deadlinePromptLine(limit)] : []),
      ...parsed.callerSystemPrompts,
    ])
  );
  cmd = ensureToolSearch(cmd);

  // Dry run: the argv audit, no status/ledger/pane, no spawn.
  if (a.printCmd) {
    console.log(
      JSON.stringify({
        cmd,
        cwd: worktree?.dir ?? cwd,
        ...(promptText !== null ? { stdin: promptText } : {}),
        browser: noBrowser ? "off" : "on",
        ...(a.routeWhy ? { route: a.routeWhy } : {}),
        sessionProviderEnv: env.PAI_SESSION_PROVIDER ?? null,
        ...(limit ? { deadline: new Date(limit.deadlineAt).toISOString(), maxMinutes: limit.minutes } : { limit: "none" }),
      })
    );
    return 0;
  }

  let status: WorkerStatus = {
    id: wid,
    pid: process.pid,
    runPid: process.pid,
    ...parentInfo(),
    label,
    cwd,
    term,
    provider: target.providerName,
    model,
    state: "running",
    started: nowStamp(),
    updated: nowStamp(),
    turns: 0,
    tools: 0,
    last: headless ? "starting" : "interactive",
    rc: null,
    secs: null,
    // interactive runs ARE the chat pane, not a spawned subagent of it
    origin: headless ? "spawn" : "chat",
    outputFormat: parsed.outputFormat,
    ...(a.route ? { route: a.route } : {}),
    ...(a.routeWhy ? { routeWhy: a.routeWhy } : {}),
    ...(target.via === "auto" && target.switchReason ? { switchReason: target.switchReason } : {}),
    ...(a.fallThroughOf ? { fallThroughOf: a.fallThroughOf } : {}),
    ...(headless ? { reportFormat: a.reportFormat } : {}),
    ...(trailerApplied ? { promptTrailer: true } : {}),
    ...(preamble ? { preamble: { path: preamble.path, hash: preamble.hash } } : {}),
    ...(addendum ? { contractAddendum: { path: addendum.path, sha: addendum.sha } } : {}),
    ...(session ? { session } : {}),
    ...(spawnerSession ? { spawnerSession } : {}),
    // no window seed: contextWindow comes from the init event only, and the
    // meter stays hidden until one is announced (never a guessed default)
    ...(a.parent ? { parent: a.parent, stage: a.stage } : {}),
    ...(worktree
      ? {
          worktreeDir: worktree.dir,
          branch: worktree.branch,
          worktreeBase: worktree.base,
          worktreeSnapshot: worktree.snapshot,
        }
      : {}),
    ...(adopted ? { resumedFrom: a.resumeOf } : {}),
    ...(a.specPath ? { spec: a.specPath } : {}),
    ...(limit ? { deadlineAt: limit.deadlineAt, maxMinutes: limit.minutes } : {}),
  };
  saveStatus(logDir, status);
  if (adopted && a.resumeOf) markResumed(logDir, a.resumeOf, wid);
  a.onWorkerStart?.(wid);
  const ledger = ledgerPath(logDir);
  appendLedger(ledger, "WORKER-START", {
    id: wid,
    provider: target.providerName,
    mode: headless ? "headless" : "interactive",
    model,
    cwd,
    label,
    ...(a.capability ? { capability: a.capability } : {}),
    ...(a.specPath ? { spec: a.specPath } : {}),
    ...(target.switchReason ? { switch: target.switchReason } : {}),
  });

  // Follow pane: headless only (interactive runs ARE the chat pane). Verified
  // above when the gate applies; best effort otherwise.
  if (paneVerified) status.pane = { opened: true, placement: panePlacement(wid) };
  else if (headless && !a.panePrepared) void announcePane(logDir, config, wid, term, noPane, ledger, status);

  let proc: ReturnType<typeof spawn>;
  try {
    if (headless && !a.gated) await runGates(a, wid, status);
    proc = spawn(cmd[0], cmd.slice(1), {
      env,
      cwd: worktree?.dir ?? cwd,
      stdio: headless ? ["pipe", "pipe", "pipe"] : "inherit",
    });
  } catch (e) {
    markStartFailed(logDir, status, e);
    throw e;
  }
  const t0 = Date.now();
  // claude's stderr: passed through, and the tail kept for a start that dies before any model event
  let stderrTail = "";
  proc.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(d);
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  // --- stdin lifecycle (2i): prompt in, socket forwards, close 2 s after result
  let operatorInFlight = 0;
  let closeTimer: NodeJS.Timeout | null = null;
  const armStdinClose = () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (operatorInFlight === 0) {
        try {
          proc.stdin?.end();
        } catch {
          /* already closed */
        }
      }
    }, 2_000);
  };

  let eventsFd: number | null = null;
  const writeEvent = (obj: Record<string, unknown>): void => {
    if (eventsFd === null) return;
    try {
      writeSync(eventsFd, JSON.stringify({ ...obj, _ts: isoStamp() }) + "\n");
    } catch {
      // a full disk must not take the worker transcript's process down
    }
  };

  const operatorServer = headless
    ? createOperatorServer(logDir, wid, async (text) => {
        const stdin = proc.stdin;
        if (!stdin || !stdin.writable || stdin.writableEnded) {
          return "the worker's stdin is already closed (its turn ended) — use: pai worker resume";
        }
        operatorInFlight += 1;
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = null;
        }
        // a handoff delivery's mirror carries a flag: the viewer shows the
        // inbox ◆ line instead, never both
        writeEvent({ type: "operator", text, handoff: isHandoffMessage(text) });
        return new Promise<void | string>((resolve) => {
          try {
            stdin.write(stdinUserMessage(operatorUserText(text)) + "\n", (e) =>
              resolve(e ? `write to the worker failed: ${e.message}` : undefined)
            );
          } catch (e) {
            resolve(`write to the worker failed: ${(e as Error).message}`);
          }
        });
      })
    : null;

  // A failed Edit fires no hook, so the closest-region hint rides in as a user turn (harness line, not an operator message to answer).
  const injectHarnessHint = (text: string): void => {
    const stdin = proc.stdin;
    if (!headless || !stdin || !stdin.writable || stdin.writableEnded) return;
    try {
      stdin.write(stdinUserMessage(`[harness] ${text}`) + "\n");
    } catch {
      // the hint is a courtesy
    }
  };

  let killed = false;
  const stopDeadline = limit ? armDeadline(proc, limit, () => fireDeadline(logDir, status, ledger, limit)) : null;
  const cleanup = () => {
    stopDeadline?.();
    if (closeTimer) clearTimeout(closeTimer);
    operatorServer?.close();
  };
  const onSignal = (sig: string) => {
    killed = true;
    status.state = "killed";
    status.rc = 143;
    status.secs = Math.floor((Date.now() - t0) / 1000);
    const end = recordSignalEnd(logDir, status, sig);
    status.last = `killed by signal ${sig} (${end.reason}${end.by ? ` by ${end.by}` : ""})`;
    saveStatus(logDir, status);
    appendLedger(ledger, "WORKER-END", {
      id: wid,
      provider: target.providerName,
      mode: "headless",
      model,
      rc: 143,
      secs: status.secs,
      killed: 1,
      ...endFields(end),
      note: end.note,
      label,
    });
    // a killed worktree run leaves nothing to merge — drop its worktree and
    // branch too, or every kill strands them for hand-pruning (2026-09-18)
    if (worktree) {
      salvageOnExit(ledger, wid, label, worktree.dir, SIGNAL_SALVAGE_MS);
      try {
        recordWorktree(logDir, status, worktree, false);
      } catch {
        /* best effort: the status already says killed */
      }
    }
    cleanup();
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    process.exit(143);
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGHUP", () => onSignal("SIGHUP"));

  // Holder for the last result event + its parsed report: assigned inside the
  // readline callback below, read after the await.
  const ctx: {
    resultEvent: StreamEvent | null;
    resultReport: WorkerReport | null;
  } = {
    resultEvent: null,
    resultReport: null,
  };
  // every Bash call + outcome, and the untracked files present at spawn: the
  // end-of-run proof check (checkProof) and stray-file listing read these
  const bashRuns: BashRun[] = [];
  const untrackedAtStart = new Set(headless ? untrackedPaths(worktree?.dir ?? cwd) : []);

  if (headless) {
    // the first user message carries the prompt (the -p value was stripped)
    if (promptText !== null) {
      try {
        proc.stdin!.write(stdinUserMessage(promptText) + "\n");
      } catch {
        /* child died instantly; the close handler reports it */
      }
    }
    eventsFd = openSync(eventsPath(logDir, wid), "a");
    writeEvent({ type: "preamble", text: preambleLine(preamble), ...(preamble ? { hash: preamble.hash } : {}) });
    if (addendum) writeEvent({ type: "contract-addendum", text: `${addendum.path} sha ${addendum.sha}`, sha: addendum.sha });
    const rl = createInterface({ input: proc.stdout! });
    const toolUses = new Map<string, { name: string; input: unknown }>();
    rl.on("line", (line) => {
      if (parsed.outputFormat === "stream-json") {
        process.stdout.write(line + "\n");
      }
      if (!line.startsWith("{")) return;
      let e: StreamEvent;
      try {
        e = JSON.parse(line) as StreamEvent;
      } catch {
        return;
      }
      writeEvent(e as Record<string, unknown>);
      if (e.type === "system" && e.subtype === "init") {
        if (e.session_id) status.claudeSession = e.session_id;
        adoptInitModel(status, e);
        const cw =
          initContextWindow(e) ?? target.provider.contextWindow ?? certainContextWindow(status.model);
        if (cw) status.contextWindow = cw;
        saveStatus(logDir, status);
      } else if (isCompactBoundary(e)) {
        resetContextTokensOnCompact(status, e);
        saveStatus(logDir, status);
      } else if (e.type === "assistant") {
        status.turns += 1;
        if (status.turns === 1) recordWarmup(logDir, status.provider, (Date.now() - t0) / 1000);
        bumpContextTokens(status, usageContextTokens(e.message?.usage));
        status.contextUsed = usageContextUsed(e.message?.usage) ?? status.contextUsed;
        for (const block of e.message?.content ?? []) {
          if (block.type === "tool_use") {
            status.tools += 1;
            if (block.id) toolUses.set(block.id, { name: block.name ?? "?", input: block.input });
            status.last = describeTool(block.name ?? "?", block.input);
            // a long single sleep is worth seeing while it runs (supervision's
            // "sleeping" kind) — set when issued, cleared when it completes
            if (block.name === "Bash") status.sleepSec = parseSleepSecs(bashCommand(block.input));
          } else if (block.type === "text" && (block.text ?? "").trim()) {
            status.last = "says: " + shortText(block.text, 70);
          }
        }
        saveStatus(logDir, status);
      } else if (e.type === "user") {
        // tool results arrive as user events: each one advances (or resets)
        // the consecutive-failure counter supervision's thrashing detector
        // reads, and retires a pending sleep observation. Plain user turns
        // (operator input) have no tool_result blocks and change nothing.
        const blocks = e.message?.content;
        if (Array.isArray(blocks)) {
          let sawResult = false;
          for (const block of blocks) {
            if (block.type !== "tool_result") continue;
            sawResult = true;
            status.consecFails = toolResultFailed(block) ? (status.consecFails ?? 0) + 1 : 0;
            status.sleepSec = null;
            recordDenial(status, block, toolResultText(block.content), toolUses, parsed.prompt, new Date().toISOString());
            if (block.is_error === true) {
              recordToolError(logDir, {
                worker: wid,
                provider: target.providerName,
                label,
                tool: toolUses.get(block.tool_use_id ?? "")?.name ?? "?",
                text: toolResultText(block.content),
                input: toolUses.get(block.tool_use_id ?? "")?.input,
                granted: headless ? grantedToolNames(toolsFlag.slice(1), parsed.allowedTools) : undefined,
              });
            }
            const use = block.tool_use_id ? toolUses.get(block.tool_use_id) : undefined;
            if (use?.name === "Edit" && block.is_error === true) {
              const hint = editHintFor(use.input, toolResultText(block.content), worktree?.dir ?? cwd);
              if (hint) injectHarnessHint(hint);
            }
            if (use?.name === "Bash") bashRuns.push({ command: bashCommand(use.input), failed: toolResultFailed(block), output: toolResultText(block.content).slice(-400) });
          }
          if (sawResult) saveStatus(logDir, status);
        }
      } else if (e.type === "result") {
        const tokens = usageContextTokens(e.usage);
        // a compact result legitimately restarts the context lower
        if (e.is_compact) status.contextTokens = tokens ?? status.contextTokens;
        else bumpContextTokens(status, tokens);
        const report = parseWorkerReport(e.result ?? "");
        if (report?.notes) status.last = shortText(report.notes, 90);
        else if (e.result) status.last = shortText(e.result, 90);
        saveStatus(logDir, status);
        operatorInFlight = 0;
        armStdinClose();
        ctx.resultEvent = e;
        ctx.resultReport = report;
      }
    });
  }

  const rc = await new Promise<number>((resolve, reject) => {
    proc.on("error", (e) => {
      markStartFailed(logDir, status, e);
      reject(e);
    });
    proc.on("close", (code) => resolve(code ?? (killed ? 143 : 1)));
  });
  if (eventsFd !== null) closeSync(eventsFd);
  cleanup();

  const secs = Math.floor((Date.now() - t0) / 1000);
  const resultEvent = ctx.resultEvent;
  const empty = headless && rc === 0 && resultEvent !== null && isEmptyResponse(resultEvent.result, status.tools);
  const ok = !empty && runSucceeded(headless, rc, resultEvent);
  if (resultEvent) status.last = shortText(resultEvent.result ?? "", 90);
  else if (headless) status.last = preEventFailure(rc, status.turns, stderrTail) ?? status.last;
  if (ctx.resultReport?.notes) status.last = shortText(ctx.resultReport.notes, 90);
  if (empty) {
    status.last = "harness: empty-response (model returned nothing)";
    recordToolError(logDir, {
      worker: wid,
      provider: target.providerName,
      label,
      tool: "model",
      text: "empty-response: model answered with zero usage and no tool call",
    });
  }
  if (headless && a.reportFormat === "ag2" && resultEvent?.result) {
    const v = validateAg2(resultEvent.result);
    status.reportValid = v.ok;
    status.reportErrors = v.errors;
    // one bounded re-ask, cap exactly one — see shouldRetryReport
    if (shouldRetryReport(v, a.noReportRetry ?? false, Boolean(status.claudeSession))) {
      status.reportRetried = true;
      saveStatus(logDir, status);
      appendLedger(ledger, "WORKER-REPORT-RETRY", { id: wid, reason: v.errors.join("; ") || "invalid AG2 message" });
      try {
        const reaskText = await reaskAg2Report({
          env,
          cwd: worktree?.dir ?? cwd,
          model,
          callerPinnedModel: Boolean(parsed.callerModel),
          chromeArgs,
          mcpArgs,
          toolArgs,
          toolsFlag,
          slimArgs,
          sessionId: status.claudeSession!,
          claudeCmd,
        });
        const v2 = validateAg2(reaskText);
        status.reportValid = v2.ok;
        status.reportErrors = v2.errors;
        if (v2.ok) {
          resultEvent.result = reaskText;
          ctx.resultReport = parseWorkerReport(reaskText);
          if (ctx.resultReport?.notes) status.last = shortText(ctx.resultReport.notes, 90);
        }
      } catch {
        // the re-ask is best effort; the original invalid report stands
      }
    }
  }
  if (headless && a.reportFormat === "ag2" && resultEvent?.result) {
    const stray = newUntracked(worktree?.dir ?? cwd, untrackedAtStart);
    const chk = checkProof(resultEvent.result, bashRuns, stray);
    if (chk.rewritten || stray.length) {
      resultEvent.result = chk.text;
      ctx.resultReport = parseWorkerReport(chk.text);
      if (ctx.resultReport) ctx.resultReport.untracked = stray.length ? stray : undefined;
    }
    if (chk.rewritten) {
      status.reportValid = false;
      status.last = shortText(`claimed proof not run or failed: ${chk.proof}`, 90);
      appendLedger(ledger, "REPORT-PROOF-UNVERIFIED", { id: wid, proof: chk.proof });
    }
    if (stray.length) process.stderr.write(`pai worker: warning: ${stray.length} untracked file(s) left by the worker: ${stray.join(", ")}\n`);
  }
  if (ctx.resultReport && status.denials?.length) ctx.resultReport.denials = status.denials;
  if (headless && ctx.resultReport?.changed?.length) {
    const verify = verifyReportChanges(ctx.resultReport.changed, worktree?.dir ?? cwd, t0);
    if (!verify.ok) {
      status.reportValid = false;
      const note = verifyFailNote(verify);
      status.last = shortText(note, 90);
      ctx.resultReport.notes = ctx.resultReport.notes ? `${ctx.resultReport.notes} — ${note}` : note;
      appendLedger(ledger, "REPORT-UNVERIFIED", {
        id: wid,
        failures: verify.failures.length,
        paths: verify.failures.map((f) => f.path).slice(0, 5).join(","),
      });
    }
  }
  return finaliseRun({
    logDir,
    ledger,
    status,
    ok,
    rc,
    secs,
    end: {
      provider: target.providerName,
      mode: headless ? "headless" : "interactive",
      model,
      turns: status.turns,
      tools: status.tools,
      label,
    },
    report: ctx.resultReport,
    fallbackText: resultEvent?.result,
    worktree,
    timedOut: status.timedOut ? limit?.minutes : undefined,
    beforeHandoff: async (st, rep) => {
      // Fall-through: a local run that failed its own report is repeated once on the cloud.
      const why = headless ? fallThroughReason(a.route, st, rep) : null;
      if (why && a.route) {
        appendLedger(ledger, "WORKER-FALLTHROUGH", { id: wid, reason: why });
        process.stderr.write(`pai worker: ${wid} on ${target.providerName} ended badly (${why}) — re-running on the cloud\n`);
        return runWorker({
          providerFlag: ANTHROPIC_NATIVE,
          label: `${label} (fall-through)`,
          noPane: a.noPane,
          mcpFlag: a.mcpFlag,
          cwd: a.cwd,
          specPath: a.specPath,
          parent: a.parent,
          stage: a.stage,
          claudeArgs: a.claudeArgs,
          quiet: a.quiet,
          worktreeFlag: a.worktreeFlag,
          className: a.className,
          _route: { policy: a.route.policy, reason: `fall-through (${why})`, local: false },
          _fallThroughOf: wid,
          onWorkerStart: (id2) => {
            st.fallThroughTo = id2;
            saveStatus(logDir, st);
            a.onWorkerStart?.(id2);
          },
        });
      }
      if (headless && !a.quiet) {
        printResult(parsed.outputFormat, resultEvent, rc, logDir, wid, rep, worktreeExtras(st));
      }

    // Empty response: one automatic re-launch of the same spec in the same cwd.
    if (empty && !a.emptyRetried) {
      appendLedger(ledger, "WORKER-EMPTY-RETRY", { id: wid, provider: target.providerName });
      return runWorker(
        relaunchOptions(a.opts, {
          providerFlag: target.providerName,
          onWorkerStart: a.onWorkerStart,
          _emptyRetried: true,
        })
      );
    }

    // Quota reroute: only auto-routed runs, dead before the first tool call.
    const resultText = resultEvent?.result ?? "";
    if (
      !ok &&
      headless &&
      a.target.via === "auto" &&
      config.routing.retryOnQuota &&
      status.turns <= 1 &&
      status.tools === 0 &&
      isQuotaFailure(resultText)
    ) {
      setCooldown(logDir, target.providerName, config.routing.cooldownMinutes);
      const next = nextAutoProvider(config, logDir, target.providerName);
      if (next && a.reroutes < autoOrder(config).length) {
        appendLedger(ledger, "WORKER-REROUTE", {
          from: target.providerName,
          to: next,
          reason: "quota",
        });
        return runWorker(
          relaunchOptions(a.opts, {
            providerFlag: next,
            modelFlag: undefined,
            onWorkerStart: a.onWorkerStart,
            _reroutes: a.reroutes + 1,
          })
        );
      }
    }
    },
  });
}

/**
 * Options for a relaunch (empty-response retry, quota reroute): the original
 * run's options, minus the preset id (the relaunch is a new worker), with the
 * given changes applied. Nothing is copied field by field, so a new RunOptions
 * field is carried over by default.
 */
export function relaunchOptions(orig: RunOptions, changes: Partial<RunOptions>): RunOptions {
  return { ...orig, id: undefined, ...changes };
}

/** The worktree fields printResult adds to a json payload, when there is one. */
export function worktreeExtras(s: WorkerStatus): Record<string, unknown> | undefined {
  return s.branch ? { branch: s.branch, commits: s.commits ?? 0 } : undefined;
}

export interface Ag2ReaskArgs {
  env: NodeJS.ProcessEnv;
  cwd: string;
  model: string;
  callerPinnedModel: boolean;
  chromeArgs: string[];
  mcpArgs: string[];
  toolArgs: string[];
  toolsFlag: string[];
  /** Slim-profile args of the original launch, so the resumed turn loads the same setup. */
  slimArgs?: string[];
  sessionId: string;
  timeoutMs?: number;
  /** Argv head of the original launch (claudeCommand); defaults to plain claude. */
  claudeCmd?: string[];
}

/**
 * The one bounded re-ask, cap exactly one: `claude --resume <session>` with
 * AG2_REASK_TEXT, single-shot `--output-format json` (one turn, no streaming
 * plumbing needed). Same env/model/mcp/tool flags as the original launch —
 * only --resume and the fixed re-ask prompt are new — so the resumed turn
 * sees the same grants the worker ran with.
 */
export async function reaskAg2Report(a: Ag2ReaskArgs): Promise<string> {
  let cmd: string[] = [...(a.claudeCmd ?? ["claude"])];
  cmd.push(...modelFlagArgs(true, a.model, a.callerPinnedModel));
  cmd.push(...a.chromeArgs, ...a.mcpArgs, ...a.toolArgs, ...a.toolsFlag, ...(a.slimArgs ?? []));
  cmd.push("--resume", a.sessionId, "-p", AG2_REASK_TEXT, "--output-format", "json");
  cmd = ensureToolSearch(cmd);
  const proc = spawn(cmd[0], cmd.slice(1), { env: a.env, cwd: a.cwd, stdio: ["ignore", "pipe", "inherit"] });
  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, a.timeoutMs ?? 60_000);
  let out = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  await new Promise<void>((resolve) => {
    proc.on("error", () => resolve());
    proc.on("close", () => resolve());
  });
  clearTimeout(timer);
  return resultFromOutput(out);
}

// ---------------------------------------------------------------------------
// codex engine (2d)
// ---------------------------------------------------------------------------

interface CodexArgs extends Omit<ExecuteArgs, "reroutes" | "mcpFlag" | "opts"> {}

async function executeCodexRun(a: CodexArgs): Promise<number> {
  const { config, logDir, target, model, label, parsed, noPane } = a;
  if (!parsed.headless || parsed.prompt === null) {
    throw new Error(
      `provider "${target.providerName}" (engine codex) supports headless runs only: ` +
        `pass the task with -p '<prompt>'`
    );
  }
  const env = buildCodexEnv(target.provider);
  const wid = a.id ?? newWorkerId();
  const cwd = a.cwd ?? process.cwd();
  const term = (await resolveHostSession()).term;
  const paneVerified = await requireVisiblePane(logDir, config, wid, term, noPane, false, ledgerPath(logDir));
  const session = resolveSession(term);
  const spawnerSession = resolveSpawnerSession(logDir, cwd);

  let worktree: WorktreeInfo | null = null;
  if (worktreeWanted(a.worktreeFlag, { cwd, allowedTools: parsed.allowedTools })) {
    try {
      worktree = addWorktree(logDir, wid, cwd);
    } catch (e) {
      const why = (e as Error).message;
      process.stderr.write(`pai worker: no worktree (${why}) — running in place\n`);
      appendLedger(ledgerPath(logDir), "WORKER-NOTE", { id: wid, note: `no worktree: ${why}` });
    }
  }
  env.PAI_WORKER_ID = wid;
  // codex takes instructions through the prompt, not a system prompt flag
  const prompt =
    (a.limit ? deadlinePromptLine(a.limit) + "\n\n" : "") +
    (worktree ? worktreeSystemPrompt(wid, worktree.branch, worktree.dir, worktree.snapshot) + "\n\n" : "") +
    parsed.prompt;

  let status: WorkerStatus = {
    id: wid,
    pid: process.pid,
    runPid: process.pid,
    ...parentInfo(),
    label,
    cwd,
    term,
    provider: target.providerName,
    model,
    state: "running",
    started: nowStamp(),
    updated: nowStamp(),
    turns: 0,
    tools: 0,
    last: "starting",
    rc: null,
    secs: null,
    origin: "spawn",
    outputFormat: parsed.outputFormat,
    // codex takes instructions through the prompt, not the AG2 contract flag
    reportFormat: "json",
    ...(session ? { session } : {}),
    ...(spawnerSession ? { spawnerSession } : {}),
    // codex has no init event of its own: the synthetic one below announces
    // an explicitly configured window (never a guessed default)
    ...(target.provider.contextWindow ? { contextWindow: target.provider.contextWindow } : {}),
    ...(a.parent ? { parent: a.parent, stage: a.stage } : {}),
    ...(worktree
      ? {
          worktreeDir: worktree.dir,
          branch: worktree.branch,
          worktreeBase: worktree.base,
          worktreeSnapshot: worktree.snapshot,
        }
      : {}),
    ...(a.specPath ? { spec: a.specPath } : {}),
    ...(a.limit ? { deadlineAt: a.limit.deadlineAt, maxMinutes: a.limit.minutes } : {}),
  };
  saveStatus(logDir, status);
  a.onWorkerStart?.(wid);
  const ledger = ledgerPath(logDir);
  appendLedger(ledger, "WORKER-START", {
    id: wid,
    provider: target.providerName,
    mode: "headless",
    engine: "codex",
    model,
    cwd,
    label,
    ...(a.capability ? { capability: a.capability } : {}),
  });
  const dropped = codexDroppedFlags(a.claudeArgs);
  if (dropped.length) {
    appendLedger(ledger, "WORKER-NOTE", {
      id: wid,
      note: `dropped for codex: ${dropped.join(", ")}`,
    });
  }

  if (paneVerified) status.pane = { opened: true, placement: panePlacement(wid) };
  else void announcePane(logDir, config, wid, term, noPane, ledger, status);

  const t0 = Date.now();
  const proc = spawn("codex", buildCodexArgs(prompt, parsed.callerModel ? undefined : model), {
    env,
    cwd: worktree?.dir ?? cwd,
    stdio: ["ignore", "pipe", "inherit"],
  });

  const fold = emptyCodexResult();
  const eventsFd = openSync(eventsPath(logDir, wid), "a");
  const writeEvent = (obj: Record<string, unknown>) => {
    try {
      writeSync(eventsFd, JSON.stringify({ ...obj, _ts: isoStamp() }) + "\n");
    } catch {
      // best effort transcript
    }
  };
  writeEvent({
    type: "system",
    subtype: "init",
    model,
    cwd,
    ...(target.provider.contextWindow ? { context_window: target.provider.contextWindow } : {}),
  });

  let killed = false;
  const stopDeadline = a.limit ? armDeadline(proc, a.limit, () => fireDeadline(logDir, status, ledger, a.limit!)) : null;
  process.once("SIGTERM", onCodexSignal("SIGTERM"));
  process.once("SIGINT", onCodexSignal("SIGINT"));
  process.once("SIGHUP", onCodexSignal("SIGHUP"));
  function onCodexSignal(sig: string) {
    return () => {
      killed = true;
      status.state = "killed";
      status.rc = 143;
      status.secs = Math.floor((Date.now() - t0) / 1000);
      const end = recordSignalEnd(logDir, status, sig);
      status.last = `killed by signal ${sig} (${end.reason}${end.by ? ` by ${end.by}` : ""})`;
      saveStatus(logDir, status);
      appendLedger(ledger, "WORKER-END", {
        id: wid,
        provider: target.providerName,
        mode: "headless",
        model,
        rc: 143,
        secs: status.secs,
        killed: 1,
        ...endFields(end),
        note: end.note,
        label,
      });
      // same as the claude path: a killed run's worktree and branch go now
      if (worktree) {
        salvageOnExit(ledger, wid, label, worktree.dir, SIGNAL_SALVAGE_MS);
        try {
          recordWorktree(logDir, status, worktree, false);
        } catch {
          /* best effort: the status already says killed */
        }
      }
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      process.exit(143);
    };
  }

  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line) => {
    if (parsed.outputFormat === "stream-json") process.stdout.write(line + "\n");
    const parsedLine = parseCodexLine(line);
    if (parsedLine === null) return;
    foldCodexLine(parsedLine, fold);
    if (fold.threadId && !status.claudeSession) status.claudeSession = fold.threadId;
    status.turns = fold.turns;
    status.tools = fold.tools;
    if (fold.last) status.last = shortText(fold.last, 90);
    bumpContextTokens(status, fold.contextTokens);
    saveStatus(logDir, status);
    for (const ev of fold.events.splice(0)) writeEvent(ev);
  });

  const rc = await new Promise<number>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? (killed ? 143 : 1)));
  });
  stopDeadline?.();
  closeSync(eventsFd);

  const secs = Math.floor((Date.now() - t0) / 1000);
  const finalText = fold.finalText ?? "";
  const report = parseWorkerReport(finalText);
  const resultEvent: StreamEvent = {
    type: "result",
    result: finalText,
    is_error: fold.isError || rc !== 0,
    num_turns: fold.turns,
    duration_ms: secs * 1000,
  };
  writeEvent(resultEvent);

  const ok = rc === 0 && !fold.isError;
  status.last = shortText(report?.notes ?? finalText, 90) || (ok ? "done" : "failed");
  if (report?.changed?.length) {
    const verify = verifyReportChanges(report.changed, worktree?.dir ?? cwd, t0);
    if (!verify.ok) {
      status.reportValid = false;
      const note = verifyFailNote(verify);
      status.last = shortText(note, 90);
      report.notes = report.notes ? `${report.notes} — ${note}` : note;
      appendLedger(ledger, "REPORT-UNVERIFIED", {
        id: wid,
        failures: verify.failures.length,
        paths: verify.failures.map((f) => f.path).slice(0, 5).join(","),
      });
    }
  }
  return finaliseRun({
    logDir,
    ledger,
    status,
    ok,
    rc,
    secs,
    end: {
      provider: target.providerName,
      mode: "headless",
      engine: "codex",
      model,
      turns: status.turns,
      tools: status.tools,
      label,
    },
    report,
    fallbackText: finalText,
    worktree,
    timedOut: status.timedOut ? a.limit?.minutes : undefined,
    beforeHandoff: (st, rep) => {
      if (!a.quiet) printResult(parsed.outputFormat, resultEvent, rc, logDir, wid, rep, worktreeExtras(st));
    },
  });
}

// ---------------------------------------------------------------------------
// result printing
// ---------------------------------------------------------------------------

export function printResult(
  fmt: "text" | "json" | "stream-json",
  resultEvent: StreamEvent | null,
  rc: number,
  logDir: string,
  wid: string,
  report?: WorkerReport | null,
  extras?: Record<string, unknown>
): void {
  if (fmt === "stream-json") return; // already mirrored live
  if (fmt === "json") {
    const payload = report
      ? { ...(resultEvent ?? { is_error: true, result: "no result event", rc }), report, ...extras }
      : { ...(resultEvent ?? { is_error: true, result: "no result event", rc }), ...extras };
    console.log(JSON.stringify(payload));
    return;
  }
  if (resultEvent) {
    console.log(resultEvent.result ?? "");
  } else {
    process.stderr.write(
      `pai worker: run produced no result (rc=${rc}); see ${eventsPath(logDir, wid)}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// providers test: the 90-second pong probe
// ---------------------------------------------------------------------------

export interface ProviderTestResult {
  provider: string;
  model: string;
  latencyMs: number;
  result: string;
  ok: boolean;
  /** Set when the probe could not run (e.g. "codex not installed"). */
  skipped?: string;
}

/**
 * Run a one-word pong probe through the provider (headless, no pane) and
 * report provider, model, latency and the reply. ok is false unless the reply
 * was exactly "pong" (case-insensitive, whitespace-trimmed).
 */
export async function testProvider(
  providerName: string,
  provider: WorkerProvider,
  logDir: string,
  timeoutMs = 90_000,
  caveman = false
): Promise<ProviderTestResult> {
  assertProviderRunnable(providerName, provider);
  const model = provider.models.default;

  if (provider.engine === "codex") {
    const skipped = codexInstalled() ? undefined : "codex not installed";
    return {
      provider: providerName,
      model,
      latencyMs: 0,
      result: skipped ?? "codex engine: pong probe through codex exec not implemented",
      ok: false,
      ...(skipped ? { skipped } : {}),
    };
  }

  let proxyUrl: string | undefined;
  if (provider.protocol === "openai") {
    const base = await ensureProxyRunning(DEFAULT_PROXY_PORT, logDir);
    proxyUrl = `${base}/${providerName}`;
  }
  const env = buildRunEnv(provider, true, proxyUrl, providerName);
  const [bin, ...head] = claudeCommand(env, caveman);
  const t0 = Date.now();
  const proc = spawn(
    bin,
    [
      ...head,
      "--model", model,
      "--strict-mcp-config", "--mcp-config", ensureNoMcpConfig(logDir),
      "-p", "Reply with exactly one word: pong",
      "--output-format", "json",
    ],
    { env, stdio: ["ignore", "pipe", "inherit"] }
  );
  const timer = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }, timeoutMs);

  let out = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  const rc = await new Promise<number>((resolve) => {
    proc.on("error", () => resolve(1));
    proc.on("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(timer);

  return {
    provider: providerName,
    model,
    latencyMs: Date.now() - t0,
    result: resultFromOutput(out),
    ok: rc === 0 && resultFromOutput(out).trim().toLowerCase() === "pong",
  };
}

/**
 * Pull the reply out of claude's stdout. With --verbose, `--output-format
 * json` dumps a JSON array of stream events and the reply sits in the last
 * "result" event; without it, stdout is the single result object. Accept
 * either shape, plus a bare-text fallback for error output.
 */
export function resultFromOutput(out: string): string {
  const trimmed = out.trim();
  if (!trimmed) return "";
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const fromValue = (v: unknown): string | null => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) {
        const r = fromValue(v[i]);
        if (r !== null) return r;
      }
      return null;
    }
    if (typeof v === "object" && v !== null) {
      const o = v as StreamEvent;
      if (o.type === "result" && typeof o.result === "string") return o.result;
    }
    return null;
  };
  const direct = fromValue(parse(trimmed));
  if (direct !== null) return direct;
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = fromValue(parse(lines[i]));
    if (r !== null) return r;
  }
  return trimmed.slice(0, 200);
}
