/**
 * run/worker.ts — runWorker: routing, capacity/stagger and dispatch to the spawn engines, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { modelFrozen, realFreezeDeps, thawModelServers } from "../freeze.js";
import { readUrgency } from "../urgency.js";
import { setRunWorker } from "./worker-ref.js";
import { mkdirSync } from "node:fs";
import { parseRunnerArgs, shortText } from "../args.js";
import { ANTHROPIC_NATIVE, assertProviderRunnable, getProviderOrNative, isLocalProvider, pinProviderForModel, readWorkersSection } from "../config.js";
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
import { initialBudgetMinutes } from "../time-budget.js";
import { stripBrowserArgs } from "../browser-tools.js";
import { type RunOptions, type ExecuteArgs } from "./types.js";
import {
  resolveReportFormat,
  resolveRunModel,
  stepDownOrchestratorModel,
  routeClassOf,
} from "./model.js";
import { isBenchmarkLabel } from "../../daemon/battery-guard.js";
import { releasePane, isPaiContinuation } from "./pane-handles.js";
import {
  BatteryGuardRefusedError,
  LocalProviderRefusedError,
  assertLocalProviderAlive,
  batteryGuardRefusal,
  keepAboveHold,
  tryPoolRun,
  recordPoolSkip,
  gateStart,
} from "./gate.js";
import { resolveTopic } from "../topic.js";
import { executeImageRun, executeRun, executeCodexRun, executeOpencodeRun } from "./execute.js";
import { executeUhpRun } from "./execute-uhp.js";
import { carryGoals } from "../note-delivery.js";
import { applyModeToConfig } from "../mode.js";
import { parseHarnessFlag, resolveHarnessProvider } from "../uhp.js";

/**
 * Run one worker. Returns the process exit code to pass through.
 * Throws WorkersConfigError-shaped Errors for configuration problems.
 */
export async function runWorker(opts: RunOptions): Promise<number> {
  const runT0 = Date.now();
  const { raw: _raw, workers: config } = readWorkersSection();
  // speed | balanced | budget (mode.ts) overrides the tiers; the session's explicit rows below still win
  applyModeToConfig(config);
  // the session's own routing rows replace the global ones for this run (routeRun and resolveTarget read config.classes)
  const sessionName = await detectSessionName();
  const sessionRoutes = sessionName ? getProfile(sessionName)?.routes : undefined;
  if (sessionRoutes) config.tiers = applyRouteOverrides(config.tiers, sessionRoutes);
  void _raw;
  if (opts.harnessFlag) {
    const harnessId = parseHarnessFlag(opts.harnessFlag);
    opts = { ...opts, harnessId, providerFlag: resolveHarnessProvider(config.providers, harnessId, opts.providerFlag), harnessFlag: undefined };
  }
  if (!config.enabled) {
    throw new Error(
      `workers are off. Turn them on with: pai worker on` +
        `\n(then the Agent-tool hook stops denying Anthropic subagents only when you do)`
    );
  }
  const logDir = workersLogDir(config);
  mkdirSync(logDir, { recursive: true });
  // a continuation (escalation, fall-through, reroute) carries the operator goals of the runs it continues
  opts = { ...opts, claudeArgs: carryGoals(logDir, opts.claudeArgs, opts._priorIds) };
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
  const parent = launchParent(opts.parent, process.env, logDir);
  if (parent) assertChildAllowed(logDir, parent, config.tree);
  const topic = resolveTopic(logDir, opts.topic, [opts._fallThroughOf, opts.resumeOf, opts._restartOf, ...(opts._priorIds ?? []).slice().reverse()], parent);

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
  // priority passes a freeze (gate.ts); its local model server may be stopped: --local thaws it, a routed run takes the cloud
  const urgentRun = opts.priority === "front" || !!readUrgency(process.env);
  let frozenModelCloud = false;
  if (urgentRun && modelFrozen()) {
    if (opts.localFlag) {
      const line = thawModelServers(logDir, await realFreezeDeps());
      if (line && !opts.quiet) process.stderr.write(`pai worker: ${line}\n`);
    } else {
      frozenModelCloud = true;
    }
  }
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
  // A named --model pins the provider that serves it when one was already
  // named: --where local + a model only the cloud serves is an error naming
  // the fix, never a silent drop (the policy below routes a bare --model).
  if (!providerFlag && !capability) {
    const pinned = pinProviderForModel(config, {
      where: opts.whereFlag,
      local: opts.localFlag,
      cloud: (() => {
        const a = getProviderOrNative(config, config.active ?? ANTHROPIC_NATIVE);
        return a && a.baseUrl && isLocalProvider(a.baseUrl) ? ANTHROPIC_NATIVE : (config.active ?? ANTHROPIC_NATIVE);
      })(),
      localName: providerWhy === "local" ? providerFlag : null,
      modelFlag: opts.modelFlag,
    });
    if (pinned) {
      providerFlag = pinned;
      providerWhy = `--model ${opts.modelFlag}`;
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
    const routed = await routeRun(config, logDir, { ...opts, className: routeClassOf(opts), ...(frozenModelCloud ? { cloud: true } : {}) });
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
  // battery guard (src/daemon/battery-guard.ts): while the guard has paused
  // new local-model work, a run resolved onto a local provider is refused
  // with the reason; remote providers are untouched.
  const batteryWhy = batteryGuardRefusal(isLoopbackProvider(target.provider), logDir, target.providerName, Date.now(), undefined, isBenchmarkLabel(opts.label));
  if (batteryWhy) throw new BatteryGuardRefusedError(batteryWhy);
  // keep-above gate: a new local worker queues below power.batteryGuard.keepAbovePct
  if (!isBenchmarkLabel(opts.label)) await keepAboveHold(isLoopbackProvider(target.provider), logDir, target.providerName);
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
  // the progress-based budget: a headless run opens with its allowance and
  // checkpoints double it while it progresses (time-budget.ts)
  const budgetMin =
    parsed.headless && !opts.deadline
      ? initialBudgetMinutes(opts.budgetMin !== undefined ? { ...config.timeBudget, start: opts.budgetMin } : config.timeBudget, limit?.minutes ?? null)
      : null;
  const label =
    opts.label ??
    shortText(parsed.prompt ?? UNLABELED, 70);
  // local contract (local-contract.ts): headless local workers only, never a cloud one
  if (parsed.headless && parsed.prompt) parsed.prompt = taskForProvider(parsed.prompt, target.provider, opts.cwd ?? process.cwd(), opts.label);

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

  // a PAI-started continuation (reroute, fall-through, handoff, escalation): every engine opens its pane
  // through the launcher like a normal start, never headless (see pane-handles.ts)
  const restart = isPaiContinuation(opts);
  // tracked across every engine (including a quota reroute's recursive
  // runWorker call) so the exit hook below knows which status to check,
  // whatever opts.id/onWorkerStart the caller did or didn't pass
  let workerId: string | undefined = opts.id;
  // the claude path announces its id once: execArgs.announced (set below, before the gates) means that
  // announce is gateStart's — at the queue, so a --detach starter returns while the run queues — and
  // foldRun/tryPoolRun skip theirs; an ungated interactive run has no gate announce and foldRun clears
  // the flag to announce at its real start. trackStart stays per-call: an escalation or fall-through
  // re-run announces its new id through it.
  const trackStart = (wid: string) => {
    workerId = wid;
    opts.onWorkerStart?.(wid);
  };

  try {
    let rc: number;
    // image, codex and opencode runs never go through the pool; the skip is recorded under the id they mint
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
    } else if (target.provider.engine === "uhp") {
      rc = await executeUhpRun({
        config,
        logDir,
        target,
        model,
        label,
        parsed,
        claudeArgs: opts.claudeArgs,
        systemWaiver: opts.systemWaiver,
        restart,
        cwd: opts.cwd,
        specPath: opts.specPath,
        parent: parent ?? undefined,
        stage: opts.stage,
        quiet: opts.quiet,
        onWorkerStart: engineSkip,
        id: opts.id,
        resumeOf: opts.resumeOf,
        className: opts.className,
        reportFormat,
        capability: capability ?? undefined,
        limit,
        noBrowser,
        harnessId: opts.harnessId,
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
        restart,
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
    } else if (target.provider.engine === "opencode") {
      rc = await executeOpencodeRun({
        config,
        logDir,
        target,
        model,
        label,
        parsed,
        claudeArgs: opts.claudeArgs,
        systemWaiver: opts.systemWaiver,
        restart,
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
        restart,
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
        ...(topic ? { topic } : {}),
        reroutes: opts._reroutes ?? 0,
        emptyRetried: opts._emptyRetried ?? false,
        route,
        routeWhy,
        noEscalate: opts.noEscalate,
        fallThroughOf: opts._fallThroughOf,
        escalatedFrom: opts._escalatedFrom,
        priorIds: opts._priorIds,
        printCmd: opts.printCmd,
        reportFormat,
        noReportRetry: opts.noReportRetry ?? false,
        orchestrate: opts.orchestrate,
        limit,
        budgetMin,
        noBrowser,
        allowTests: opts.allowTests,
        allowDbWrites: opts.allowDbWrites,
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
