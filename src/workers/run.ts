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
import { parseRunnerArgs, shortText, stripPromptValues } from "./args.js";
import {
  assertProviderRunnable,
  classModelCapability,
  isModelCapability,
  readWorkersSection,
  resolveModelCapability,
  type WorkerProvider,
} from "./config.js";
import { buildRunEnv, claudeCommand } from "./run-env.js";

export { buildRunEnv } from "./run-env.js";
import { appendLedger } from "./ledger.js";
import {
  ensureNoMcpConfig,
  eventsPath,
  ledgerPath,
  noMcpConfigPath,
  workersLogDir,
} from "./paths.js";
import {
  type WorkerStatus,
  newWorkerId,
  saveStatus,
  describeTool,
  nowStamp,
  UNLABELED,
} from "./status.js";
import { resolveSession, resolveSpawnerSession } from "./scope.js";
import {
  capabilityForRun,
  isQuotaFailure,
  nextAutoProvider,
  resolveCapabilityRun,
  resolveTarget,
  setCooldown,
  type CapabilityRunResolution,
} from "./routing.js";
import { runImageCapability } from "./engines/image.js";
import { openPaneForWorker } from "./pane.js";
import { assertChildAllowed, isWorkerId, launchParent } from "./tree.js";
import { deliverHandoff, isHandoffMessage } from "./handoff.js";
import {
  addWorktree,
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
  type WorkerReport,
} from "./report.js";
import { validateAg2 } from "./agentish.js";
import { expandMcpNames, grantsChrome, mcpServersFromToolGrants, writeMcpConfig } from "./mcp.js";
import { projectLaunchConfig, type ProjectLaunchConfig } from "./project-config.js";
import { createOperatorServer } from "./operator.js";
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

export interface RunOptions {
  providerFlag?: string;
  /** --class value (the old --role): a task class from workers.classes. */
  className?: string;
  modelFlag?: string;
  label?: string;
  noPane?: boolean;
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
  /** --print-cmd: print the assembled claude argv as JSON and exit, no spawn. */
  printCmd?: boolean;
  /** Internal: suppress recursion depth on reroute. */
  _reroutes?: number;
  /** Internal: this run is the planner's phase-1 worker, not a new orchestration. */
  _planner?: boolean;
  /** --report json|ag2: which contract/parser the run uses (default: ag2, or PAI_WORKER_REPORT). */
  reportFormatFlag?: "json" | "ag2";
  /** --no-report-retry: skip the one bounded re-ask on an invalid AG2 final message. */
  noReportRetry?: boolean;
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

export interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
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
    content?: Array<{ type?: string; text?: string; name?: string; id?: string; input?: unknown }>;
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

/**
 * The model the init event announces, adopted into the status when the spawn
 * could not name one (a caller that passed `--model` itself in the claude
 * args, or a provider whose table has no entry for the capability). The run's
 * real model is then only knowable from the first event it sends. Never
 * overwrites an explicit model — a resolved or pinned model stays the
 * recorded truth.
 */
export function adoptInitModel(status: Pick<WorkerStatus, "model">, e: StreamEvent): void {
  if (status.model) return;
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

  const target = capabilityResolution
    ? {
        providerName: capabilityResolution.providerName,
        provider: capabilityResolution.provider,
        modelAlias: null,
        classMcp: null,
        via: "class" as const,
      }
    : resolveTarget(config, logDir, {
        flagProvider: opts.providerFlag,
        className: opts.className,
      });
  assertProviderRunnable(target.providerName, target.provider);

  const parsed = parseRunnerArgs(opts.claudeArgs);
  const label =
    opts.label ??
    shortText(parsed.prompt ?? UNLABELED, 70);

  const model = capabilityResolution
    ? capabilityResolution.model
    : resolveRunModel(target, opts.className, opts.modelFlag);
  const reportFormat = resolveReportFormat(opts.reportFormatFlag);

  try {
    if (target.provider.engine === "image") {
      return await executeImageRun({
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
        onWorkerStart: opts.onWorkerStart,
        id: opts.id,
      });
    }
    if (target.provider.engine === "codex") {
      return await executeCodexRun({
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
        onWorkerStart: opts.onWorkerStart,
        id: opts.id,
        worktreeFlag: opts.worktreeFlag,
        className: opts.className,
        reportFormat,
        capability: capability ?? undefined,
      });
    }
    return await executeRun({
      config,
      logDir,
      target,
      model,
      label,
      parsed,
      claudeArgs: opts.claudeArgs,
      noPane: opts.noPane ?? false,
      mcpFlag: opts.mcpFlag,
      cwd: opts.cwd,
      specPath: opts.specPath,
      parent: parent ?? undefined,
      stage: opts.stage,
      quiet: opts.quiet,
      onWorkerStart: opts.onWorkerStart,
      id: opts.id,
      capability: capability ?? undefined,
      worktreeFlag: opts.worktreeFlag,
      className: opts.className,
      reroutes: opts._reroutes ?? 0,
      printCmd: opts.printCmd,
      reportFormat,
      noReportRetry: opts.noReportRetry ?? false,
    });
  } catch (e) {
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
const DEFAULT_WORKER_TOOLS = "Read,Edit,Write,Bash,Grep,Glob";

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
  projectLaunch: ProjectLaunchConfig | null
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
    status.state = "done";
    status.rc = 0;
    status.secs = secs;
    status.last = `wrote ${result.path}`;
    saveStatus(logDir, status);
    appendLedger(ledger, "WORKER-END", {
      id: wid,
      provider: target.providerName,
      mode: "headless",
      engine: "image",
      model,
      rc: 0,
      secs,
      label,
      capability: a.capability,
    });
    if (!a.quiet) process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (e) {
    const secs = Math.round((Date.now() - t0) / 1000);
    const message = e instanceof Error ? e.message : String(e);
    status.state = "failed";
    status.rc = 1;
    status.secs = secs;
    status.last = message;
    saveStatus(logDir, status);
    appendLedger(ledger, "WORKER-END", {
      id: wid,
      provider: target.providerName,
      mode: "headless",
      engine: "image",
      model,
      rc: 1,
      secs,
      label,
      capability: a.capability,
    });
    throw e;
  }
}

interface ExecuteArgs {
  config: ReturnType<typeof readWorkersSection>["workers"];
  logDir: string;
  target: ReturnType<typeof resolveTarget>;
  model: string;
  label: string;
  parsed: ReturnType<typeof parseRunnerArgs>;
  claudeArgs: string[];
  noPane: boolean;
  mcpFlag?: string;
  cwd?: string;
  specPath?: string;
  parent?: string;
  stage?: string;
  quiet?: boolean;
  onWorkerStart?: (wid: string) => void;
  id?: string;
  worktreeFlag?: boolean;
  className?: string;
  reroutes: number;
  printCmd?: boolean;
  reportFormat: "json" | "ag2";
  noReportRetry?: boolean;
  /** Capability name this run resolved through (--capability, or an implied class capability), when it did. */
  capability?: string;
}

async function executeRun(a: ExecuteArgs): Promise<number> {
  const { config, logDir, target, model, label, parsed, noPane } = a;
  const headless = parsed.headless;

  // openai-protocol providers run through the local proxy (started on demand)
  let proxyUrl: string | undefined;
  if (target.provider.protocol === "openai") {
    const base = await ensureProxyRunning(DEFAULT_PROXY_PORT, logDir);
    proxyUrl = `${base}/${target.providerName}`;
  }
  const env = buildRunEnv(target.provider, headless, proxyUrl);

  const wid = a.id ?? newWorkerId();
  const cwd = a.cwd ?? process.cwd();
  const term = process.env.ITERM_SESSION_ID ?? "";
  const session = resolveSession(term);
  // orchestrator Bash children have no terminal identity (see scope.ts) — the
  // session map supplies the claude session they were spawned by instead
  const spawnerSession = resolveSpawnerSession(logDir, cwd);

  // One worktree per writing run (implement/complex/plan, a git cwd, a prompt
  // that is not read-only; --worktree/--no-worktree override). A git refusal
  // degrades to an in-place run — the worker itself must still run.
  // Skipped for --print-cmd: it is a dry-run and must not touch git.
  let worktree: WorktreeInfo | null = null;
  if (
    headless &&
    !a.printCmd &&
    worktreeWanted(a.worktreeFlag, { cwd, className: a.className, prompt: parsed.prompt })
  ) {
    try {
      worktree = addWorktree(logDir, wid, cwd);
    } catch (e) {
      const why = (e as Error).message;
      process.stderr.write(`pai worker: no worktree (${why}) — running in place\n`);
      appendLedger(ledgerPath(logDir), "WORKER-NOTE", { id: wid, note: `no worktree: ${why}` });
    }
  }
  // sub-workers detect themselves (and their parent) through this variable
  env.PAI_WORKER_ID = wid;

  const chromeArgs = chromeGrantArgs(
    [...(a.mcpFlag ? [a.mcpFlag] : []), ...parsed.mcp, ...(target.classMcp ?? []), ...parsed.allowedTools],
    parsed.rest
  );

  // MCP / tools: caller config > allowlist (--mcp flag / --mcp args / role /
  // mcp__ grants in --allowedTools) > project pin (interactive only, `pai
  // project mcp` / `pai project tools`) > the strict empty set (headless) /
  // everything (interactive, today's default).
  let mcpArgs: string[] = [];
  let toolsFlag: string[] = headless ? headlessToolsFlag(parsed.allowedTools) : [];
  if (headless && !parsed.callerMcpConfig) {
    const wanted = [
      ...(a.mcpFlag ? [a.mcpFlag] : []),
      ...parsed.mcp,
      ...(target.classMcp ?? []),
      ...mcpServersFromToolGrants(parsed.allowedTools),
    ];
    if (wanted.length) {
      const names = expandMcpNames(wanted, config); // unknown names fail fast
      mcpArgs = ["--strict-mcp-config", "--mcp-config", writeMcpConfig(logDir, wid, names)];
    } else {
      mcpArgs = ["--strict-mcp-config", "--mcp-config", ensureNoMcpConfig(logDir)];
    }
  } else if (!headless && !parsed.callerMcpConfig) {
    const explicitMcp = [...(a.mcpFlag ? [a.mcpFlag] : []), ...parsed.mcp];
    const projectLaunch = await projectLaunchConfig(cwd);
    const picked = interactiveMcpTools(explicitMcp, parsed.callerTools, projectLaunch);
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
  const { text: promptText, applied: trailerApplied } = headlessPromptText(
    parsed.prompt,
    headless,
    parsed.callerSystemPrompt,
    a.reportFormat
  );
  const claudeCmd = claudeCommand(env, config.caveman);
  let cmd: string[] = [...claudeCmd];
  cmd.push(...modelFlagArgs(headless, model, Boolean(parsed.callerModel)));
  cmd.push(...chromeArgs, ...mcpArgs, ...toolArgs, ...toolsFlag, ...restArgs);
  if (headless) {
    cmd.push("--output-format", "stream-json", "--verbose", "--input-format", "stream-json");
    if (!parsed.callerSystemPrompt) {
      cmd.push("--append-system-prompt", workerContractPrompt(a.className, a.reportFormat));
    }
    if (worktree) {
      cmd.push(
        "--append-system-prompt",
        worktreeSystemPrompt(wid, worktree.branch, worktree.dir, worktree.snapshot)
      );
    } else {
      cmd.push("--append-system-prompt", inPlaceSystemPrompt());
    }
  }
  cmd = ensureToolSearch(cmd);

  // Dry run: the argv audit, no status/ledger/pane, no spawn.
  if (a.printCmd) {
    console.log(JSON.stringify({ cmd, cwd: worktree?.dir ?? cwd }));
    return 0;
  }

  let status: WorkerStatus = {
    id: wid,
    pid: process.pid,
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
    ...(headless ? { reportFormat: a.reportFormat } : {}),
    ...(trailerApplied ? { promptTrailer: true } : {}),
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
    ...(a.specPath ? { spec: a.specPath } : {}),
  };
  saveStatus(logDir, status);
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
  });

  // Follow pane: headless only, best effort, never blocking the worker.
  if (headless && !noPane && config.pane.enabled && term && process.env.PAI_WORKER_AUTOPANE !== "0") {
    void openPaneForWorker(logDir, config, wid, term).catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      appendLedger(ledger, "PANE-FAIL", { id: wid, error: message.slice(0, 200) });
    });
  }

  const t0 = Date.now();
  const proc = spawn(cmd[0], cmd.slice(1), {
    env,
    cwd: worktree?.dir ?? cwd,
    stdio: headless ? ["pipe", "pipe", "inherit"] : "inherit",
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
    ? createOperatorServer(logDir, wid, (text) => {
        operatorInFlight += 1;
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = null;
        }
        // a handoff delivery's mirror carries a flag: the viewer shows the
        // inbox ◆ line instead, never both
        writeEvent({ type: "operator", text, handoff: isHandoffMessage(text) });
        try {
          proc.stdin?.write(stdinUserMessage(operatorUserText(text)) + "\n");
        } catch {
          /* child gone; the socket is closed by the run's cleanup */
        }
      })
    : null;

  let killed = false;
  const cleanup = () => {
    if (closeTimer) clearTimeout(closeTimer);
    operatorServer?.close();
  };
  const onSignal = (sig: string) => {
    killed = true;
    status.state = "killed";
    status.rc = 143;
    status.secs = Math.floor((Date.now() - t0) / 1000);
    status.last = `killed by signal ${sig}`;
    saveStatus(logDir, status);
    appendLedger(ledger, "WORKER-END", {
      id: wid,
      provider: target.providerName,
      mode: "headless",
      model,
      rc: 143,
      secs: status.secs,
      killed: 1,
      label,
    });
    // a killed worktree run leaves nothing to merge — drop its worktree and
    // branch too, or every kill strands them for hand-pruning (2026-09-18)
    if (worktree) {
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
  const ctx: { resultEvent: StreamEvent | null; resultReport: WorkerReport | null } = {
    resultEvent: null,
    resultReport: null,
  };

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
    const rl = createInterface({ input: proc.stdout! });
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
        const cw = initContextWindow(e);
        if (cw) status.contextWindow = cw;
        saveStatus(logDir, status);
      } else if (isCompactBoundary(e)) {
        resetContextTokensOnCompact(status, e);
        saveStatus(logDir, status);
      } else if (e.type === "assistant") {
        status.turns += 1;
        bumpContextTokens(status, usageContextTokens(e.message?.usage));
        for (const block of e.message?.content ?? []) {
          if (block.type === "tool_use") {
            status.tools += 1;
            status.last = describeTool(block.name ?? "?", block.input);
          } else if (block.type === "text" && (block.text ?? "").trim()) {
            status.last = "says: " + shortText(block.text, 70);
          }
        }
        saveStatus(logDir, status);
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
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? (killed ? 143 : 1)));
  });
  if (eventsFd !== null) closeSync(eventsFd);
  cleanup();

  const secs = Math.floor((Date.now() - t0) / 1000);
  const resultEvent = ctx.resultEvent;
  const ok = runSucceeded(headless, rc, resultEvent);
  status.state = ok ? "done" : "failed";
  status.rc = rc;
  status.secs = secs;
  if (resultEvent) status.last = shortText(resultEvent.result ?? "", 90);
  if (ctx.resultReport?.notes) status.last = shortText(ctx.resultReport.notes, 90);
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
  saveStatus(logDir, status);
  appendLedger(ledger, "WORKER-END", {
    id: wid,
    provider: target.providerName,
    mode: headless ? "headless" : "interactive",
    model,
    rc,
    secs,
    turns: status.turns,
    tools: status.tools,
    label,
  });

  // worktree outcome: keep branch + commit count on success, clean up on failure
  if (worktree) status = recordWorktree(logDir, status, worktree, ok);

  if (headless && !a.quiet) {
    printResult(parsed.outputFormat, resultEvent, rc, logDir, wid, ctx.resultReport, worktreeExtras(status));
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
    if (next && a.reroutes < config.routing.order.length) {
      appendLedger(ledger, "WORKER-REROUTE", {
        from: target.providerName,
        to: next,
        reason: "quota",
      });
      return runWorker({
        providerFlag: next,
        label,
        noPane: a.noPane,
        mcpFlag: a.mcpFlag,
        cwd: a.cwd,
        specPath: a.specPath,
        parent: a.parent,
        stage: a.stage,
        claudeArgs: a.claudeArgs,
        onWorkerStart: a.onWorkerStart,
        worktreeFlag: a.worktreeFlag,
        className: a.className,
        _reroutes: a.reroutes + 1,
      });
    }
  }

  // A finishing child reports to its worker parent automatically: the report
  // lands in the parent's inbox and (when the parent still runs) is said to
  // it so it enters the parent's conversation.
  const finalRc = rc !== 0 ? rc : ok ? 0 : 1;
  if (status.parent && isWorkerId(logDir, status.parent)) {
    try {
      await deliverHandoff(logDir, {
        from: wid,
        to: status.parent,
        kind: "result",
        text: shortText(
          ctx.resultReport?.notes ?? resultEvent?.result ?? (ok ? "done" : "failed"),
          400
        ),
        data: {
          rc: finalRc,
          ok,
          ...(status.branch ? { branch: status.branch, commits: status.commits ?? 0 } : {}),
          ...(ctx.resultReport ? { report: ctx.resultReport } : {}),
        },
      });
    } catch {
      // the inbox line is best effort; it must never fail the exit path
    }
  }

  return finalRc;
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
  cmd.push(...a.chromeArgs, ...a.mcpArgs, ...a.toolArgs, ...a.toolsFlag);
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

interface CodexArgs extends Omit<ExecuteArgs, "reroutes" | "mcpFlag"> {}

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
  const term = process.env.ITERM_SESSION_ID ?? "";
  const session = resolveSession(term);
  const spawnerSession = resolveSpawnerSession(logDir, cwd);

  let worktree: WorktreeInfo | null = null;
  if (worktreeWanted(a.worktreeFlag, { cwd, className: a.className, prompt: parsed.prompt })) {
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
    (worktree ? worktreeSystemPrompt(wid, worktree.branch, worktree.dir, worktree.snapshot) + "\n\n" : "") +
    parsed.prompt;

  let status: WorkerStatus = {
    id: wid,
    pid: process.pid,
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

  if (!noPane && config.pane.enabled && term && process.env.PAI_WORKER_AUTOPANE !== "0") {
    void openPaneForWorker(logDir, config, wid, term).catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      appendLedger(ledger, "PANE-FAIL", { id: wid, error: message.slice(0, 200) });
    });
  }

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
  process.once("SIGTERM", onCodexSignal("SIGTERM"));
  process.once("SIGINT", onCodexSignal("SIGINT"));
  process.once("SIGHUP", onCodexSignal("SIGHUP"));
  function onCodexSignal(sig: string) {
    return () => {
      killed = true;
      status.state = "killed";
      status.rc = 143;
      status.secs = Math.floor((Date.now() - t0) / 1000);
      status.last = `killed by signal ${sig}`;
      saveStatus(logDir, status);
      // same as the claude path: a killed run's worktree and branch go now
      if (worktree) {
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
  status.state = ok ? "done" : "failed";
  status.rc = rc;
  status.secs = secs;
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
  saveStatus(logDir, status);
  appendLedger(ledger, "WORKER-END", {
    id: wid,
    provider: target.providerName,
    mode: "headless",
    engine: "codex",
    model,
    rc,
    secs,
    turns: status.turns,
    tools: status.tools,
    label,
  });

  if (worktree) status = recordWorktree(logDir, status, worktree, ok);

  if (!a.quiet) printResult(parsed.outputFormat, resultEvent, rc, logDir, wid, report, worktreeExtras(status));

  // the codex engine reports to its worker parent the same way (handoff.ts)
  const finalRc = rc !== 0 ? rc : ok ? 0 : 1;
  if (status.parent && isWorkerId(logDir, status.parent)) {
    try {
      await deliverHandoff(logDir, {
        from: wid,
        to: status.parent,
        kind: "result",
        text: shortText(report?.notes ?? finalText ?? (ok ? "done" : "failed"), 400),
        data: {
          rc: finalRc,
          ok,
          ...(status.branch ? { branch: status.branch, commits: status.commits ?? 0 } : {}),
          ...(report ? { report } : {}),
        },
      });
    } catch {
      // best effort; never fail the exit path
    }
  }
  return finalRc;
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
  const env = buildRunEnv(provider, true, proxyUrl);
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
