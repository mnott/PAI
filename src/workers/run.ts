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


import {
  grantedToolNames,
  recordToolError,
  readToolErrors,
} from "./tool-errors.js";
import {
  editHintFor,
} from "./edit-assist.js";
import {
  spawn,
} from "node:child_process";
import {
  createInterface,
} from "node:readline";
import {
  join,
} from "node:path";
import {
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
} from "node:fs";
import {
  NOTE_TOKEN_ENV,
  newNoteToken,
} from "./note-delivery.js";
import {
  appendSystemPromptArgs,
  parseRunnerArgs,
  shortText,
  stripPromptValues,
} from "./args.js";
import {
  ANTHROPIC_NATIVE,
  assertProviderRunnable,
  getProviderOrNative,
  isLocalProvider,
  readWorkersSection,
  type WorkerProvider,
  type WorkersConfig,
} from "./config.js";
import {
  addSchedulingHeaders,
  buildRunEnv,
  claudeCommand,
  isLoopbackProvider,
  routeLoopbackViaRouter,
} from "./run-env.js";
import {
  httpModelsCheck,
  LOCAL_MECHANISM_LINE,
  NoLocalServerError,
  PORT_TIMEOUT_MS,
  probeLoopback,
  providerHostPort,
  resolveLocalProvider,
  type PortCheck,
} from "./local-provider.js";
import {
  probeRouter,
} from "../router/supervisor.js";
import {
  appendLedger,
} from "./ledger.js";
import {
  decideEndReason,
  endFields,
  parentInfo,
  type EndInfo,
} from "./endreason.js";
import {
  peekLoopStop,
  takeLoopStop,
} from "./loop-stop.js";
import {
  TroubleWatcher,
} from "./worker-trouble.js";
import {
  reportOriginWithHost,
  runMessenger,
} from "./run-report-wiring.js";
import {
  ensureNoMcpConfig,
  eventsPath,
  ledgerPath,
  workersLogDir,
} from "./paths.js";
import {
  slimProfileArgs,
  WORKER_BRIEF,
} from "./slim-profile.js";
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
import {
  certainContextWindow,
} from "../utils/model-window.js";
import {
  itermUuid,
  resolveSession,
  resolveSpawnerSession,
} from "./scope.js";
import {
  applySessionProviderEnv,
} from "./session-provider.js";
import {
  returnControlsIfHeld,
} from "./controls.js";
import {
  committedFallThrough,
  fallThroughReason,
  routeRun,
} from "./policy.js";
import {
  admitCap,
  capacityGate,
  queuedText,
  sessionScopeKey,
  type CapacityOpts,
} from "./capacity.js";
import {
  recordWarmup,
  staggerGate,
} from "./stagger.js";
import {
  autoOrder,
  capabilityForRun,
  isQuotaFailure,
  nextAutoProvider,
  NoProviderError,
  recordBudgetCooldowns,
  resolveCapabilityRun,
  resolveTarget,
  setCooldown,
  type CapabilityRunResolution,
} from "./routing.js";
import {
  applyRouteOverrides,
} from "./route-lists.js";
import {
  planEscalation,
} from "./escalation.js";
import {
  runEscalation,
} from "./escalate-run.js";
import {
  localFailures,
} from "./route-classifier.js";
import {
  detectSessionName,
} from "./session-name.js";
import {
  getProfile,
  isBatchEnv,
  liveResolveCtx,
  resolveWorkers,
} from "./session-profile.js";
import {
  budgetCache,
} from "./budget.js";
import {
  runImageCapability,
} from "./engines/image.js";
import {
  headlessAllowed,
  paneBackend,
  resolveHostSession,
} from "./pane.js";
import {
  launchPane,
  noTerminalReasons,
} from "./pane-launch.js";
import {
  type OwnedPane,
} from "./pane-exec.js";
import {
  type StatusLineSpec,
} from "./pane-bar.js";
import {
  paneTitle,
} from "./pane-title.js";
import {
  assertChildAllowed,
  checkOrphanedChildren,
  isWorkerId,
  launchParent,
} from "./tree.js";
import {
  deliverHandoff,
  isHandoffMessage,
} from "./handoff.js";
import {
  addWorktree,
  adoptTree,
  markResumed,
  salvageOnExit,
  archiveEmptyResult,
  commitLines,
  gcWorktreesThrottled,
  inPlaceSystemPrompt,
  recordWorktree,
  worktreeSystemPrompt,
  worktreeRefusesStart,
  worktreeWanted,
  type WorktreeInfo,
} from "./worktree.js";
import {
  AG2_REASK_TEXT,
  promptTrailer,
  noteTokenSentence,
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
import {
  parseDenialText,
  recordDenial,
} from "./denials.js";
import {
  repairAndValidateAg2,
  validateAg2,
} from "./agentish.js";
import {
  loadContractAddendum,
  type ContractAddendum,
} from "./contract-addendum.js";
import {
  taskForProvider,
} from "./local-contract.js";
import {
  loadPreamble,
  preambleBlock,
  preambleLine,
  type Preamble,
} from "./preamble.js";
import {
  killTree,
} from "./kill-tree.js";
import {
  armResultGrace,
  leftoverNote,
} from "./result-grace.js";
import {
  armDeadline,
  deadlinePromptLine,
  extendLimit,
  resolveLimit,
  type RunLimit,
} from "./deadline.js";
import {
  blockedMsOf,
} from "./active-time.js";
import {
  aibrokerMessenger,
} from "./run-events.js";
import {
  ownerOf,
} from "./local-idle.js";
import {
  stripBrowserArgs,
  stripBrowserNames,
} from "./browser-tools.js";
import {
  expandMcpNames,
  mcpServersFromToolGrants,
  writeMcpConfig,
} from "./mcp.js";
import {
  pinNotices,
  projectLaunchConfig,
} from "./project-config.js";
import {
  createOperatorServer,
} from "./operator.js";
import {
  buildsDir,
  releaseBuildsOf,
} from "../builds/queue.js";
import {
  DEFAULT_PROXY_PORT,
  ensureProxyRunning,
} from "./proxy/server.js";
import {
  buildCodexArgs,
  buildCodexEnv,
  codexDroppedFlags,
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
import {
  resultFromOutput,
} from "./run/provider-test.js";
import {
  type RunOptions,
  type StreamEvent,
  type ImageExecuteArgs,
  type FinaliseArgs,
  type ExecuteArgs,
  type Ag2ReaskArgs,
  type CodexArgs,
} from "./run/types.js";
import {
  resolveReportFormat,
  resolveRunModel,
  stepDownOrchestratorModel,
  modelFlagArgs,
  routeClassOf,
} from "./run/model.js";
import {
  stdinUserMessage,
  operatorUserText,
  isoStamp,
  usageContextUsed,
  bumpContextTokens,
  resetContextTokensOnCompact,
  isCompactBoundary,
  bashCommand,
  toolResultText,
  toolResultFailed,
  adoptInitModel,
  shouldRetryReport,
  isEmptyResponse,
  runSucceeded,
  initContextWindow,
} from "./run/stream.js";
import {
  headlessPromptText,
  placeVolatile,
  DEFAULT_WORKER_TOOLS,
  headlessToolGrants,
  headlessToolsFlag,
  ensureToolSearch,
  chromeGrantArgs,
  interactiveMcpTools,
} from "./run/argv.js";

/**
 * Run one worker. Returns the process exit code to pass through.
 * Throws WorkersConfigError-shaped Errors for configuration problems.
 */
export async function runWorker(opts: RunOptions): Promise<number> {
  const runT0 = Date.now();
  const { raw: _raw, workers: config } = readWorkersSection();
  // the session's own routing rows replace the global ones for this run (routeRun and resolveTarget read config.classes)
  const sessionName = await detectSessionName();
  const sessionRoutes = sessionName ? getProfile(sessionName)?.routes : undefined;
  if (sessionRoutes) config.tiers = applyRouteOverrides(config.tiers, sessionRoutes);
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
    const gc = gcWorktreesThrottled(logDir, 60, Date.now(), { olderThanHours: config.gcOlderThanHours, maxGb: config.worktreesMaxGb })?.filter((r) => r.archive);
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

  // A disabled provider is refused before anything else reads the config —
  // same style as the down-local refusal below (an explicit --provider
  // naming a disabled provider must never run anyway).
  if (opts.providerFlag) {
    const named = getProviderOrNative(config, opts.providerFlag);
    if (named && !named.enabled) {
      throw new LocalProviderRefusedError(
        `provider "${opts.providerFlag}" is disabled — it cannot run this worker. ` +
          `Enable it with: pai worker providers enable ${opts.providerFlag}` +
          (isLoopbackProvider(named) ? `\n${LOCAL_MECHANISM_LINE}` : "")
      );
    }
  }

  // Worker routing policy (policy.ts): picks local or cloud unless the caller named a provider.
  let route = opts._route;
  let providerFlag = opts.providerFlag;
  // The route reason names the real source: only a --provider the caller
  // actually typed says "flag: --provider"; --local says "(local)", a
  // routing-policy pin says "(routing policy: <mode>)" — like the session
  // profile case below.
  let providerWhy: string | undefined = opts.providerFlag ? "flag: --provider" : undefined;
  // --local: PAI resolves the running local server itself (local-provider.ts);
  // the resolved name wins over --provider — a provider literally named
  // "local" is not the mechanism.
  if (opts.localFlag) {
    try {
      const res = await resolveLocalProvider(config, logDir);
      providerFlag = res.name;
      providerWhy = "local";
      if (!opts.quiet) process.stderr.write(`pai worker: local provider ${res.name} (${res.why})\n`);
    } catch (e) {
      // --print-cmd is a dry run: nothing must answer a port for the argv
      // audit, so an unresolved local pin falls back to the first configured
      // loopback provider and the route line still says (local). A real run
      // keeps the hard error — nothing spawns onto a server that is down.
      if (!(opts.printCmd && e instanceof NoLocalServerError)) throw e;
      const first = Object.entries(config.providers).find(
        ([, p]) => p.enabled && isLoopbackProvider(p)
      );
      if (!first) throw e;
      providerFlag = first[0];
      providerWhy = "local";
      if (!opts.quiet) process.stderr.write(`pai worker: local provider ${first[0]} (dry run: no local server up)\n`);
    }
  }
  // The session's profile (workers, budget fallback) comes before routing; an explicit provider/--local skipped it above.
  let profileModel: string | undefined;
  if (!providerFlag && !capability && !route && (await detectSessionName())) {
    const r = resolveWorkers(
      { explicit: { model: opts.modelFlag ?? (opts.modelFast ? "fast" : opts.modelDefault ? "default" : undefined) }, batch: isBatchEnv() },
      await liveResolveCtx()
    );
    if (r.source === "none") throw new NoProviderError(r.description);
    if (r.provider && (r.source === "profile" || r.source === "fallback")) {
      providerFlag = r.provider;
      profileModel = r.model;
      providerWhy = r.source === "fallback" ? "session profile fallback" : "session profile";
      if (!opts.quiet) process.stderr.write(`pai worker: ${r.description}\n`);
    }
  }
  if (!route && !providerFlag && !capability && opts.className !== "plan" && parseRunnerArgs(opts.claudeArgs).headless) {
    const routed = await routeRun(config, logDir, { ...opts, className: routeClassOf(opts) });
    if (routed) {
      route = routed.route;
      providerFlag = routed.providerFlag ?? undefined;
      if (providerFlag) providerWhy = `routing policy: ${route.policy}`;
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
        className: routeClassOf(opts),
        cwd: opts.cwd,
      });
  assertProviderRunnable(target.providerName, target.provider);
  // A named provider that is a local (loopback) one gets the same guard
  // --local has: never wait for a server that is down, never run on a
  // disabled one. The probe is resolveLocalProvider's (httpModelsCheck,
  // short timeout); the refusal names the running local provider and the
  // fix (--local). Remote providers are untouched.
  await assertLocalProviderAlive(config, logDir, target.providerName, target.provider, opts);
  if (opts.modelFast && !opts.modelFlag) target.modelAlias = "fast";
  if (opts.modelDefault && !opts.modelFlag) target.modelAlias = "default";
  const modelFlag = opts.modelFlag ?? target.modelId ?? (profileModel && profileModel !== "fast" && profileModel !== "default" ? profileModel : undefined);
  if (profileModel === "fast" && !opts.modelFlag) target.modelAlias = "fast";
  if (profileModel === "default" && !opts.modelFlag) target.modelAlias = "default";

  const noBrowser = opts.browser === undefined ? config.noBrowserByDefault : !opts.browser;
  const parsed = parseRunnerArgs(noBrowser ? stripBrowserArgs(opts.claudeArgs) : opts.claudeArgs);
  // The config default is a headless-run guard; an interactive launch is the operator's own session and is
  // limited only by an explicit --max-minutes / --deadline.
  const limit = resolveLimit(opts, parsed.headless ? config.defaultMaxMinutes : 0);
  const label =
    opts.label ??
    shortText(parsed.prompt ?? UNLABELED, 70);
  // local contract (local-contract.ts): headless local workers only, never a cloud one
  if (parsed.headless && parsed.prompt) parsed.prompt = taskForProvider(parsed.prompt, target.provider, opts.cwd ?? process.cwd());

  let model = capabilityResolution
    ? capabilityResolution.model
    : resolveRunModel(target, opts.className, modelFlag);
  if (!capabilityResolution) {
    // capability runs pin their model on purpose (an image prompt on the
    // image model); the step-down guards the class/provider resolution only
    const step = stepDownOrchestratorModel({
      resolved: model,
      providerName: target.providerName,
      provider: target.provider,
      modelFlag,
      callerPinned: parsed.callerModel,
    });
    model = step.model;
    if (step.notice && !opts.quiet) process.stderr.write(`${step.notice}\n`);
  }
  const reportFormat = resolveReportFormat(opts.reportFormatFlag);
  // the route and why, once (also recorded in the status as routeWhy)
  const routeReason = target.via === "flag" && providerWhy ? providerWhy : target.routeWhy;
  const routeWhy = routeReason ? `${target.providerName}/${model} (${routeReason})` : undefined;
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
        escalatedFrom: opts._escalatedFrom,
        printCmd: opts.printCmd,
        reportFormat,
        noReportRetry: opts.noReportRetry ?? false,
        orchestrate: opts.orchestrate,
        limit,
        noBrowser,
        opts,
        runT0,
      };
      // the session pool (workers.pool) gets first crack: an eligible task
      // runs as one more turn of a warm claude instead of a fresh spawn
      await gateStart(execArgs);
      const pooledRc = await tryPoolRun(execArgs);
      if (pooledRc !== null) {
        await returnControlsIfHeld(logDir, workerId);
        return pooledRc;
      }
      try {
        rc = await executeRun(execArgs);
      } finally {
        releasePane(execArgs.id); // a run that never reached its command leaves no pane waiting
      }
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

/** A named local provider that is disabled or whose server does not answer. */
export class LocalProviderRefusedError extends Error {}

/**
 * A provider named for this run (--provider, a class pin, a profile, a
 * policy pin, a resume) that is loopback must be enabled and its server
 * must answer the HTTP models probe — the same probe resolveLocalProvider
 * uses. Refused immediately otherwise: never wait for a down local server,
 * never run on a disabled one. The message names the provider, what is
 * wrong with it, which local provider IS running (if any), and the fix.
 * Remote providers pass untouched; a run already resolved by --local passes
 * untouched (its server was probed by resolveLocalProvider itself).
 */
export async function assertLocalProviderAlive(
  config: WorkersConfig,
  logDir: string,
  name: string,
  p: WorkerProvider,
  opts: { localFlag?: boolean; _localCheck?: PortCheck } = {}
): Promise<void> {
  if (opts.localFlag || !isLoopbackProvider(p)) return;
  const check = opts._localCheck ?? httpModelsCheck;
  if (!p.enabled) {
    const running = Object.entries(await probeLoopback(config, check))
      .filter(([, up]) => up)
      .map(([n]) => n);
    throw new LocalProviderRefusedError(
      `provider "${name}" is a local (loopback) provider and is disabled — it cannot run this worker.` +
        (running.length ? `\nRunning local provider: ${running.join(", ")}.` : "\nNo local model server is running.") +
        `\n${LOCAL_MECHANISM_LINE}`
    );
  }
  const hp = providerHostPort(p);
  const up = hp ? await check(hp.host, hp.port, PORT_TIMEOUT_MS) : false;
  if (up) return;
  const running = Object.entries(await probeLoopback(config, check))
    .filter(([n, isUp]) => isUp && n !== name)
    .map(([n]) => n);
  throw new LocalProviderRefusedError(
    `provider "${name}" is a local (loopback) provider whose server does not answer on ${hp ? `${hp.host}:${hp.port}` : "its port"} — ` +
      `it is not running. This run is refused instead of waiting for it.` +
      (running.length ? `\nRunning local provider: ${running.join(", ")}.` : "\nNo local model server is running.") +
      `\n${LOCAL_MECHANISM_LINE}`
  );
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
  const waited = Math.round(((status.queueWaitedMs ?? 0) + blockedMsOf(logDir, status.id)) / 60_000);
  const what = limit.absolute ? `deadline reached after ${limit.minutes} min` : `deadline reached after ${limit.minutes} active min${waited ? ` (waited ${waited} min, not counted)` : ""}`;
  status.timedOut = true;
  status.last = what;
  saveStatus(logDir, status);
  appendLedger(ledger, "WORKER-DEADLINE", { id: status.id, minutes: limit.minutes, waitedMin: waited });
  // the deadline stops the run's own process; its sub-workers go with it
  void killTree(logDir, status.id, { skipRoot: true, by: "deadline", reason: `parent worker ${what}` }).catch(() => undefined);
}

/**
 * Keep the status' deadline and blockedMs in step with build-gate waits (the
 * run's deadline counts active time), so ps shows the real time left. Returns the stop function.
 */
function trackBlocked(logDir: string, status: WorkerStatus, limit: RunLimit | null): () => void {
  if (!limit) return () => undefined;
  const base = limit.deadlineAt;
  const t = setInterval(() => {
    const b = blockedMsOf(logDir, status.id);
    if (b === (status.blockedMs ?? 0)) return;
    status.blockedMs = b;
    if (!limit.absolute) status.deadlineAt = base + b;
    saveStatus(logDir, status);
  }, 15_000);
  t.unref();
  return () => clearInterval(t);
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
  if (end.killReason) status.endKillReason = end.killReason;
  if (end.forced) status.endForced = true;
  return end;
}

/**
 * A run the loop guard stopped: the status note and the report that ends it.
 * Commits on the branch make it finished work to review (r=~), none a failure
 * (r=-). Shared by the fresh finalise and the pool host's per-task ending.
 */
export function applyLoopStop(
  status: WorkerStatus,
  loopStop: { reason: string },
  report: WorkerReport | null,
  fallbackText: string | undefined,
  worktree: { dir: string; base: string } | null | undefined
): WorkerReport {
  const reason = `loop-stopped: ${loopStop.reason}`;
  status.loopStopped = true;
  status.last = shortText(reason, 90);
  // a loop after committing is finished work to review, not a failure
  const commits = worktree ? commitLines(worktree.dir, worktree.base) : [];
  if (commits.length) {
    const why = `loop-stopped after committing: ${loopStop.reason}`;
    const list = `commits: ${commits.join("; ")}`;
    return { ...(report ?? {}), result: "~", why, notes: [why, list, report?.notes ?? fallbackText].filter(Boolean).join("\n") };
  }
  return { ...(report ?? {}), result: "-", why: reason, notes: [reason, report?.notes ?? fallbackText].filter(Boolean).join("\n") };
}

/**
 * Escalation one tier up (escalation.ts) for a run that just ended: context over the
 * configured fraction, a missing tool, or repeated failure. Resolves to the exit code
 * of the re-run (t2 -> t1, whose spec starts with the salvage merge of the ended
 * run's branch), or null when the run stays (no tiers configured, no trigger, kept
 * for review, already escalated out of this tier); a t1 -> t0 escalation messages the
 * owning session (never PAILot) and turns the report into r=~ "escalated to session"
 * in place.
 */
export async function tryEscalate(
  a: ExecuteArgs,
  wid: string,
  st: WorkerStatus,
  report: WorkerReport | null,
  resultText: string | undefined,
  commits: string[],
  failureWhy: string | null,
  keptForReview = false
): Promise<number | null> {
  const { logDir, config } = a;
  if (!a.parsed.headless || !config.tiers?.length) return null;
  const label = a.label ?? st.label ?? UNLABELED;
  const failed = st.state === "failed" || !!failureWhy;
  const plan = planEscalation({
    tiers: config.tiers,
    cfg: config.escalate,
    className: a.className,
    state: { from: a.escalatedFrom ?? [] },
    id: wid,
    label,
    done: report?.notes ?? resultText,
    commits,
    branch: st.branch ?? undefined,
    contextTokens: st.contextTokens,
    contextWindow: st.contextWindow,
    resultText,
    reportText: [report?.notes, report?.why].filter(Boolean).join("\n"),
    toolErrors: readToolErrors(logDir).filter((r) => r.worker === wid).map((r) => r.raw),
    failures: failed ? localFailures(ledgerPath(logDir), label, (p) => { const c = getProviderOrNative(config, p); return !!c && isLoopbackProvider(c); }) + (st.rc === 0 ? 1 : 0) : 0,
    loopStopped: st.loopStopped,
    reportValid: st.reportValid,
    failureWhy: failureWhy ?? undefined,
    keptForReview,
  });
  if (!plan) return null;
  const out = await runEscalation(plan, a.escalatedFrom ?? [], {
    ledger: ledgerPath(logDir),
    id: wid,
    label,
    spec: a.parsed.prompt ?? "",
    fromModel: st.model,
    markEscalated: (line) => {
      st.escalated = line;
      st.last = line;
      saveStatus(logDir, st);
    },
    rerun: (o) => {
      const p0 = parseRunnerArgs(a.opts.claudeArgs).prompt;
      let swapped = false;
      return (a.runner ?? runWorker)({
        ...relaunchOptions(a.opts, {}),
        providerFlag: o.providerFlag,
        modelFlag: o.modelFlag,
        label: o.label,
        claudeArgs: a.opts.claudeArgs.map((x) => (!swapped && x === p0 ? ((swapped = true), o.prompt) : x)),
        _escalatedFrom: o.escalatedFrom,
        _route: undefined,
        onWorkerStart: (id2) => {
          st.escalatedTo = id2;
          saveStatus(logDir, st);
          o.onStarted(id2);
          a.onWorkerStart?.(id2);
        },
      });
    },
    notifySession: async (text) => {
      const target = st.session?.id || st.session?.name || st.sessionKey;
      if (!target) return;
      const { sendToSession } = await import("../cli/lib/aibroker-client.js");
      await sendToSession(target, text, undefined, { noReply: true });
    },
  });
  if (out.kind === "rerun") return out.rc;
  if (report) Object.assign(report, out.report);
  st.claimsContinue = true;
  saveStatus(logDir, st);
  return null;
}

/** Re-run a failed local run once on the cloud, as a fresh run (never another pool spare of the local key). */
function rerunOnCloud(a: ExecuteArgs, wid: string, why: string, st: WorkerStatus): Promise<number> {
  const { logDir } = a;
  appendLedger(ledgerPath(logDir), "WORKER-FALLTHROUGH", { id: wid, reason: why });
  process.stderr.write(`pai worker: ${wid} on ${a.target.providerName} ended badly (${why}) — re-running on the cloud\n`);
  return (a.runner ?? runWorker)({
    providerFlag: ANTHROPIC_NATIVE,
    label: `${a.label} (fall-through)`,
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
    _route: { policy: a.route!.policy, reason: `fall-through (${why})`, local: false },
    _fallThroughOf: wid,
    onWorkerStart: (id2) => {
      st.fallThroughTo = id2;
      saveStatus(logDir, st);
      a.onWorkerStart?.(id2);
    },
  });
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
    const reason = status.last.startsWith("deadline reached") ? status.last : `deadline reached after ${f.timedOut} min`;
    status.timedOut = true;
    status.last = reason;
    // partial state = the salvage summary (r=~: stopped, not failed outright)
    report = { ...(report ?? {}), result: "~", why: reason, notes: [reason, report?.notes ?? f.fallbackText].filter(Boolean).join("\n") };
  }
  const loopStop = takeLoopStop(logDir, wid);
  if (loopStop) report = applyLoopStop(status, loopStop, report, f.fallbackText, f.worktree);
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

  const reviewed = f.worktree ? committedFallThrough(f.fallThroughWhy?.(status, report) ?? null, commitLines(f.worktree.dir, f.worktree.base)) : null;
  if (reviewed) {
    process.stderr.write(`pai worker: ${wid} ended badly but committed — kept for review, no cloud re-run\n`);
    appendLedger(ledger, "WORKER-FALLTHROUGH-REVIEW", { id: wid, reason: reviewed.why });
    report = { ...(report ?? {}), ...reviewed };
    status.claimsContinue = true;
    saveStatus(logDir, status);
    f.onReviewed?.();
  }
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
  // nothing to merge: the worktree goes now instead of piling up until gc
  if (f.worktree && status.worktreeDir) archiveEmptyResult(logDir, status);
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

/** The panes opened FIRST for the runs of this process, per worker id, until the run's command starts in them. */
const paneHandles = new Map<string, OwnedPane>();

/** The run will not start its command (it ended or fell through first): its pane closes. */
export function releasePane(wid: string | undefined): void {
  if (!wid) return;
  paneHandles.get(wid)?.cancel();
  paneHandles.delete(wid);
}

/**
 * Open the worker's pane FIRST: the pane's command is `pai pane exec <id>`, which will own the claude process
 * (see pane-exec.ts). Resolves true when the pane exists and waits for the command (spawnOwned starts it in
 * there). false, with no failure: no terminal at all (recorded "no terminal"), `dryRun` (--print-cmd), an
 * explicit noPane, the operator's override, or workers.pane.enabled false; the command then runs directly.
 * A pane that cannot be opened for any other reason rejects: the command does not run unseen.
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
  if (dryRun || noPane) return false; // config and PAI_WORKER_AUTOPANE no longer skip a pane: the pane rule has no switch
  const allow = headlessAllowed();
  if (allow) {
    process.stderr.write(`[pai worker] hidden run allowed for ${wid}: ${allow}\n`);
    return false;
  }
  if (paneHandles.has(wid)) return true;
  try {
    const pane = await launchPane({ logDir, config, id: wid, kind: "worker", term });
    if (!pane) return false;
    paneHandles.set(wid, pane);
    process.stderr.write(`[pai worker] pane opened for ${wid}: ${pane.where}\n`);
    return true;
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    appendLedger(ledger, "WORKER-NO-PANE", { id: wid, reason });
    process.stderr.write(`[pai worker] ${wid} not started: its pane could not be opened: ${reason}\n`);
    throw new Error(`pane could not be opened: ${reason}`);
  }
}

/**
 * Start a run's command: inside the pane opened for it (the wrapper's child, output rendered there), or
 * directly when no pane owns this run (no terminal, interactive, override).
 */
export async function spawnOwned(
  wid: string,
  cmd: string[],
  o: { env: NodeJS.ProcessEnv; cwd: string; stdio: ["pipe" | "ignore", "pipe", "pipe" | "inherit"] | "inherit"; render?: "plain" | "stream"; title: string; statusLine?: StatusLineSpec }
): Promise<ReturnType<typeof spawn>> {
  const pane = paneHandles.get(wid);
  if (!pane || o.stdio === "inherit") return spawn(cmd[0], cmd.slice(1), { env: o.env, cwd: o.cwd, stdio: o.stdio });
  paneHandles.delete(wid);
  const proc = (await pane.start({ argv: cmd, cwd: o.cwd, env: o.env as Record<string, string | undefined>, stdin: o.stdio[0] === "pipe" ? "pipe" : "ignore", render: o.render ?? "plain", title: o.title, ...(o.statusLine ? { statusLine: o.statusLine } : {}) })).asChild();
  if (o.stdio[2] === "inherit") proc.stderr?.pipe(process.stderr);
  return proc;
}

/** status.last for a claude start that died before any model event: its stderr, not a bare "starting". */
export function preEventFailure(rc: number, turns: number, stderrTail: string): string | null {
  if (rc === 0 || turns > 0 || !stderrTail.trim()) return null;
  return "failed before any model event: " + shortText(stderrTail, 150);
}

/**
 * Records, in the status, why a run has no pane of its own (stdout stays pure JSON for `--output-format
 * json`): no terminal, --no-pane, config, the operator's override. A run with a pane is marked exec. Never
 * opens a pane: panes are opened by requireVisiblePane, before the command starts.
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
  void logDir;
  void term;
  if (paneHandles.has(wid)) {
    setPane({ opened: true, exec: true });
    return;
  }
  const why = noTerminalReasons.get(wid) ?? (noPane ? "--no-pane" : headlessAllowed() ?? "no pane owns this run");
  process.stderr.write(`[pai worker] no pane for ${wid}: ${why}\n`);
  setPane({ opened: false, reason: why });
  void ledger;
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
  // spares are the pool's default use; the multi-task continuation path only runs behind workers.pool.continuation
  const claim = !settings.continuation;
  if (claim && settings.spares <= 0) return null;
  const reason = poolIneligibleReason({
    headless: a.parsed.headless,
    prompt: a.parsed.prompt,
    providerName: a.target.providerName,
    provider: a.target.provider,
    nativeAllowed: settings.native,
    worktreeWanted:
      a.parsed.headless && !a.printCmd && worktreeWanted(a.worktreeFlag, { cwd, allowedTools: a.parsed.allowedTools }),
    slotWorktree: claim || isLoopbackProvider(a.target.provider),
    resumeOf: a.resumeOf,
    printCmd: a.printCmd,
    parsed: a.parsed,
    mcpFlag: a.mcpFlag,
    noBrowser: a.noBrowser,
    outputFormat: a.parsed.outputFormat,
    cwd,
  });
  if (reason) {
    if (claim) a.spareMiss = reason;
    appendLedger(ledgerPath(a.logDir), "WORKER-POOL-SKIP", {
      id: a.id ?? "-",
      provider: a.target.providerName,
      reason,
    });
    if (!a.quiet) process.stderr.write(`[pai worker] pool: not pooled (${reason}) — spawning fresh\n`);
    return null;
  }
  // the pane rule wins over the pool: a claimed spare would run outside a pane that owns it, so with a terminal
  // the run spawns fresh through its pane
  if (!a.noPane && !headlessAllowed() && paneBackend(process.env, process.platform, (await resolveHostSession()).term) !== "none") {
    if (claim) a.spareMiss = "pane rule: a pane owns every run";
    appendLedger(ledgerPath(a.logDir), "WORKER-POOL-SKIP", { id: a.id ?? "-", provider: a.target.providerName, reason: "pane rule: a pane owns every run" });
    return null;
  }
  const wid = a.id ?? newWorkerId();
  // same follow pane as a fresh spawn, once per run: a decline falls back to executeRun, which reuses this.
  // A spare claim starts the task first and opens the pane alongside it: the pane never delays the task.
  const preparePane = async (): Promise<void> => {
    if (a.paneOpening) return a.paneOpening; // gateStart already started it, beside admission
    if (a.panePrepared) return;
    const paneT0 = Date.now();
    const term = (await resolveHostSession()).term;
    const ledger = ledgerPath(a.logDir);
    const verified = await requireVisiblePane(a.logDir, a.config, wid, term, a.noPane, false, ledger);
    a.panePrepared = { verified };
    a.setupPaneMs = Date.now() - paneT0;
    const status = loadStatus(a.logDir, wid);
    if (status) {
      if (verified) status.pane = { opened: true, exec: true };
      else await announcePane(a.logDir, a.config, wid, term, a.noPane, ledger, status);
      saveStatus(a.logDir, status);
    } else if (!verified) {
      await announcePane(a.logDir, a.config, wid, term, a.noPane, ledger);
    }
  };
  const panePending = preparePane(); // beside the claim / first turn: the pane never delays the task
  const limitMinutes = a.limit && a.limit.minutes > 0 ? a.limit.minutes : null;
  // the socket bounds connect+send only; the answer takes as long as the task
  const timeoutMs = limitMinutes ? limitMinutes * 2 * 60_000 + 120_000 : 7_200_000;
  let resp: PoolTaskResponse | null;
  const postT0 = Date.now();
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
        ...(claim ? { runStartedAt: a.runT0 ?? Date.now() } : {}),
        ...(a.admissionMs !== undefined ? { admissionMs: a.admissionMs } : {}),
      },
      timeoutMs,
      claim ? "/claim" : "/task"
    );
  } catch {
    resp = null;
  }
  const postMs = Date.now() - postT0;
  await panePending; // a miss falls back to executeRun, which reuses the prepared pane
  if (resp === null) {
    a.spareMiss = "host-unreachable";
    process.stderr.write(`[pai worker] pool: host unreachable on port ${settings.port} — spawning fresh\n`);
    return null;
  }
  if (!resp.pooled) {
    a.spareMiss = resp.reason ?? "refused";
    // a claim miss is already on the ledger as WORKER-POOL-MISS (host side)
    if (!claim) {
      appendLedger(ledgerPath(a.logDir), "WORKER-POOL-SKIP", {
        id: a.id ?? "-",
        provider: a.target.providerName,
        reason: resp.reason ?? "refused",
      });
    }
    if (!a.quiet) process.stderr.write(`[pai worker] pool: not pooled (${resp.reason ?? "refused"}) — spawning fresh\n`);
    return null;
  }
  a.onWorkerStart?.(wid);
  if (claim && a.setupPaneMs !== undefined) {
    // the pane finishes beside the claim, so the host cannot know it: the client adds the pane share of the setup
    appendLedger(ledgerPath(a.logDir), "WORKER-SETUP", { id: wid, setupPaneMs: a.setupPaneMs, admissionMs: a.admissionMs, claimMs: postMs });
  }
  const rc = resp.rc ?? 1;
  let report = resp.report ?? null;
  // the ending a fresh run has: a failed local run is kept for review when it committed, else re-run once on the cloud
  const st = resp.status ?? loadStatus(a.logDir, wid);
  if (st && a.parsed.headless) {
    const why = fallThroughReason(a.route, st, report);
    const commits =
      st.worktreeDir && st.worktreeBase
        ? commitLines(st.worktreeDir, st.worktreeBase)
        : st.branch && st.commits ? [`${st.commits} commit(s) on ${st.branch}`] : [];
    // kept for review (it committed) stays: no cloud re-run, no escalation
    const reviewed = committedFallThrough(why, commits);
    const escalated = await tryEscalate(a, wid, st, report, resp.resultEvent?.result, commits, why ?? (st.loopStopped ? "loop-guard stop" : null), !!reviewed);
    if (escalated !== null) return escalated;
    if (reviewed) {
      process.stderr.write(`pai worker: ${wid} ended badly but committed — kept for review, no cloud re-run\n`);
      appendLedger(ledgerPath(a.logDir), "WORKER-FALLTHROUGH-REVIEW", { id: wid, reason: reviewed.why });
      report = { ...(report ?? {}), ...reviewed };
      st.claimsContinue = true;
      saveStatus(a.logDir, st);
    } else if (why && a.route && !st.escalated) {
      return rerunOnCloud(a, wid, why, st);
    }
  }
  if (!a.quiet) {
    printResult(a.parsed.outputFormat, resp.resultEvent ?? null, rc, a.logDir, wid, report);
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
  const gate: CapacityOpts = {
    logDir,
    self: { id: wid, provider: target.providerName },
    cap: admitCap(target.provider.maxConcurrent, target.provider.conversationSlots, isLocalProvider(target.provider.baseUrl)),
    config: config.capacity,
    disabled: a.noQueue,
    priority: a.priority,
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
    alarmMs: (config.waitAlarmMinutes ?? 120) * 60_000,
    onAlarm: (w) => {
      const text = `[pai worker] ${wid} (${status.label}) has waited ${Math.round(w.elapsedSec / 60)} min for a ${w.provider} slot (position ${w.position} of ${w.queued}). It keeps waiting; kill it or reorder with \`pai worker queue\`.`;
      process.stderr.write(`${text}\n`);
      void aibrokerMessenger(logDir).toSession(ownerOf(status), text).catch(() => false);
    },
    onWait: (w) => {
      if (w) {
        // parked at the cap: visible as "queued", never as a slot holder
        status.state = "queued";
        status.capacity = {
          provider: w.provider,
          cap: w.cap,
          total: w.total,
          position: w.position,
          elapsedSec: w.elapsedSec,
          queued: w.queued,
          ...(w.behind ? { behind: w.behind } : {}),
          sinceMs: w.sinceMs,
        };
        status.last = queuedText(w);
      } else {
        // slot granted: back to running, and `started` now counts from the grant
        // (spawnTimeOf documents the rewrite; wait-on's ceiling and ps ages use it)
        status.state = "running";
        status.started = nowStamp();
        delete status.capacity;
        status.last = saved;
      }
      saveStatus(logDir, status);
    },
  };
  // the session's own limit ("one after the other"): same gate, counted per session across providers
  const max = status.sessionKey ? getProfile(status.sessionKey)?.max_parallel : undefined;
  if (status.sessionKey && max) {
    const key = status.sessionKey;
    await capacityGate({ ...gate, scope: { key: sessionScopeKey(key), label: `session ${key}`, holds: (s) => s.sessionKey === key }, cap: max });
  }
  await capacityGate(gate);
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
  const sessionKey = await detectSessionName();
  // the owning session: what the local scheduler shares slots by
  const spawner = resolveSpawnerSession(a.logDir, a.cwd ?? process.cwd());
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
    ...(sessionKey ? { sessionKey } : {}),
    ...(spawner ? { spawnerSession: spawner } : {}),
  };
  saveStatus(a.logDir, status);
  // the follow pane opens now, not after the queue (a run parked at a cap shows
  // its place in line there, runGates onWait) — and beside admission and the
  // claim, never in front of them: whoever needs the pane settled awaits paneOpening
  const ledger = ledgerPath(a.logDir);
  const paneT0 = Date.now();
  a.paneOpening = (async () => {
    const term = (await resolveHostSession()).term;
    const hostSession = resolveSession(term);
    if (hostSession) {
      status.session = hostSession;
      saveStatus(a.logDir, status);
    }
    const verified = await requireVisiblePane(a.logDir, a.config, wid, term, a.noPane, false, ledger);
    a.panePrepared = { verified };
    a.setupPaneMs = Date.now() - paneT0;
    if (verified) status.pane = { opened: true, exec: true };
    else await announcePane(a.logDir, a.config, wid, term, a.noPane, ledger, status);
    saveStatus(a.logDir, status);
  })().catch((e) => {
    a.paneError = e instanceof Error ? e : new Error(String(e));
    markStartFailed(a.logDir, status, a.paneError);
  });
  const gateT0 = Date.now();
  await runGates(a, wid, status);
  a.admissionMs = Date.now() - gateT0;
  // waiting for a slot is not work: the limit counts from the grant (active time)
  const queued = Date.now() - gateT0;
  if (a.limit && queued >= 1000) {
    a.limit = extendLimit(a.limit, queued);
    a.queueWaitedMs = queued;
  }
  // a gate that never had to wait leaves the placeholder "running" with the
  // spawn stamp; one that queued already flipped back to "running" with the
  // grant stamp (runGates onWait)
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
  await a.paneOpening;
  if (a.paneError) throw a.paneError;
  const paneVerified = a.panePrepared
    ? a.panePrepared.verified
    : headless && (await requireVisiblePane(logDir, config, wid, term, noPane, a.printCmd === true, ledgerPath(logDir)));
  a.spawnT0 = Date.now();
  const session = resolveSession(term);
  const sessionKey = await detectSessionName();
  // orchestrator Bash children have no terminal identity (see scope.ts) — the
  // session map supplies the claude session they were spawned by instead
  const spawnerSession = resolveSpawnerSession(logDir, cwd);

  // One worktree per run whose tools can write (Edit/Write/Bash or no
  // restriction), in a git cwd; --worktree/--no-worktree override. A git refusal
  // fails the start for a writing run (hard gate); read-only runs go in place.
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
      if (worktree.snapshotSkipped) process.stderr.write(`pai worker: ${worktree.snapshotSkipped}\n`);
    } catch (e) {
      const why = (e as Error).message;
      if (worktreeRefusesStart(logDir, wid, why, parsed.allowedTools)) {
        process.stderr.write(`pai worker: not started, no worktree (${why})\n`);
        return 1;
      }
      process.stderr.write(`pai worker: no worktree (${why}) — read-only, running in place\n`);
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
  // the router's fair queue shares a local engine between owning sessions
  addSchedulingHeaders(env, { session: session?.name || spawnerSession || itermUuid(term), worker: wid });
  const noteToken = newNoteToken();
  env[NOTE_TOKEN_ENV] = noteToken;
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
        noteTokenSentence(noteToken), // per-run token: measured 2026-10-20, it cut the shared prefix after 2.3k of 9k tokens
      ]
    : [];
  const { text: taskText, applied: trailerApplied } = headlessPromptText(
    parsed.prompt,
    headless,
    parsed.callerSystemPrompt,
    a.reportFormat
  );
  const promptText = taskText !== null && volatileParts.length ? placeVolatile(taskText, volatileParts.join("\n")) : taskText;
  // Claude Code's own gitStatus block (branch = worker branch, recent commits) opens the first user
  // message and differs per worker; measured 2026-10-20 it was the first differing token after the
  // shared 5,445 (system+tools). The documented switch (env CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS =
  // setting includeGitInstructions:false) drops it, and the git section of the system prompt with it.
  if (volatileInTask) env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = "1";
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
      ...(headless && !parsed.callerSystemPrompt ? [workerContractPrompt(a.className, a.reportFormat, a.orchestrate, volatileInTask ? undefined : noteToken)] : []),
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
        ...(env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS ? { gitStatus: "off" } : {}),
        ...(limit ? { deadline: new Date(limit.deadlineAt).toISOString(), maxMinutes: limit.minutes } : { limit: "none" }),
      })
    );
    return 0;
  }

  // a gate that already ran (gateStart) rewrote `started` at the slot grant;
  // keep that stamp so the deadline and ps age count from the grant
  const gated = a.gated ? loadStatus(logDir, wid) : null;
  const started = gated && Number.isFinite(Date.parse(gated.started.replace(" ", "T")))
    ? new Date(Date.parse(gated.started.replace(" ", "T")))
    : new Date();
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
    started: nowStamp(started),
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
    ...(sessionKey ? { sessionKey } : {}),
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
    ...(a.queueWaitedMs ? { queueWaitedMs: a.queueWaitedMs } : {}),
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
  if (paneVerified) status.pane = { opened: true, exec: true };
  else if (headless && !a.panePrepared) void announcePane(logDir, config, wid, term, noPane, ledger, status);

  let proc: ReturnType<typeof spawn>;
  try {
    if (headless && !a.gated) await runGates(a, wid, status);
    proc = await spawnOwned(wid, cmd, {
      env,
      cwd: worktree?.dir ?? cwd,
      stdio: headless ? ["pipe", "pipe", "pipe"] : "inherit",
      render: "stream",
      title: paneTitle(label, target.providerName),
      statusLine: { kind: "worker", id: wid, logDir },
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
        resultGrace.cancel();
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
  const resultGrace = armResultGrace(headless ? proc.pid : undefined);
  const stopDeadline = limit ? armDeadline(proc, limit, () => fireDeadline(logDir, status, ledger, limit), undefined, () => blockedMsOf(logDir, wid)) : null;
  const stopTrack = trackBlocked(logDir, status, limit);
  const cleanup = () => {
    stopDeadline?.();
    stopTrack();
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
    // the build lock and tree of a killed worker go with it
    void releaseBuildsOf(buildsDir(), wid).catch(() => []).finally(() => process.exit(143));
    setTimeout(() => process.exit(143), 2000).unref();
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
  // The latest per-turn fill (input side of the newest assistant usage, reset
  // at a compact boundary): the context meter's high-water mark is kept on the
  // status, but a compact result must drop it to THIS value — a result event's
  // usage is the run's cumulative total, never the post-compact context.
  // Holder object: a plain `let` would be flow-narrowed to null at the use
  // site below, since only the readline callback ever assigns it.
  const turnFill: { last: number | null } = { last: null };
  // every Bash call + outcome, and the untracked files present at spawn: the
  // end-of-run proof check (checkProof) and stray-file listing read these
  const bashRuns: BashRun[] = [];
  let trouble: TroubleWatcher | undefined;
  let troubleTimer: ReturnType<typeof setInterval> | undefined;
  const untrackedAtStart = new Set(headless ? untrackedPaths(worktree?.dir ?? cwd) : []);

  // setup ends when the worker process holds its first turn; the first answer is timed from there
  const timing: { readyAt: number; firstAt: number | null } = { readyAt: Date.now(), firstAt: null };
  if (headless) {
    // the first user message carries the prompt (the -p value was stripped)
    if (promptText !== null) {
      try {
        timing.readyAt = Date.now();
        proc.stdin!.write(stdinUserMessage(promptText) + "\n");
      } catch {
        /* child died instantly; the close handler reports it */
      }
    }
    const origin = await reportOriginWithHost();
    if (origin) {
      trouble = new TroubleWatcher(wid, label, runMessenger(logDir), origin);
      troubleTimer = setInterval(() => trouble?.tick(), 60_000);
      troubleTimer.unref();
    }
    eventsFd = openSync(eventsPath(logDir, wid), "a");
    writeEvent({ type: "preamble", text: preambleLine(preamble), ...(preamble ? { hash: preamble.hash } : {}) });
    if (addendum) writeEvent({ type: "contract-addendum", text: `${addendum.path} sha ${addendum.sha}`, sha: addendum.sha });
    const rl = createInterface({ input: proc.stdout! });
    const toolUses = new Map<string, { name: string; input: unknown }>();
    rl.on("line", (line) => {
      trouble?.activity();
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
        turnFill.last = usageContextUsed(e.usage) ?? null;
        saveStatus(logDir, status);
      } else if (e.type === "assistant") {
        status.turns += 1;
        timing.firstAt ??= Date.now();
        if (status.turns === 1) recordWarmup(logDir, status.provider, (Date.now() - t0) / 1000);
        bumpContextTokens(status, usageContextUsed(e.message?.usage));
        turnFill.last = usageContextUsed(e.message?.usage) ?? turnFill.last;
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
            if (recordDenial(status, block, toolResultText(block.content), toolUses, parsed.prompt, new Date().toISOString())) {
              const d = parseDenialText(toolResultText(block.content), "?");
              if (d) trouble?.onDenial(d.hook, d.reason);
            }
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
        // a result event's usage is the run's CUMULATIVE total (summed over
        // all turns), never a turn fill: it must not raise the context meter
        // (a 200k-window run once read "context 690%" from its 1.38M total).
        // A compact result legitimately restarts the context lower: the meter
        // drops to the last per-turn fill the assistant events recorded (the
        // post-compact context), never to the result's cumulative usage.
        if (e.is_compact) status.contextTokens = turnFill.last ?? status.contextTokens;
        const report = parseWorkerReport(e.result ?? "");
        if (report?.notes) status.last = shortText(report.notes, 90);
        else if (e.result) status.last = shortText(e.result, 90);
        saveStatus(logDir, status);
        operatorInFlight = 0;
        armStdinClose();
        ctx.resultEvent = e;
        ctx.resultReport = report;
        resultGrace.onResult();
      }
    });
  }

  let rc = await new Promise<number>((resolve, reject) => {
    proc.on("error", (e) => {
      markStartFailed(logDir, status, e);
      reject(e);
    });
    proc.on("close", (code) => resolve(code ?? (killed ? 143 : 1)));
  });
  if (troubleTimer) clearInterval(troubleTimer);
  if (trouble) {
    const stop = peekLoopStop(logDir, wid);
    if (stop) trouble.onLoopStop(stop.reason);
    await trouble.flush();
  }
  resultGrace.cancel();
  await resultGrace.settled();
  // the result already received is the outcome; the signal that ended the leftovers is not
  if (resultGrace.fired && ctx.resultEvent) rc = ctx.resultEvent.is_error ? 1 : 0;
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
    const rep = repairAndValidateAg2(resultEvent.result);
    const v = rep.validation;
    if (rep.repairs.length) {
      resultEvent.result = rep.text;
      ctx.resultReport = parseWorkerReport(rep.text);
      if (ctx.resultReport?.notes) status.last = shortText(ctx.resultReport.notes, 90);
    }
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
  if (resultGrace.fired && resultEvent) {
    status.last = leftoverNote(resultGrace.leftover);
    appendLedger(ledger, "WORKER-LEFTOVER-ENDED", { id: wid, processes: resultGrace.leftover });
  }
  let reviewed = false;
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
      ...(a.runT0 ? { setupMs: Math.max(0, timing.readyAt - a.runT0) } : {}),
      ...(a.setupPaneMs !== undefined ? { setupPaneMs: a.setupPaneMs } : {}),
      ...(a.admissionMs !== undefined ? { admissionMs: a.admissionMs } : {}),
      ...(a.spawnT0 ? { spawnMs: Math.max(0, timing.readyAt - a.spawnT0) } : {}),
      ...(timing.firstAt !== null ? { firstAnswerMs: timing.firstAt - timing.readyAt } : {}),
      ...(a.spareMiss ? { spare: "miss", spareMiss: a.spareMiss } : {}),
    },
    report: ctx.resultReport,
    fallbackText: resultEvent?.result,
    worktree,
    timedOut: status.timedOut ? limit?.minutes : undefined,
    fallThroughWhy: (st, rep) => (headless ? fallThroughReason(a.route, st, rep) : null),
    onReviewed: () => {
      reviewed = true;
    },
    beforeHandoff: async (st, rep) => {
      // Fall-through: a local run that failed its own report is repeated once on the cloud
      // (unless it committed: finaliseRun keeps that one for review — and a run
      // kept for review is not escalated either; escalation starts from the
      // salvaged branch instead).
      const failWhy = headless ? fallThroughReason(a.route, st, rep) ?? (st.loopStopped ? "loop-guard stop" : null) : null;
      const escalated = headless
        ? await tryEscalate(a, wid, st, rep, resultEvent?.result, worktree ? commitLines(worktree.dir, worktree.base) : [], failWhy, reviewed)
        : null;
      if (escalated !== null) return escalated;
      const why = headless && !reviewed ? fallThroughReason(a.route, st, rep) : null;
      if (why && a.route && !st.escalated) {
        return rerunOnCloud(a, wid, why, st);
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
      if (worktree.snapshotSkipped) process.stderr.write(`pai worker: ${worktree.snapshotSkipped}\n`);
    } catch (e) {
      const why = (e as Error).message;
      if (worktreeRefusesStart(logDir, wid, why, parsed.allowedTools)) {
        process.stderr.write(`pai worker: not started, no worktree (${why})\n`);
        return 1;
      }
      process.stderr.write(`pai worker: no worktree (${why}) — read-only, running in place\n`);
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
    ...(a.queueWaitedMs ? { queueWaitedMs: a.queueWaitedMs } : {}),
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

  if (paneVerified) status.pane = { opened: true, exec: true };
  else void announcePane(logDir, config, wid, term, noPane, ledger, status);

  const t0 = Date.now();
  const proc = await spawnOwned(wid, ["codex", ...buildCodexArgs(prompt, parsed.callerModel ? undefined : model)], {
    env,
    cwd: worktree?.dir ?? cwd,
    stdio: ["ignore", "pipe", "inherit"],
    title: paneTitle(label, target.providerName),
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
  const stopDeadline = a.limit ? armDeadline(proc, a.limit, () => fireDeadline(logDir, status, ledger, a.limit!), undefined, () => blockedMsOf(logDir, wid)) : null;
  const stopTrack = trackBlocked(logDir, status, a.limit);
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
  stopTrack();
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
// providers test: the 90-second pong probe (moved to run/provider-test.ts)
// ---------------------------------------------------------------------------

export { buildRunEnv } from "./run-env.js";
export * from "./run/argv.js";
export * from "./run/model.js";
export * from "./run/provider-test.js";
export * from "./run/stream.js";
export * from "./run/types.js";
