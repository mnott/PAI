/**
 * Workers: `pai worker <verb>` — run a task on another provider, watch it,
 * talk to it, merge what it did. Thin: every verb calls src/workers/*, the
 * same code the MCP tools and the Agent hook use. Names, flags, stdout and
 * exit codes are the ones hooks, prompts, skills and shims already call.
 */

import { currentWorkerId } from "../../workers/worker-id.js";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getProviderOrNative, isModelCapability, readWorkersSection, WorkersConfigError, type ModelCapability, type WorkerProvider, type WorkersConfig } from "../../workers/config.js";
import { eventsPath, ledgerPath, workersLogDir } from "../../workers/paths.js";
import { longInlinePromptHint, parseRunnerArgs } from "../../workers/args.js";
import { LocalProviderRefusedError, runWorker, type RunOptions } from "../../workers/run.js";
import { LOCAL_MECHANISM_LINE } from "../../workers/local-provider.js";
import { runChain } from "../../workers/chain.js";
import { realDeps as waitOnDeps, statusMarker, statusQueue, waitOn } from "../../workers/wait-on.js";
import { readSpecPrompt, resolveSpecPath } from "../../workers/specfile.js";
import { agentClaudeArgs, agentLabel, deriveLabel, loadAgent, modelToClass } from "../../workers/agents.js";
import { followTailOutput, followWorkers,psOutput, replayOutput, statusLineOutput } from "../../workers/viewer.js";
import { assertPaneNotDisabled, checkPaneForWorker, closeEndedPanes, openFollowPane, openPaneForWorker, resolveHostSession } from "../../workers/pane.js";
import { renderUsage, usageJson, parseWhen, workerUsage } from "../../workers/usage.js";
import { ageOf, loadStatus, nowStamp, setWorkerNote } from "../../workers/status.js";
import { providerCap, queueRows, reorderQueue } from "../../workers/capacity.js";
import { killTree } from "../../workers/kill-tree.js";
import { sayToWorker } from "../../workers/operator.js";
import { handoffFromInside } from "../../workers/handoff.js";
import { gitChangedFiles, HELP_REFUSED_EXIT, readHelpLedger, renderHelpReport, requestHelp, spawnPaiWorker } from "../../workers/help.js";
import { readMergeVerify } from "../../workers/workers-config.js";
import { followPaneRun, isPaneRunId, loadPaneRunStatus } from "../../workers/pane-run.js";
import { auditPanes, listItermTabs, renderPaneAudit, runningProcs } from "../../workers/pane-audit.js";
import { loadRegistry } from "../../workers/pane.js";
import { followPlanLog, planLogTail, planRunEnded } from "../../workers/plan-status.js";
import { discardWorker, formatKnowledge, gcWorktrees, leftoverWorktrees, mergeWorker, verifyWorker } from "../../workers/worktree.js";
import { formatPending, pendingGate, pendingResults } from "../../workers/pending.js";
import { runWait } from "../../workers/wait.js";
import { DEFAULT_IDLE_SECS, runProbed } from "../../workers/hang-probe.js";
import { realProbeDeps, waitFile, waitUrl } from "../../workers/wait-probes.js";
import { describeModels, describeCapabilities, modelPrefsText, resolveProviderName, setCapabilityPreference, setProviderModel, unsetCapabilityPreference } from "../../workers/providers.js";
import { BATCH_ENV } from "../../workers/session-profile.js";
import { resolveTarget, type TargetResolver } from "../../workers/target.js";
import { CliError, OPT, type CommandDef, type RunContext } from "../define.js";
import { dim, err, ok } from "../lib/utils.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function logDir(): string {
  try {
    return workersLogDir(readWorkersSection().workers);
  } catch (e) {
    throw new CliError(`cannot read the worker configuration: ${msgOf(e)}`, "pai config path   (shows which file is read)");
  }
}

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run a verb; any thrown error becomes one plain sentence (exit 1) with the next command. */
async function guard(next: string, fn: () => Promise<number | void> | number | void): Promise<number | void> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CliError) throw e;
    // a down or disabled local provider is a usage mistake, not a failure:
    // exit 2, the message plain, the fix (--local) named
    if (e instanceof LocalProviderRefusedError) throw new CliError(e.message, LOCAL_MECHANISM_LINE, 2);
    throw new CliError(msgOf(e), next);
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const flag = (ctx: RunContext, name: string): boolean => ctx.opts[name] === true;
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const out = (s: string) => process.stdout.write(s + "\n");

// ---------------------------------------------------------------------------
// run / resume
// ---------------------------------------------------------------------------

/**
 * Everything `worker run` hands to the engine, built from the parsed flags.
 * Pure apart from reading the spec/agent files, so the argv it produces can be
 * compared with the old command's.
 */
export type RunPlan =
  | { kind: "chain"; chain: Parameters<typeof runChain>[0] }
  | { kind: "run"; run: RunOptions };

export function buildRunPlan(ctx: RunContext): RunPlan {
  const o = ctx.opts;
  const className = str(o.class) ?? str(o.role);
  const report = str(o.report);
  if (report !== undefined && report !== "json" && report !== "ag2") {
    throw new Error(`--report: expected "json" or "ag2", got "${report}"`);
  }
  const cwd = str(o.cwd);
  if (cwd !== undefined) {
    if (!existsSync(cwd)) throw new Error(`--cwd: directory does not exist: ${cwd}`);
    if (!statSync(cwd).isDirectory()) throw new Error(`--cwd: not a directory: ${cwd}`);
  }
  const noPane = o["no-pane"] === true;
  let claudeArgs = ctx.rest;
  let specPath: string | undefined;
  const spec = str(o.spec);
  if (spec !== undefined) {
    if (parseRunnerArgs(ctx.rest).headless) {
      throw new Error("--spec and -p/--print are mutually exclusive — pass the prompt one way, not both");
    }
    const cwdForSpec = cwd ?? process.cwd();
    specPath = resolveSpecPath(spec, cwdForSpec);
    claudeArgs = ["-p", readSpecPrompt(spec, cwdForSpec), ...ctx.rest];
  } else {
    const hint = longInlinePromptHint(parseRunnerArgs(ctx.rest).prompt);
    if (hint) process.stderr.write(hint + "\n");
  }

  assertPaneNotDisabled(noPane);
  let label = str(o.label);
  let agentClass: string | undefined;
  const agent = str(o.agent);
  if (agent) {
    const def = loadAgent(agent);
    claudeArgs = [...agentClaudeArgs(def), ...claudeArgs];
    let agentProviders: Record<string, WorkerProvider> | undefined;
    try {
      agentProviders = readWorkersSection().workers.providers;
    } catch {
      agentProviders = undefined;
    }
    agentClass = modelToClass(def.model, agentProviders);
    if (!label) label = agentLabel(agent, parseRunnerArgs(claudeArgs).prompt);
  }
  const chain = str(o.chain);
  if (chain) {
    const brief = parseRunnerArgs(claudeArgs).prompt;
    if (!brief) throw new Error("--chain needs the task as -p '<brief>'");
    return {
      kind: "chain",
      chain: {
        stages: chain.split(","),
        className: className ?? agentClass,
        providerFlag: str(o.provider),
        modelFlag: str(o.model),
        label,
        noPane,
        mcpFlag: str(o.mcp),
        specPath,
        cwd,
        brief,
        claudeArgs,
      },
    };
  }
  if (!label) label = deriveLabel(parseRunnerArgs(claudeArgs).prompt, className ?? agentClass ?? "default");
  return {
    kind: "run",
    run: {
      providerFlag: str(o.provider),
      localFlag: o.local === true ? true : undefined,
      urgent: o.urgent === true ? true : undefined,
      localOk: o["local-ok"] === true ? true : undefined,
      cloud: o.cloud === true ? true : undefined,
      className: className ?? agentClass,
      modelFlag: str(o.model),
      label,
      mcpFlag: str(o.mcp),
      specPath,
      cwd,
      noPane,
      noStagger: o["no-stagger"] === true ? true : undefined,
      noQueue: o["no-queue"] === true ? true : undefined,
      worktreeFlag: o["no-worktree"] === true ? false : o.worktree === true ? true : undefined,
      maxMinutes: num(o["max-minutes"]),
      deadline: str(o.deadline),
      browser: o["no-browser"] === true ? false : o.browser === true ? true : undefined,
      printCmd: o["print-cmd"] === true || ctx.dryRun ? true : undefined,
      reportFormatFlag: report as "json" | "ag2" | undefined,
      noReportRetry: o["no-report-retry"] === true,
      orchestrate: o.orchestrate === true ? true : undefined,
      capabilityFlag: str(o.capability) ?? str(o.for),
      imageOut: str(o.out),
      imageSize: str(o.size),
      imageTimeoutMs: num(o["timeout-ms"]),
      claudeArgs,
    },
  };
}

/** --where / --model / --now through resolveTarget (target.ts), the one resolver every delegation entry point uses. */
export async function applyTarget(ctx: RunContext, plan: RunPlan, resolveIt: TargetResolver = resolveTarget): Promise<void> {
  const where = str(ctx.opts.where);
  const model = str(ctx.opts.model);
  const now = flag(ctx, "now");
  if (!where && !now && model !== "fast" && model !== "default") return;
  if (where && flag(ctx, "local")) throw new Error("--where and --local both name where to run; use one");
  const t = await resolveIt({ where, model, now });
  process.stderr.write(`pai worker: ${t.description}\n`);
  const target = plan.kind === "chain" ? plan.chain : plan.run;
  if (t.provider) target.providerFlag = t.provider;
  // "default" / "fast" are aliases, never a raw model id
  target.modelFlag = model === "default" || model === "fast" ? t.model : (t.model ?? target.modelFlag);
  if (plan.kind === "run") {
    if (t.modelFast) plan.run.modelFast = true;
    if (t.modelDefault) plan.run.modelDefault = true;
    if (t.priority) plan.run.priority = t.priority;
  }
}

const runCommand: CommandDef = {
  name: "run",
  summary: "Run one task on a worker (another provider or model)",
  description:
    "For local work use --local (picks the running local model); do not name a local provider.\n" +
    "Starts a Claude Code worker through the chosen provider and waits for it. The task goes in as -p '<task>' or, safer for long text, --spec FILE.\n" +
    "Options this command does not know (for example -p, --allowedTools) are handed to claude unchanged.\n" +
    "--label is the row shown in `ps`, `follow` and the status line; without it the first line of the task is used.\n" +
    "Give a worker an MCP tool by naming mcp__server__tool in --allowedTools; the server loads by itself.",
  allowUnknown: true,
  options: [
    { ...OPT.provider, summary: "Provider to run on (default: the active one, else the routing order)" },
    { name: "class", type: "string", value: "NAME", summary: "Use the provider set for this kind of work (draft, implement, review, research, spotcheck, simple, complex, image)" },
    { name: "role", type: "string", value: "NAME", summary: "Old name of --class" },
    { name: "capability", type: "string", value: "NAME", summary: "Run on whichever provider serves this capability (see `pai worker capability`), e.g. image" },
    { name: "for", type: "string", value: "NAME", summary: "Short for --capability" },
    { name: "out", type: "string", value: "FILE", summary: "Where an image run writes its PNG (default: next to the worker log)" },
    { name: "size", type: "string", value: "WxH", summary: "Image size for an image run, e.g. 1024x1024 (default 1024x1024)" },
    { name: "timeout-ms", type: "number", value: "N", summary: "How long an image run waits for its answer (default 120000)" },
    { name: "chain", type: "string", value: "STAGES", summary: "Comma-separated stages run one after the other, e.g. draft,implement,review" },
    { name: "agent", type: "string", value: "NAME", summary: "Run the agent definition ~/.claude/agents/NAME.md on a worker" },
    { ...OPT.model, summary: "Model for this run: default, fast or a model id (default: the model set for the class)" },
    { name: "urgent", type: "boolean", summary: "Needs a fast answer: go to the cloud even when the policy prefers local (see `pai worker policy`)" },
    { name: "where", type: "string", value: "WHERE", summary: "Where to run: local, cloud or a provider name (local and cloud are resolved by PAI; same as the MCP delegation tools' where)" },
    { name: "batch", type: "boolean", summary: "This run is part of a fan-out: session-profile fallback skips targets below the profile's parallel_min" },
    { name: "now", type: "boolean", summary: "Go ahead of the runs waiting for a slot on the provider" },
    { name: "local", type: "boolean", summary: "Run on the local model server PAI resolves (the one that answers); never pick a local provider by name" },
    { name: "local-ok", type: "boolean", summary: "This run may go to a local provider under the prefer-cloud policy" },
    { name: "cloud", type: "boolean", summary: "This run goes to the cloud under the prefer-local or auto policy" },
    { name: "label", type: "string", value: "TEXT", summary: "Short task label shown in ps, follow and the status line" },
    { name: "spec", type: "string", value: "FILE", summary: "Read the task from this file (or - for stdin) instead of -p" },
    { name: "cwd", type: "string", value: "DIR", summary: "Directory the worker runs in (default: here)" },
    { name: "mcp", type: "string", value: "NAMES", summary: "MCP servers or sets this worker may use, comma-separated (see `pai worker mcp`)" },
    { name: "no-pane", type: "boolean", summary: "Run without a visible pane (refused unless a worker or the operator override allows it)" },
    { name: "no-queue", type: "boolean", summary: "Do not queue behind the provider's concurrent-run cap (workers.yaml maxConcurrent)" },
    { name: "no-stagger", type: "boolean", summary: "Do not wait for an earlier run on the same provider to warm its prompt cache" },
    { name: "worktree", type: "boolean", summary: "Work in a git worktree on branch worker/ID (default for implement and complex work in a git repo)" },
    { name: "no-worktree", type: "boolean", summary: "Work in place, no worktree" },
    { name: "max-minutes", type: "number", value: "N", summary: "Stop after N minutes and keep the work (0 = no limit; default from the config, 60)" },
    { name: "deadline", type: "string", value: "HH:MM", summary: "Stop at this local time (tomorrow if already past); not with --max-minutes" },
    { name: "browser", type: "boolean", summary: "Allow browser tools" },
    { name: "no-browser", type: "boolean", summary: "Remove every browser tool from this worker" },
    { name: "print-cmd", type: "boolean", summary: "Print the claude command as JSON and exit without starting anything" },
    { name: "report", type: "string", value: "FORMAT", summary: "Final report format: json or ag2 (default ag2)" },
    { name: "no-report-retry", type: "boolean", summary: "Do not ask once more when the final report is malformed" },
    { name: "orchestrate", type: "boolean", summary: "This worker plans and reviews; code edits are denied and go to local units" },
  ],
  examples: [
    "pai worker run --class implement --label 'fix the retry loop' -p 'Fix the retry loop in src/net.ts'",
    "pai worker run --provider glm --spec /tmp/task.txt",
    "pai worker run --local -p 'Summarize the changelog'",
    "pai worker run --where cloud --model fast --now -p 'Say hi'",
    "pai worker run --chain draft,implement,review -p 'Add a --json flag to the export command'",
    "pai worker run --print-cmd --class spotcheck -p 'Say hi'",
  ],
  seeAlso: ["pai worker ps", "pai worker follow", "pai worker merge", "pai worker resume"],
  run: (ctx) =>
    guard("pai worker run --print-cmd -p 'test'   (shows the command without starting it)", async () => {
      const plan = buildRunPlan(ctx);
      if (flag(ctx, "batch")) process.env[BATCH_ENV] = "1";
      await applyTarget(ctx, plan);
      return plan.kind === "chain" ? await runChain(plan.chain) : await runWorker(plan.run);
    }),
};

const resumeCommand: CommandDef = {
  name: "resume",
  summary: "Continue a finished worker with a new instruction",
  description: "Starts a new worker on the same provider and model that picks up the conversation of a finished one (claude --resume).",
  args: [
    { name: "ID", required: true, summary: "Id of the finished worker (see `pai worker ps`)" },
    { name: "TEXT", required: true, summary: "What the worker should do next" },
  ],
  options: [
    { name: "print-id", type: "boolean", summary: "Print the new worker id on its own line" },
    { name: "no-pane", type: "boolean", summary: "Run without a visible pane (refused unless allowed)" },
    { name: "output-format", type: "string", value: "FORMAT", summary: "text (default), json or stream-json, as for `run`" },
    { name: "label", type: "string", value: "TEXT", summary: "Short task label (default: the old label with a return arrow)" },
  ],
  examples: ["pai worker resume w-20260101-abc 'Also add a test'", "pai worker resume w-20260101-abc 'Continue' --print-id"],
  seeAlso: ["pai worker ps", "pai worker run"],
  run: (ctx) =>
    guard("pai worker ps   (lists worker ids)", async () => {
      const id = ctx.args.ID as string;
      const text = ctx.args.TEXT as string;
      const noPane = flag(ctx, "no-pane");
      assertPaneNotDisabled(noPane);
      const dir = logDir();
      const old = loadStatus(dir, id);
      if (!old) throw new Error(`no worker named "${id}"`);
      if (!old.claudeSession) {
        throw new Error(
          `worker ${id} recorded no Claude session id — it predates resume support or ran through an engine that does not expose one`
        );
      }
      const claudeArgs = ["--resume", old.claudeSession, "-p", text];
      const fmt = str(ctx.opts["output-format"]);
      if (fmt !== undefined) claudeArgs.push("--output-format", fmt);
      let newId = "";
      const rc = await runWorker({
        providerFlag: old.provider,
        modelFlag: old.model,
        label: str(ctx.opts.label) || `↩ ${old.label}`,
        noPane,
        claudeArgs,
        resumeOf: id,
        onWorkerStart: (wid) => {
          newId = wid;
        },
      });
      if (flag(ctx, "print-id") && newId) out(newId);
      return rc;
    }),
};

// ---------------------------------------------------------------------------
// Looking at workers
// ---------------------------------------------------------------------------

const psCommand: CommandDef = {
  name: "ps",
  summary: "List this session's workers, running and finished",
  description:
    "Shows the workers started from this terminal. When other sessions have live workers too, a MACHINE section lists every live worker on this computer with the session that owns it.",
  options: [
    { name: "all", type: "boolean", summary: "Workers of all sessions, not just this terminal's" },
    { name: "panes", type: "boolean", summary: "List process -> pane -> tab for everything running, checked live" },
  ],
  examples: ["pai worker ps", "pai worker ps --all", "pai worker ps --panes"],
  seeAlso: ["pai worker follow", "pai worker pending", "pai worker kill"],
  run: (ctx) =>
    guard("pai worker ps --all", async () => {
      const dir = logDir();
      if (flag(ctx, "panes")) {
        out(renderPaneAudit(auditPanes(runningProcs(dir), loadRegistry(dir), await listItermTabs())));
        return;
      }
      const pending = pendingResults(dir, process.cwd()).length;
      if (pending) out(`${pending} unmerged result(s) — pai worker pending`);
      const left = leftoverWorktrees(dir);
      if (left) out(`worktrees: ${left} finished, not merged; pai worker gc --dry-run`);
      out(psOutput(dir, flag(ctx, "all")));
    }),
};

const usageCommand: CommandDef = {
  name: "usage",
  summary: "Token totals per provider and model for a set of workers",
  description:
    "Sums the exact tokens of the selected workers per provider and model: input, cache read, cache write 5m and 1h, output, plus the reported cost. A run's result event is authoritative when it carries totals; otherwise the assistant messages are summed (killed runs). Local providers are marked and carry no cost. " +
    "This is the worker side of the A/B comparison; the top session's side is `pai audit tokens usage`.",
  options: [
    { name: "label", type: "string", value: "PREFIX", summary: "Only workers whose label starts with PREFIX" },
    { name: "since", type: "string", value: "WHEN", summary: "Only workers started at or after WHEN (ISO time, or 1h / 30m)" },
    { name: "until", type: "string", value: "WHEN", summary: "Only workers started at or before WHEN (ISO time, or 1h / 30m)" },
    OPT.json,
  ],
  examples: ["pai worker usage --since 2h", "pai worker usage --label armA --since 2026-10-18T06:00:00 --json"],
  seeAlso: ["pai audit tokens usage", "pai worker ps"],
  run: (ctx) =>
    guard("pai worker ps", () => {
      const { workers } = readWorkersSection();
      const baseUrls = Object.fromEntries(Object.entries(workers.providers).map(([k, v]) => [k, v.baseUrl]));
      const rep = workerUsage(
        logDir(),
        {
          labelPrefix: str(ctx.opts.label),
          since: str(ctx.opts.since) ? parseWhen(str(ctx.opts.since)!) : undefined,
          until: str(ctx.opts.until) ? parseWhen(str(ctx.opts.until)!) : undefined,
        },
        baseUrls
      );
      const help = readHelpLedger(logDir());
      out(
        flag(ctx, "json")
          ? JSON.stringify({ ...(usageJson(rep) as object), help }, null, 2)
          : renderUsage(rep, { workers: true }) + (help.length ? `\n\nhelp calls:\n${renderHelpReport(help)}` : "")
      );
    }),
};

const followCommand: CommandDef = {
  name: "follow",
  summary: "Watch a worker live, or all running workers",
  description: "Live view of one worker's transcript, or of every running worker in this session. Ctrl-C leaves it.",
  args: [{ name: "ID", summary: "Worker id (default: all running workers of this session)" }],
  options: [
    { name: "all", type: "boolean", summary: "Follow the workers of all sessions" },
    { name: "auto-exit", type: "number", value: "SECS", optionalValue: true, summary: "Leave SECS seconds after the workers end (default from the config)" },
    { name: "live", type: "boolean", summary: "Stream even without a terminal (default there: print the tail and exit)" },
    { name: "tail", type: "number", value: "N", summary: "Entries printed when there is no terminal (default 20)" },
  ],
  examples: ["pai worker follow", "pai worker follow w-20260101-abc", "pai worker follow --all --auto-exit 10"],
  seeAlso: ["pai worker ps", "pai worker replay", "pai worker pane"],
  run: (ctx) =>
    guard("pai worker ps", async () => {
      const { workers } = readWorkersSection();
      const ae = ctx.opts["auto-exit"];
      const autoExit = ae === undefined || ae === false ? 0 : ae === true ? workers.pane.autoExitSecs : Number(ae);
      const target = (ctx.args.ID as string | undefined) ?? null;
      if (target && isPaneRunId(target)) {
        if (!flag(ctx, "live") && !process.stdout.isTTY) out(readFileSync(loadPaneRunStatus(logDir(), target)?.log ?? "", "utf8").split("\n").slice(-(num(ctx.opts.tail) ?? 40)).join("\n"));
        else await followPaneRun(logDir(), target, (t) => void process.stdout.write(t));
        return;
      }
      if (target?.startsWith("plan-")) {
        if (!flag(ctx, "live") && (process.env.PAI_WORKER === "1" || !process.stdout.isTTY)) out(planLogTail(logDir(), target, num(ctx.opts.tail) ?? 40));
        else {
          await followPlanLog(logDir(), target, (t) => void process.stdout.write(t), () => planRunEnded(logDir(), target));
        }
        return;
      }
      const tailText = followTailOutput(logDir(), target, {
        live: flag(ctx, "live"),
        autoExit: ae !== undefined && ae !== false,
        tail: num(ctx.opts.tail),
      });
      if (tailText !== null) {
        out(tailText);
        return;
      }
      await followWorkers(logDir(), target, flag(ctx, "all"), autoExit);
    }),
};

const replayCommand: CommandDef = {
  name: "replay",
  summary: "Print the transcript of one worker",
  description: "Shows what a finished or running worker did, from its recorded events.",
  args: [{ name: "ID", required: true, summary: "Worker id (see `pai worker ps`)" }],
  options: [{ name: "tail", type: "number", value: "N", summary: "Only the last N lines" }],
  examples: ["pai worker replay w-20260101-abc", "pai worker replay w-20260101-abc --tail 40"],
  seeAlso: ["pai worker follow", "pai worker log"],
  run: (ctx) =>
    guard("pai worker ps", () => {
      out(replayOutput(logDir(), ctx.args.ID as string, process.stdout.isTTY === true, num(ctx.opts.tail)));
    }),
};

const watchCommand: CommandDef = {
  name: "watch",
  summary: "Worker list that refreshes every 2 seconds",
  description: "Runs `pai worker ps --all` again every 2 seconds with the system `watch` program. Ctrl-C leaves it.",
  examples: ["pai worker watch", "pai worker ps --all"],
  seeAlso: ["pai worker ps", "pai worker follow"],
  run: () =>
    new Promise<number>((resolve, reject) => {
      const proc = spawn("watch", ["-n", "2", "pai worker ps --all"], { stdio: "inherit" });
      proc.on("error", (e) => reject(new CliError(`cannot run watch: ${e.message}`, "pai worker ps --all")));
      proc.on("close", (code) => resolve(code ?? 1));
    }),
};

const paneCommand: CommandDef = {
  name: "pane",
  summary: "Open a window pane that follows a worker",
  description:
    "Opens the follow pane for a worker: a tmux split when you are in tmux, else an iTerm2 pane on macOS, else it prints the follow command to run yourself.",
  args: [{ name: "ID", summary: "Worker id (default: all running workers)" }],
  options: [
    { name: "check", type: "boolean", summary: "Only report whether the pane is open, with its profile file, font and window bounds" },
    { name: "close-ended", type: "boolean", summary: "Close every open pane whose worker has ended" },
    { ...OPT.dryRun, summary: "With --close-ended: only list what would be closed" },
  ],
  examples: ["pai worker pane", "pai worker pane w-20260101-abc --check", "pai worker pane --close-ended --dry-run"],
  seeAlso: ["pai worker follow", "pai worker ps"],
  run: (ctx) =>
    guard("pai worker follow", async () => {
      const { workers } = readWorkersSection();
      const dir = logDir();
      if (flag(ctx, "close-ended")) {
        const r = await closeEndedPanes(
          dir,
          (wid) => {
            const st = loadStatus(dir, wid);
            return st !== null && st.state !== "running" && st.state !== "queued";
          },
          ctx.dryRun
        );
        for (const l of r.closed) out(`${ctx.dryRun ? "would close" : "closed"} ${l}`);
        for (const l of r.kept) out(`kept ${l}`);
        if (!r.closed.length) out("no ended worker panes open");
        return;
      }
      const host = await resolveHostSession();
      const term = host.term;
      process.stderr.write((host.via === "none" ? `host session: none (${host.reason})` : `host session: ${host.uid} via ${host.via}`) + "\n");
      const id = ctx.args.ID as string | undefined;
      if (id) {
        out(flag(ctx, "check") ? await checkPaneForWorker(id, workers.pane.fontSize, term) : (await openPaneForWorker(dir, workers, id, term)).message);
      } else {
        out(await openFollowPane(dir, workers, term, flag(ctx, "check")));
      }
    }),
};

const logCommand: CommandDef = {
  name: "log",
  summary: "Worker ledger or the raw events of one worker",
  description: "No argument lists the worker logs. `all` prints the whole ledger, `tail` its last 20 lines, a worker id its last 30 raw events.",
  args: [{ name: "WHAT", summary: "all, tail, or a worker id (default: list the logs)" }],
  examples: ["pai worker log", "pai worker log tail", "pai worker log w-20260101-abc"],
  seeAlso: ["pai worker replay", "pai worker errors"],
  run: (ctx) =>
    guard("pai worker log   (lists the logs)", () => {
      const dir = logDir();
      const what = ctx.args.WHAT as string | undefined;
      const ledger = ledgerPath(dir);
      if (what === "all") return void out(existsSync(ledger) ? readFileSync(ledger, "utf8") : dim("(no ledger yet)"));
      if (what === "tail") {
        if (!existsSync(ledger)) return void out(dim("(no ledger yet)"));
        return void out(readFileSync(ledger, "utf8").trim().split("\n").slice(-20).join("\n"));
      }
      if (what) {
        const path = eventsPath(dir, what);
        if (!existsSync(path)) throw new Error(`no event log for ${what}`);
        return void out(readFileSync(path, "utf8").trim().split("\n").slice(-30).join("\n"));
      }
      if (!existsSync(dir)) return void out(dim("(no workers yet)"));
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
        const st = statSync(`${dir}/${f}`);
        out(`  ${f.replace(".jsonl", "")}  ${(st.size / 1024 / 1024).toFixed(1)} MB  ${st.mtime.toISOString().slice(0, 19).replace("T", " ")}`);
      }
    }),
};

const errorsCommand: CommandDef = {
  name: "errors",
  summary: "Tool errors workers hit, grouped by kind",
  description: "Counts the errors workers ran into, with numbers and paths removed so equal errors group together.",
  options: [{ name: "since", type: "string", value: "AGE", default: "24h", summary: "Only errors newer than this, e.g. 30m, 2h, 1d" }],
  examples: ["pai worker errors", "pai worker errors --since 2h"],
  seeAlso: ["pai worker log"],
  run: (ctx) =>
    guard("pai worker errors --since 24h", async () => {
      const { errorsTable, groupToolErrors, parseSince, readToolErrors } = await import("../../workers/tool-errors.js");
      const since = str(ctx.opts.since) ?? "24h";
      const ms = parseSince(since);
      if (ms === null) throw new Error(`bad --since "${since}" (use 30m, 2h, 1d)`);
      out(errorsTable(groupToolErrors(readToolErrors(logDir(), Date.now() - ms))));
    }),
};

const statusLineCommand: CommandDef = {
  name: "status-line",
  summary: "One-line worker summary for a status bar",
  description:
    "Prints nothing when no worker is in scope. Called by the status line script with the terminal session id, the pane's directory and the Claude session id (which claims the workers that session's shell started).",
  args: [
    { name: "TERM", summary: "Terminal session id (default: $ITERM_SESSION_ID)" },
    { name: "CWD", summary: "Directory of the pane (default: here)" },
    { name: "SESSION", summary: "Claude session id" },
  ],
  examples: ["pai worker status-line", "pai worker status-line \"$ITERM_SESSION_ID\" \"$PWD\" ''"],
  seeAlso: ["pai worker ps"],
  run: (ctx) =>
    guard("pai worker ps", () => {
      const line = statusLineOutput(
        logDir(),
        (ctx.args.TERM as string | undefined) ?? process.env.ITERM_SESSION_ID ?? "",
        (ctx.args.CWD as string | undefined) ?? process.cwd(),
        (ctx.args.SESSION as string | undefined) ?? "",
        new Date()
      );
      if (line) out(line);
    }),
};

// ---------------------------------------------------------------------------
// Talking to workers
// ---------------------------------------------------------------------------

const sayCommand: CommandDef = {
  name: "say",
  summary: "Send a message to a running worker",
  description: "The message goes to the worker's open input, as if you had typed it in its pane. Prints ok.",
  args: [
    { name: "ID", required: true, summary: "Worker id (see `pai worker ps`)" },
    { name: "TEXT", required: true, summary: "The message" },
  ],
  options: [{ name: "goal", type: "string", value: "TEXT", summary: "Record a goal note shown in ps (the label stays) before sending" }],
  examples: ["pai worker say w-20260101-abc 'Also cover the empty case'", "pai worker say w-20260101-abc 'Go on' --goal 'finish the export'"],
  seeAlso: ["pai worker goal", "pai worker resume"],
  run: (ctx) =>
    guard("pai worker ps", async () => {
      const dir = logDir();
      const goal = str(ctx.opts.goal);
      if (goal !== undefined) setWorkerNote(dir, ctx.args.ID as string, goal);
      await sayToWorker(dir, ctx.args.ID as string, ctx.args.TEXT as string);
      out("ok");
    }),
};

const goalCommand: CommandDef = {
  name: "goal",
  summary: "Leave a goal note on a running worker",
  description: "Records a note shown under the worker's task in ps; the label is not changed and no message is sent. Prints ok.",
  args: [
    { name: "ID", required: true, summary: "Worker id (see `pai worker ps`)" },
    { name: "TEXT", required: true, summary: "The note" },
  ],
  examples: ["pai worker goal w-20260101-abc 'fix the retry loop'", "pai worker goal w-20260101-abc 'review the export tests'"],
  seeAlso: ["pai worker say", "pai worker ps"],
  run: (ctx) =>
    guard("pai worker ps", () => {
      setWorkerNote(logDir(), ctx.args.ID as string, ctx.args.TEXT as string);
      out("ok");
    }),
};

const handoffCommand: CommandDef = {
  name: "handoff",
  summary: "From inside a worker: pass a question or result to its parent",
  description:
    'Adds a message to the parent\'s inbox and, when the parent is running, says it to the parent. The payload is JSON: {"kind":"proposal|question|blocker","text":"...","data":{...}}. Sender and receiver come from the environment.',
  args: [{ name: "JSON", required: true, summary: "The payload as JSON" }],
  examples: [
    `pai worker handoff '{"kind":"question","text":"Which branch should I target?"}'`,
    `pai worker handoff '{"kind":"blocker","text":"Tests need a database","data":{"table":"users"}}'`,
  ],
  seeAlso: ["pai worker say"],
  run: (ctx) =>
    guard("pai worker handoff '{\"kind\":\"question\",\"text\":\"...\"}'", async () => {
      const json = ctx.args.JSON as string;
      let payload: unknown;
      try {
        payload = JSON.parse(json);
      } catch {
        throw new Error(`payload is not JSON: ${json}`);
      }
      const h = await handoffFromInside(logDir(), process.env, payload);
      out(`ok → ${h.to} (${h.kind}); inbox ${h.to}.inbox.jsonl`);
    }),
};

const helpCommand: CommandDef = {
  name: "help",
  summary: "From inside a worker: ask a stronger model to do one sub-task (budgeted)",
  description:
    "Runs a bounded sub-worker (class implement, in place, 20 minutes at most) on a stronger provider and prints its report and the files it changed. " +
    "Each orchestrated unit gets a small budget of help calls (default 2, PAI_HELP_BUDGET); past it the verb exits 4 and you report the blocker instead. " +
    "Every call is recorded in help-ledger.jsonl; --report lists them.",
  options: [
    { name: "task", type: "string", value: "TEXT", summary: "The one-paragraph sub-task" },
    { name: "provider", type: "string", value: "NAME", summary: "Provider to ask (default anthropic)" },
    { name: "model", type: "string", value: "NAME", summary: "Model to ask (default sonnet)" },
    { name: "files", type: "string", value: "A,B", summary: "Files the sub-task concerns, comma-separated" },
    { name: "report", type: "boolean", summary: "List the recorded help calls instead of asking" },
    { name: "scope", type: "string", value: "ID", summary: "With --report: only this unit" },
  ],
  examples: [
    "pai worker help --task 'Rewrite the retry loop in src/net.ts to back off exponentially' --files src/net.ts",
    "pai worker help --report --scope 20261018-0301-1",
  ],
  seeAlso: ["pai worker handoff", "pai worker usage"],
  run: (ctx) =>
    guard("pai worker help --task '<sub-task>'", async () => {
      if (flag(ctx, "report")) {
        out(renderHelpReport(readHelpLedger(logDir(), str(ctx.opts.scope))));
        return;
      }
      const task = str(ctx.opts.task)?.trim();
      if (!task) throw new Error("--task is required");
      const res = await requestHelp(
        logDir(),
        {
          task,
          provider: str(ctx.opts.provider) ?? "anthropic",
          model: str(ctx.opts.model) ?? "sonnet",
          files: (str(ctx.opts.files) ?? "").split(",").map((f) => f.trim()).filter(Boolean),
          cwd: process.cwd(),
        },
        { spawnWorker: spawnPaiWorker, changedFiles: gitChangedFiles, now: Date.now }
      );
      if (res.refused) throw new CliError(res.message, undefined, HELP_REFUSED_EXIT);
      out(res.text);
      return res.ok ? 0 : 1;
    }),
};

// ---------------------------------------------------------------------------
// Taking the work back
// ---------------------------------------------------------------------------

const mergeCommand: CommandDef = {
  name: "merge",
  summary: "Merge a worker's branch into your checkout",
  description:
    "Merges branch worker/ID into the original checkout, then removes the worktree and deletes the branch. With --verify (or the workers.yaml `merge.verify` default, which --verify overrides and --no-verify skips) the command runs on the merged tree first; if it exits non-zero the merge is reverted (git revert, never reset), the branch and worktree are kept, and the exit code is 1. A built-in stub scan always runs after the merge: added lines under src/ matching `TODO: implement`, `Promise.resolve(0) // TODO` or `throw new Error(\"not implemented` revert the merge the same way.",
  args: [{ name: "ID", required: true, summary: "Worker id (see `pai worker pending`)" }],
  options: [
    { name: "no-commit", type: "boolean", summary: "Apply the changes uncommitted; keep branch and worktree" },
    { name: "patch", type: "boolean", summary: "Same as --no-commit" },
    { name: "verify", type: "string", value: "CMD", summary: "Run CMD after the merge; revert the merge when it fails (default: workers.yaml merge.verify)" },
    { name: "no-verify", type: "boolean", summary: "Skip the configured merge.verify default (prints a warning)" },
  ],
  examples: [
    "pai worker merge w-20260101-abc",
    "pai worker merge w-20260101-abc --no-commit",
    'pai worker merge 20261018-0301-1 --verify "npx tsc --noEmit"',
  ],
  seeAlso: ["pai worker verify", "pai worker pending", "pai worker discard"],
  run: (ctx) =>
    guard("pai worker pending", () => {
      let verify = str(ctx.opts.verify);
      if (verify === undefined) {
        const configured = readMergeVerify();
        if (flag(ctx, "no-verify")) {
          if (configured) out(`warning: --no-verify skips the configured merge.verify gate (${configured})`);
        } else verify = configured;
      }
      out(mergeWorker(logDir(), ctx.args.ID as string, { noCommit: flag(ctx, "no-commit") || flag(ctx, "patch"), verify }));
    }),
};

const verifyCommand: CommandDef = {
  name: "verify",
  summary: "Check that a worker's changes are already in your checkout",
  description:
    "Compares what the worker committed with the working tree (or --against a ref). Exit 0 when every file is identical, so discarding is safe; exit 1 otherwise. Also reads archived workers.",
  args: [{ name: "ID", required: true, summary: "Worker id" }],
  options: [
    { name: "against", type: "string", value: "REF", summary: "Compare against this git ref instead of the working tree" },
    { ...OPT.json, summary: "Print the result as JSON" },
  ],
  examples: ["pai worker verify w-20260101-abc", "pai worker verify w-20260101-abc --against main --json"],
  seeAlso: ["pai worker merge", "pai worker discard"],
  run: (ctx) =>
    guard("pai worker pending", () => {
      const r = verifyWorker(logDir(), ctx.args.ID as string, { against: str(ctx.opts.against) });
      if (flag(ctx, "json")) out(JSON.stringify(r, null, 2));
      else {
        for (const f of r.files) out(`${f.state.padEnd(9)} ${f.path}`);
        out(`${r.ok ? "all identical" : "not applied"} (${r.files.length} file(s), ${r.ref} vs ${r.against})`);
      }
      return r.ok ? 0 : 1;
    }),
};

const pendingCommand: CommandDef = {
  name: "pending",
  summary: "Finished workers whose work is not merged yet",
  description:
    "Lists workers whose branch or worktree holds work that is not in this repository. With --gate it works as a release check: exit 1 with the list unless PAI_ALLOW_PENDING=1.",
  options: [
    { name: "all", type: "boolean", summary: "Every repository, not just this one" },
    { ...OPT.json, summary: "Machine-readable output" },
    { name: "gate", type: "boolean", summary: "Release check: exit 1 with the list unless PAI_ALLOW_PENDING=1" },
  ],
  examples: ["pai worker pending", "pai worker pending --all --json", "pai worker pending --gate"],
  seeAlso: ["pai worker merge", "pai worker discard"],
  run: (ctx) =>
    guard("pai worker ps", () => {
      const res = pendingResults(logDir(), flag(ctx, "all") ? undefined : process.cwd());
      if (flag(ctx, "gate")) {
        const g = pendingGate(res);
        if (g.message) process.stderr.write(g.message + "\n");
        return g.code;
      }
      if (flag(ctx, "json")) out(JSON.stringify(res, null, 2));
      else out(res.length ? formatPending(res, flag(ctx, "all")) : "no pending worker results");
    }),
};

const discardCommand: CommandDef = {
  name: "discard",
  summary: "Throw away a worker's branch and worktree",
  description: "Removes the worktree and branch of a worker and keeps nothing. Use `verify` first if you are unsure.",
  args: [{ name: "ID", required: true, summary: "Worker id" }],
  examples: ["pai worker discard w-20260101-abc", "pai worker verify w-20260101-abc && pai worker discard w-20260101-abc"],
  seeAlso: ["pai worker verify", "pai worker merge", "pai worker gc"],
  run: (ctx) =>
    guard("pai worker pending", () => {
      out(discardWorker(logDir(), ctx.args.ID as string));
    }),
};

const gcCommand: CommandDef = {
  name: "gc",
  summary: "Archive leftover worker worktrees",
  description: "Moves old finished workers' worktrees into refs/pai-archive/ID. Before a worktree is removed, gitignored knowledge files (Notes/ and the like; not node_modules, dist, coverage, logs) are copied into the main checkout; a worktree that cannot be salvaged is kept. --dry-run prints what each worktree carries.",
  options: [
    { name: "older-than", type: "string", value: "HOURS", default: "24", summary: "Minimum age of a finished worker, in hours" },
    { name: "all-finished", type: "boolean", summary: "Any finished worker, regardless of age" },
    { ...OPT.dryRun, summary: "Print what would be archived and what each worktree carries, change nothing" },
  ],
  examples: ["pai worker gc --dry-run", "pai worker gc --older-than 72", "pai worker gc --all-finished"],
  seeAlso: ["pai worker discard", "pai worker pending"],
  run: (ctx) =>
    guard("pai worker gc --dry-run", () => {
      const raw = str(ctx.opts["older-than"]) ?? "24";
      const hours = Number(raw);
      if (!Number.isFinite(hours) || hours < 0) throw new Error(`bad --older-than "${raw}"`);
      const res = gcWorktrees(logDir(), flag(ctx, "all-finished") ? 0 : hours, ctx.dryRun, Date.now(), true);
      const verb = ctx.dryRun ? "would archive" : "archived";
      for (const r of res) {
        out(r.skipped ? `skipped ${r.id}: ${r.skipped}` : `${verb} ${r.id} -> ${r.archive}`);
        if (r.adopted) out(`  adopted detached HEAD ${r.adopted.slice(0, 7)}`);
        if (ctx.dryRun && r.knowledge) {
          const k = formatKnowledge(r.knowledge);
          for (const l of k.length ? k : ["carries nothing"]) out(`  ${l}`);
        }
      }
      const done = res.filter((r) => r.archive);
      const kept = res.filter((r) => r.skipped);
      const files = done.reduce((n, r) => n + (r.salvaged?.filter((l) => l.startsWith("salvaged ")).length ?? 0), 0);
      out(
        `${done.length} ${ctx.dryRun ? "would be archived" : "archived"}, salvaged ${files} file(s), kept ${kept.length}` +
          (kept.length ? ` (${kept.map((r) => `${r.id}: ${r.skipped}`).join("; ")})` : "")
      );
    }),
};

const killCommand: CommandDef = {
  name: "kill",
  summary: "Stop a running worker",
  description: "Stops the worker and every live descendant (the tree `pai worker ps` draws), leaves first: SIGTERM, then SIGKILL if a process outlives it. Each saves its final state. A session may only kill workers it started (another session's worker is refused; --force overrides from the operator's terminal). A worker whose process id has been reused by something else is marked lost and nothing is signalled. --only stops just this worker.",
  args: [{ name: "ID", required: true, summary: "Worker id (see `pai worker ps`)" }],
  options: [
    { name: "only", type: "boolean", summary: "Kill only this worker, leave its children running" },
    { name: "force", type: "boolean", summary: "Kill another session's worker (operator's terminal only, not from a worker); logged as forced" },
  ],
  examples: ["pai worker kill w-20260101-abc", "pai worker ps   (find the id first)"],
  seeAlso: ["pai worker ps"],
  run: (ctx) =>
    guard("pai worker ps", async () => {
      const id = ctx.args.ID as string;
      const dir = logDir();
      const status = loadStatus(dir, id);
      if (!status) throw new Error(`no worker named "${id}"`);
      if (status.state !== "running" && status.state !== "queued")
        throw new Error(`worker ${id} is not running (state: ${status.state})`);
      if (!status.pid || status.pid <= 0) throw new Error(`worker ${id} has no pid recorded`);
      for (const line of await killTree(dir, id, { only: ctx.opts.only === true, caller: { env: process.env, force: ctx.opts.force === true } })) out(line);
    }),
};

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

const waitOnCommand: CommandDef = {
  name: "wait-on",
  summary: "Wait for a background job to finish",
  description:
    "Waits at most --max seconds (default 110, limit 590; over ~110 s needs the Bash tool timeout raised, which the PAI hook does automatically) for a process id. Exit 0: it is gone. Exit 3: still running, call again. Exit 2: it never existed. Exit 4: killed by the ceiling or stall rule (its whole process tree gets SIGTERM, SIGKILL after 5 s; likely a hang or infinite loop). A `pai worker run` target still queued behind its provider cap is not stall-killed (the queue prints a heartbeat at least every 60 s), and the ceiling counts from when it left the queue.\n" +
    "Recipe: nohup sh -c 'CMD; echo $? > /tmp/job.rc' > /tmp/job.log 2>&1 & echo $! > /tmp/job.pid, then repeat `pai worker wait-on $(cat /tmp/job.pid) --log /tmp/job.log` until it exits 0.",
  args: [{ name: "PID", required: true, summary: "Process id of the job" }],
  options: [
    { name: "log", type: "string", value: "FILE", summary: "Log file whose last lines are printed on return; FILE.rc holds the exit code" },
    { name: "max", type: "number", value: "SECS", summary: "Longest wait in seconds (default 110, limit 590; over ~110 s needs the Bash tool timeout raised, which the PAI hook does automatically)" },
    { name: "tail", type: "number", value: "N", summary: "Log lines printed on return (default 20)" },
    { name: "max-minutes", type: "number", value: "N", summary: "Hard ceiling on the process's age (default 30; a queued worker run counts from leaving the queue): still alive then = kill its process tree, exit 4" },
    { name: "stall-minutes", type: "number", value: "N", summary: "With --log: log silent this long while alive (default 5) = kill its process tree, exit 4" },
  ],
  examples: ["pai worker wait-on 12345", "pai worker wait-on $(cat /tmp/job.pid) --log /tmp/job.log --max 60"],
  seeAlso: ["pai worker wait", "pai worker wait-url", "pai worker wait-file"],
  run: (ctx) =>
    guard("pai worker wait-on <pid>", async () => {
      const wid = currentWorkerId(process.env, logDir());
      const mark = wid ? statusMarker(logDir(), wid) : undefined;
      // a killed wait-on must not leave a stale waitingOn behind
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.once(sig, () => {
          mark?.(null);
          process.exit(128 + (sig === "SIGINT" ? 2 : 15));
        });
      }
      return await waitOn(
        { pid: Number(ctx.args.PID), log: str(ctx.opts.log), maxSecs: num(ctx.opts.max), tail: num(ctx.opts.tail), maxMinutes: num(ctx.opts["max-minutes"]), stallMinutes: num(ctx.opts["stall-minutes"]) },
        { ...waitOnDeps, mark, queue: statusQueue(logDir()) }
      );
    }),
};

const waitCommand: CommandDef = {
  name: "wait",
  summary: "Wait for child workers; returns when any finishes or --max elapses",
  description:
    "Prints one JSON status line per worker id and returns within --max seconds (default 100, limit 590; over ~110 s needs the Bash tool timeout raised, which the PAI hook does automatically) as soon as ANY of them finishes. Exit 0: all done. Exit 1: a finished worker failed. Exit 3: some still running, call again with the unfinished ids.\n" +
    "Use this instead of sleeping and re-checking `pai worker ps`. --timeout keeps the old behaviour: wait for ALL, exit 1 on timeout (the same code as a failed worker; a timed-out worker's JSON has \"state\":\"running\", \"timedOut\":true and no \"ok\", and stderr says the worker is not affected).",
  args: [{ name: "IDS", required: true, variadic: true, summary: "One or more worker ids" }],
  options: [
    { name: "max", type: "number", value: "SECS", summary: "Longest wait in seconds (default 100, limit 590; over ~110 s needs the Bash tool timeout raised, which the PAI hook does automatically)" },
    { name: "timeout", type: "number", value: "SECS", summary: "Wait for ALL workers, give up after this many seconds (exit 1)" },
  ],
  examples: ["pai worker wait w-20260101-abc", "pai worker wait w-20260101-abc w-20260101-def --max 60"],
  seeAlso: ["pai worker ps", "pai worker wait-on", "pai worker wait-url", "pai worker wait-file"],
  run: (ctx) =>
    guard("pai worker ps", () =>
      runWait(logDir(), ctx.args.IDS as string[], { max: num(ctx.opts.max), timeout: num(ctx.opts.timeout) }, out, (l) =>
        process.stderr.write(err(l) + "\n")
      )
    ),
};

const waitUrlCommand: CommandDef = {
  name: "wait-url",
  summary: "Wait for a server to answer HTTP",
  description:
    "Polls the URL with backoff for at most --max seconds (default 100, limit 590; over ~110 s needs the Bash tool timeout raised, which the PAI hook does automatically). Exit 0: it answered 2xx-4xx. Exit 3: not yet, call again.",
  args: [{ name: "URL", required: true, summary: "e.g. http://127.0.0.1:8016/v1/models" }],
  options: [{ name: "max", type: "number", value: "SECS", summary: "Longest wait in seconds (default 100, limit 590; over ~110 s needs the Bash tool timeout raised, which the PAI hook does automatically)" }],
  examples: ["pai worker wait-url http://127.0.0.1:8016/v1/models", "pai worker wait-url http://127.0.0.1:8016/v1/models --max 60"],
  seeAlso: ["pai worker wait", "pai worker wait-on", "pai worker wait-file"],
  run: (ctx) => guard("pai worker wait-url <url>", () => waitUrl({ url: String(ctx.args.URL), maxSecs: num(ctx.opts.max) }, { ...realProbeDeps, out })),
};

const testRunCommand: CommandDef = {
  name: "test-run",
  summary: "Run a test command; when it goes silent, say where it is stuck",
  description:
    "Runs the command (after --) with Node diagnostic reports enabled and passes its output through. When it prints nothing for --idle seconds (default 60, or 8 s before a `timeout N` in the command), every node process under it gets SIGUSR2 and the reports' javascriptStack is printed as the file:line the main thread is stuck in; an empty stack means an async wait. A synchronous infinite loop blocks the runner's own timeout, so without this a hung run shows nothing. Worker test commands (vitest, jest, node --test, npm test) are routed through it by the PAI guard. Exit code is the command's.",
  allowUnknown: true,
  options: [{ name: "idle", type: "number", value: "SECS", summary: `Silence after which the probe fires (default ${DEFAULT_IDLE_SECS})` }],
  examples: ["pai worker test-run -- npx vitest run src/parse.test.ts", "pai worker test-run --idle 20 -- timeout 120 npm test"],
  seeAlso: ["pai worker wait-on"],
  run: (ctx) =>
    guard("pai worker test-run -- <command>", async () => {
      const words = ctx.rest[0] === "--" ? ctx.rest.slice(1) : ctx.rest;
      if (!words.length) throw new CliError("no command given", "pai worker test-run -- npx vitest run <file>");
      const code = await runProbed({
        command: words.join(" "),
        cwd: process.cwd(),
        reportDir: join(logDir(), "reports"),
        idleSecs: num(ctx.opts.idle),
      });
      return code;
    }),
};

const waitFileCommand: CommandDef = {
  name: "wait-file",
  summary: "Wait for files to appear",
  description:
    "Waits at most --max seconds (default 100, limit 590; over ~110 s needs the Bash tool timeout raised, which the PAI hook does automatically) until every path exists; prints one line per path. Exit 0: all exist. Exit 3: some missing, call again.",
  args: [{ name: "PATHS", required: true, variadic: true, summary: "One or more file paths" }],
  options: [{ name: "max", type: "number", value: "SECS", summary: "Longest wait in seconds (default 100, limit 590; over ~110 s needs the Bash tool timeout raised, which the PAI hook does automatically)" }],
  examples: ["pai worker wait-file /tmp/job.rc", "pai worker wait-file /tmp/a.rc /tmp/b.rc --max 60"],
  seeAlso: ["pai worker wait", "pai worker wait-on", "pai worker wait-url"],
  run: (ctx) =>
    guard("pai worker wait-file <path...>", () => waitFile({ paths: ctx.args.PATHS as string[], maxSecs: num(ctx.opts.max) }, { ...realProbeDeps, out })),
};

// ---------------------------------------------------------------------------
// Which model, which provider
// ---------------------------------------------------------------------------

const modelCommand: CommandDef = {
  name: "model",
  summary: "Show or set the model a provider uses",
  description:
    "No arguments lists the models of every provider.\n" +
    "`model MODEL-ID` sets the default model of the active provider.\n" +
    "`model CAPABILITY` shows one capability (default, fast, image, ...); `model CAPABILITY MODEL-ID` sets it.\n" +
    "`pai worker capability` chooses which provider serves a capability.",
  args: [
    { name: "WHAT", summary: "A capability name, or a model id to set as default" },
    { name: "MODEL", summary: "Model id to set for that capability" },
  ],
  options: [
    { ...OPT.provider, summary: "Provider to read or change (default: the active one)" },
    { name: "capability", type: "string", value: "NAME", summary: "Capability to show or set, with the model id as the only argument" },
  ],
  examples: ["pai worker model", "pai worker model fast", "pai worker model fast glm-fast --provider glm"],
  seeAlso: ["pai worker capability", "pai providers"],
  run: (ctx) =>
    guard("pai worker model", () => {
      const { workers } = readWorkersSection();
      let what = ctx.args.WHAT as string | undefined;
      let model = ctx.args.MODEL as string | undefined;
      const cap = str(ctx.opts.capability);
      const provider = str(ctx.opts.provider);
      if (cap !== undefined) {
        if (!isModelCapability(cap)) throw new WorkersConfigError(`"${cap}" is not a valid capability name`);
        if (model !== undefined) throw new WorkersConfigError("with --capability pass only a model id");
        model = what;
        what = cap;
      }
      if (what === undefined) {
        for (const line of describeModels(workers)) out(`  ${line}`);
        return;
      }
      let capability: ModelCapability = "default";
      let id = what;
      if (isModelCapability(what)) {
        capability = what;
        if (model === undefined) {
          const name = resolveProviderName(workers, provider);
          const p = getProviderOrNative(workers, name);
          if (p) out(`  ${name} ${capability} ${p.models[capability] ?? "(none)"}`);
          return;
        }
        id = model;
      } else if (model !== undefined) {
        throw new WorkersConfigError(`unexpected second argument "${model}" — usage: model [<capability>] <model-id>`);
      }
      const name = resolveProviderName(workers, provider);
      const fresh = setProviderModel(name, capability, id);
      const p = getProviderOrNative(fresh, name);
      if (p) {
        out(ok(`${name} ${capability} model: ${p.models[capability]}`));
        out(dim(`  ${modelPrefsText(p)}`));
      }
    }),
};

const capabilityCommand: CommandDef = {
  name: "capability",
  summary: "Choose which provider serves a capability (e.g. image)",
  description:
    "No arguments lists every preference and what it resolves to now. `capability NAME PROVIDER[,PROVIDER...]` sets the list (the first usable one wins); `capability NAME --unset` removes it.\n" +
    "A provider of kind image preferred for \"image\" is what `pai worker run --capability image` calls.",
  args: [
    { name: "NAME", summary: "Capability name, e.g. image" },
    { name: "PROVIDERS", summary: "Provider names, comma-separated, best first" },
  ],
  options: [
    { name: "unset", type: "boolean", summary: "Remove the preference for NAME" },
    { ...OPT.json, summary: "Machine-readable output" },
  ],
  examples: ["pai worker capability", "pai worker capability image imagegen,backup", "pai worker capability image --unset"],
  seeAlso: ["pai worker model", "pai worker run"],
  run: (ctx) =>
    guard("pai worker capability", () => {
      const name = ctx.args.NAME as string | undefined;
      const providers = ctx.args.PROVIDERS as string | undefined;
      if (name === undefined) {
        const { workers } = readWorkersSection();
        const lines = describeCapabilities(workers);
        if (flag(ctx, "json")) out(JSON.stringify(lines));
        else for (const line of lines) out(`  ${line}`);
        return;
      }
      if (flag(ctx, "unset")) {
        unsetCapabilityPreference(name);
        out(ok(`removed the capability preference for "${name}"`));
        return;
      }
      if (providers === undefined) {
        throw new Error(`usage: pai worker capability ${name} <provider>[,<provider>…]  (or --unset to remove it)`);
      }
      const workers = setCapabilityPreference(name, providers.split(",").map((p) => p.trim()));
      const line = describeCapabilities(workers).find((l) => l.startsWith(`${name}:`));
      out(ok(`${name}: [${workers.capabilities[name]?.join(", ")}]`));
      if (line) out(`  -> ${line.split(" -> ")[1]}`);
    }),
};

// ---------------------------------------------------------------------------
// The provider capacity queue
// ---------------------------------------------------------------------------

/** Resolved cap per provider name, for the queue readers. */
export function providerCaps(workers: WorkersConfig): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const name of Object.keys(workers.providers)) out[name] = providerCap(workers, name);
  return out;
}

const queueCommand: CommandDef = {
  name: "queue",
  summary: "Show or reorder the workers waiting for a provider slot",
  description:
    "No arguments lists every worker parked behind a provider's concurrency cap, per provider in grant order (the order the capacity gate hands out slots in). " +
    "`queue next ID` makes a waiting worker run next (position 1; `front` is an alias), `queue up ID` moves it one place up. The running worker is not interrupted: there is no preemption, only the order of the waiting ones changes. " +
    "The waiting worker itself re-reads the order on its next poll, so a move takes effect within seconds.",
  args: [
    { name: "VERB", summary: "next (alias front) or up (default: list the queue)" },
    { name: "ID", summary: "Worker id to pull forward (with next/up)" },
  ],
  examples: ["pai worker queue", "pai worker queue next 20261019-142851-84910", "pai worker queue up 20261019-142851-84910"],
  seeAlso: ["pai worker ps", "pai worker kill"],
  run: (ctx) =>
    guard("pai worker queue", async () => {
      const verb = (ctx.args.VERB as string | undefined) ?? "list";
      const id = ctx.args.ID as string | undefined;
      const dir = logDir();
      const { workers } = readWorkersSection();
      if (verb === "list") {
        const rows = queueRows(dir, providerCaps(workers));
        if (!rows.length) {
          out("nothing waiting");
          return;
        }
        let prov = "";
        for (const r of rows) {
          if (r.provider !== prov) {
            prov = r.provider;
            out(`${prov}${r.cap !== undefined ? ` (cap ${r.cap})` : ""}:`);
          }
          const s = r.status;
          out(
            `  ${r.position}. ${r.id}` +
              (s ? `  ${s.label}  ${s.cwd.split("/").pop() ?? s.cwd}  waited ${r.since === undefined ? ageOf(s.updated) : ageOf(nowStamp(new Date(r.since)))}` : "") +
              `  position ${r.position} of ${r.queued}`
          );
        }
        return;
      }
      if (!id) throw new Error(`usage: pai worker queue ${verb} <id>`);
      const status = loadStatus(dir, id);
      if (!status) throw new Error(`no worker named "${id}"`);
      if (verb !== "next" && verb !== "front" && verb !== "up") throw new Error(`unknown queue verb "${verb}" (expected next or up)`);
      const order = reorderQueue(dir, status.provider, id, verb === "up" ? "up" : "front");
      out(`${id} is now position ${order.indexOf(id) + 1} of ${order.length} on ${status.provider}`);
    }),
};

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

export const workerCommand: CommandDef = {
  name: "worker",
  summary: "Run tasks on other providers: run, ps, follow, merge, ...",
  description:
    "Workers are Claude Code runs on a provider you chose (cheaper, faster or local) that do one task while you keep working.\n" +
    "Start one with `run`, watch it with `ps` or `follow`, then bring its work back with `merge`.",
  examples: ["pai worker run --class implement -p 'Fix the retry loop'", "pai worker ps", "pai worker merge w-20260101-abc"],
  seeAlso: ["pai providers", "pai help worker run"],
  subcommands: [
    runCommand,
    resumeCommand,
    psCommand,
    usageCommand,
    followCommand,
    replayCommand,
    watchCommand,
    paneCommand,
    logCommand,
    errorsCommand,
    statusLineCommand,
    sayCommand,
    goalCommand,
    handoffCommand,
    helpCommand,
    mergeCommand,
    verifyCommand,
    pendingCommand,
    discardCommand,
    gcCommand,
    killCommand,
    queueCommand,
    waitOnCommand,
    waitUrlCommand,
    waitFileCommand,
    testRunCommand,
    waitCommand,
    modelCommand,
    capabilityCommand,
  ],
};
