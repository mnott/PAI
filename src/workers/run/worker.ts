/**
 * run/worker.ts — runWorker: routing, capacity/stagger and dispatch to the spawn engines, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { setRunWorker } from "./worker-ref.js";
import { mkdirSync } from "node:fs";
import { parseRunnerArgs, shortText } from "../args.js";
import { assertProviderRunnable, getProviderOrNative, readWorkersSection } from "../config.js";
import { isLoopbackProvider } from "../run-env.js";
import { LOCAL_MECHANISM_LINE, NoLocalServerError, isLocalCandidate, resolveLocalProvider, tierProviderNames } from "../local-provider.js";
import { workersLogDir } from "../paths.js";
import { UNLABELED } from "../status.js";
import { returnControlsIfHeld } from "../controls.js";
import { routeRun } from "../policy.js";
import {
  capabilityForRun,
  NoProviderError,
  recordBudgetCooldowns,
  resolveCapabilityRun,
  resolveTarget,
  type CapabilityRunResolution,
} from "../routing.js";
import { applyRouteOverrides } from "../route-lists.js";
import { detectSessionName } from "../session-name.js";
import {
  getProfile,
  isBatchEnv,
  liveResolveCtx,
  resolveWorkers,
} from "../session-profile.js";
import { budgetCache } from "../budget.js";
import { assertChildAllowed, launchParent } from "../tree.js";
import { gcWorktreesThrottled } from "../worktree.js";
import { taskForProvider } from "../local-contract.js";
import { resolveLimit } from "../deadline.js";
import { stripBrowserArgs } from "../browser-tools.js";
import { type RunOptions, type ExecuteArgs } from "./types.js";
import {
  resolveReportFormat,
  resolveRunModel,
  stepDownOrchestratorModel,
  routeClassOf,
} from "./model.js";
import { releasePane } from "./pane-handles.js";
import {
  LocalProviderRefusedError,
  assertLocalProviderAlive,
  tryPoolRun,
  recordPoolSkip,
  gateStart,
} from "./gate.js";
import { executeImageRun, executeRun, executeCodexRun } from "./execute.js";

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
    const { runPlanner } = await import("../planner.js");
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
      const res = await resolveLocalProvider(config, logDir, { className: routeClassOf(opts), name: opts.localName });
      providerFlag = res.name;
      providerWhy = "local";
      // a tier-launched server answers although its provider entry is off; it is running, so this run may use it
      const resolved = config.providers[res.name];
      if (resolved) resolved.enabled = true;
      if (!opts.quiet) process.stderr.write(`pai worker: local provider ${res.name} (${res.why})\n`);
    } catch (e) {
      // --print-cmd is a dry run: nothing must answer a port for the argv
      // audit, so an unresolved local pin falls back to the first configured
      // loopback provider and the route line still says (local). A real run
      // keeps the hard error — nothing spawns onto a server that is down.
      if (!(opts.printCmd && e instanceof NoLocalServerError)) throw e;
      const first = Object.entries(config.providers).find(
        ([n, p]) => isLocalCandidate(p, n, tierProviderNames()) && isLoopbackProvider(p)
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
    // image and codex runs never go through the pool; the skip is recorded under the id they mint
    const engineSkip = (wid: string) => {
      recordPoolSkip({ logDir, quiet: opts.quiet }, target.providerName, "engine", { id: wid });
      trackStart(wid);
    };
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
        onWorkerStart: engineSkip,
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
        systemWaiver: opts.systemWaiver,
        cwd: opts.cwd,
        specPath: opts.specPath,
        parent: parent ?? undefined,
        stage: opts.stage,
        quiet: opts.quiet,
        onWorkerStart: engineSkip,
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
        systemWaiver: opts.systemWaiver,
        noStagger: opts.noStagger,
        noQueue: opts.noQueue,
        queuePriority: opts.queuePriority,
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

setRunWorker(runWorker);
