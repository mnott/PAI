/**
 * run/execute-prepare.ts — executeRun up to the finished argv: proxy/router, env, worktree, preamble, MCP/tool
 * flags, prompt text, cmd. Returns the PreparedRun the spawn-and-fold half reads, or an exit code when the run
 * ends here (refused start, --print-cmd dry run).
 */

import { applyScratchEnv, scratchPromptLine } from "../scratch.js";
import { NOTE_TOKEN_ENV, newNoteToken } from "../note-delivery.js";
import { TroubleWatcher } from "../worker-trouble.js";
import type { BashRun, WorkerReport } from "../report.js";
import { appendSystemPromptArgs, stripPromptValues } from "../args.js";
import {
  addSchedulingHeaders,
  buildRunEnv,
  claudeCommand,
  claudeSettingsExtra,
  pinnedSettings,
  isLoopbackProvider,
  routeLoopbackViaRouter,
} from "../run-env.js";
import { probeRouter } from "../../router/supervisor.js";
import { appendLedger } from "../ledger.js";
import { ensureNoMcpConfig, ledgerPath } from "../paths.js";
import { slimProfileArgs, WORKER_BRIEF } from "../slim-profile.js";
import { newWorkerId } from "../status.js";
import { itermUuid, resolveSession, resolveSpawnerSession } from "../scope.js";
import { applySessionProviderEnv } from "../session-provider.js";
import { detectSessionName } from "../session-name.js";
import { resolveHostSession } from "../pane.js";
import {
  addWorktree,
  adoptTree,
  inPlaceSystemPrompt,
  worktreeSystemPrompt,
  worktreeRefusesStart,
  worktreeWanted,
  type WorktreeInfo,
} from "../worktree.js";
import { noteTokenSentence, workerContractPrompt } from "../report.js";
import { loadContractAddendum, type ContractAddendum } from "../contract-addendum.js";
import { loadPreamble, preambleBlock, preambleLine, type Preamble } from "../preamble.js";
import { deadlinePromptLine } from "../deadline.js";
import { stripBrowserNames } from "../browser-tools.js";
import { expandMcpNames, mcpServersFromToolGrants, writeMcpConfig } from "../mcp.js";
import { pinNotices, projectLaunchConfig } from "../project-config.js";
import { proxyPort, ensureProxyRunning } from "../proxy/server.js";
import type { ExecuteArgs, StreamEvent } from "./types.js";
import { modelFlagArgs } from "./model.js";
import {
  headlessPromptText,
  placeVolatile,
  DEFAULT_WORKER_TOOLS,
  headlessToolGrants,
  headlessToolsFlag,
  ensureToolSearch,
  chromeGrantArgs,
  interactiveMcpTools,
} from "./argv.js";
import { requireVisiblePane } from "./pane-handles.js";

/**
 * The mutable state of one run. Only the readline / signal callbacks assign most of it and the code after the
 * await reads it, so it is a holder object: a plain `let` would be flow-narrowed to its initial value at the read.
 */
export interface RunState {
  /** last result event + its parsed report */
  resultEvent: StreamEvent | null;
  resultReport: WorkerReport | null;
  /**
   * latest per-turn fill (input side of the newest assistant usage, reset at a compact boundary): a compact
   * result must drop the context meter to THIS value — a result event's usage is the run's cumulative total
   */
  lastFill: number | null;
  /** stdin lifecycle: operator messages in flight, and the close timer armed after a result */
  operatorInFlight: number;
  closeTimer: NodeJS.Timeout | null;
  eventsFd: number | null;
  killed: boolean;
  /** tail of claude's stderr, kept for a start that dies before any model event */
  stderrTail: string;
  trouble: TroubleWatcher | undefined;
  troubleTimer: ReturnType<typeof setInterval> | undefined;
  /** every Bash call + outcome: the end-of-run proof check reads these */
  bashRuns: BashRun[];
}

export function newRunState(): RunState {
  return {
    resultEvent: null,
    resultReport: null,
    lastFill: null,
    operatorInFlight: 0,
    closeTimer: null,
    eventsFd: null,
    killed: false,
    stderrTail: "",
    trouble: undefined,
    troubleTimer: undefined,
    bashRuns: [],
  };
}

export interface PreparedRun {
  headless: boolean;
  wid: string;
  adopted: ReturnType<typeof adoptTree>;
  cwd: string;
  term: string;
  paneVerified: boolean;
  session: ReturnType<typeof resolveSession>;
  sessionKey: Awaited<ReturnType<typeof detectSessionName>>;
  spawnerSession: ReturnType<typeof resolveSpawnerSession>;
  worktree: WorktreeInfo | null;
  preamble: Preamble | null;
  addendum: ContractAddendum | null;
  trailerApplied: boolean;
  env: NodeJS.ProcessEnv;
  claudeCmd: string[];
  cmd: string[];
  chromeArgs: string[];
  mcpArgs: string[];
  toolArgs: string[];
  toolsFlag: string[];
  slimArgs: string[];
  promptText: string | null;
  state: RunState;
}

/**
 * The worktree for a run whose tools can write: the info, null when git refused but
 * the run is read-only (it runs in place, with a ledger note), "refused" when a writing run must not start.
 */
export function createRunWorktree(
  logDir: string,
  wid: string,
  cwd: string,
  allowedTools: Parameters<typeof worktreeRefusesStart>[3]
): WorktreeInfo | null | "refused" {
  try {
    const worktree = addWorktree(logDir, wid, cwd);
    if (worktree.snapshotSkipped) process.stderr.write(`pai worker: ${worktree.snapshotSkipped}\n`);
    return worktree;
  } catch (e) {
    const why = (e as Error).message;
    if (worktreeRefusesStart(logDir, wid, why, allowedTools)) {
      process.stderr.write(`pai worker: not started, no worktree (${why})\n`);
      return "refused";
    }
    process.stderr.write(`pai worker: no worktree (${why}) — read-only, running in place\n`);
    appendLedger(ledgerPath(logDir), "WORKER-NOTE", { id: wid, note: `no worktree: ${why}` });
    return null;
  }
}

export async function prepareRun(a: ExecuteArgs): Promise<PreparedRun | number> {
  const { config, logDir, target, model, label, parsed, systemWaiver, limit, noBrowser } = a;
  const headless = parsed.headless;

  // openai-protocol providers run through the local proxy (started on demand)
  let proxyUrl: string | undefined;
  if (target.provider.protocol === "openai") {
    const base = await ensureProxyRunning(proxyPort(), logDir);
    proxyUrl = `${base}/${target.providerName}`;
  }
  let viaRouter: boolean | undefined;
  if (!proxyUrl && !target.provider.native && isLoopbackProvider(target.provider) && target.provider.router !== false) {
    viaRouter = routeLoopbackViaRouter(target.provider, await probeRouter());
    if (!viaRouter) process.stderr.write(`pai: router down, ${target.providerName} runs direct (no router prefix fix)\n`);
  }
  const env = buildRunEnv(target.provider, headless, proxyUrl, target.providerName, viaRouter, a.orchestrate);
  // read by the anti-pattern firing record (which model a pattern fired on)
  if (headless && typeof model === "string" && model) env.PAI_WORKER_MODEL = model;

  const wid = a.id ?? newWorkerId();
  // a resume takes over the old id's tree and runs against its repo
  const adopted = a.resumeOf ? adoptTree(logDir, a.resumeOf) : null;
  const cwd = adopted?.cwd ?? a.cwd ?? process.cwd();
  const term = (await resolveHostSession()).term;
  await a.paneOpening;
  if (a.paneError) throw a.paneError;
  const paneVerified = a.panePrepared
    ? a.panePrepared.verified
    : headless && (await requireVisiblePane(logDir, config, wid, term, systemWaiver, a.printCmd === true, ledgerPath(logDir)));
  a.spawnT0 = Date.now();
  const session = resolveSession(term);
  const sessionKey = await detectSessionName();
  // orchestrator Bash children have no terminal identity (see scope.ts) — the
  // session map supplies the claude session they were spawned by instead
  const spawnerSession = resolveSpawnerSession(logDir, cwd, process.env);

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
  const scratch = applyScratchEnv(env, wid);
  // the router's fair queue shares a local engine between owning sessions
  addSchedulingHeaders(env, { session: session?.name || spawnerSession || itermUuid(term), worker: wid, priority: a.queuePriority });
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

  // Created last among the steps that can refuse or throw (preamble size, unknown --mcp names), so those exits strand no worktree.
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
    const made = createRunWorktree(logDir, wid, cwd, parsed.allowedTools);
    if (made === "refused") return 1;
    worktree = made;
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
        scratchPromptLine(scratch),
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
  const claudeCmd = claudeCommand(env);
  let cmd: string[] = [...claudeCmd];
  cmd.push(...modelFlagArgs(headless, model, Boolean(parsed.callerModel)));
  const slimArgs = headless ? slimProfileArgs(logDir, wid, parsed.rest, env, undefined, target.provider, pinnedSettings(env, undefined, claudeSettingsExtra(env))) : [];
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
      ...(headless && !volatileInTask ? [scratchPromptLine(scratch)] : []),
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
  return {
    headless,
    wid,
    adopted,
    cwd,
    term,
    paneVerified,
    session,
    sessionKey,
    spawnerSession,
    worktree,
    preamble,
    addendum,
    trailerApplied,
    env,
    claudeCmd,
    cmd,
    chromeArgs,
    mcpArgs,
    toolArgs,
    toolsFlag,
    slimArgs,
    promptText,
    state: newRunState(),
  };
}
