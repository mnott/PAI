/**
 * `pai worker` — the CLI face of the worker system.
 *
 * Thin: every command here is a wrapper over src/workers/*, which is also
 * what the MCP tools and the Agent hook call. Nothing in this file decides
 * routing, providers or rendering on its own.
 *
 * Layout mirrors the old glm tooling so the habits transfer:
 *
 *   pai worker run …        (glm / glm-run)
 *   pai worker ps           (glm-ps)
 *   pai worker follow       (glm-ps follow / watch)
 *   pai worker replay <id>  (glm-ps <id>)
 *   pai worker pane         (glm-ps pane)
 *   pai worker log          (glm-log)
 *
 * Plus the operator surface: say/resume for talking to workers, proxy for the
 * local Anthropic↔OpenAI translation, mcp for the allowlist workers may load.
 */

import type { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readWorkersSection, type WorkerProvider } from "../../../workers/config.js";
import { workersLogDir, eventsPath, ledgerPath } from "../../../workers/paths.js";
import { longInlinePromptHint, parseRunnerArgs } from "../../../workers/args.js";
import { runWorker } from "../../../workers/run.js";
import { runChain } from "../../../workers/chain.js";
import { readSpecPrompt, resolveSpecPath } from "../../../workers/specfile.js";
import { agentClaudeArgs, agentLabel, deriveLabel, loadAgent, modelToClass } from "../../../workers/agents.js";
import { followWorkers, psOutput, replayOutput, statusLineOutput } from "../../../workers/viewer.js";
import { openFollowPane, openPaneForWorker, checkPaneForWorker } from "../../../workers/pane.js";
import { installWorkers } from "../../../workers/install.js";
import { setWorkersEnabled } from "../../../workers/providers.js";
import { fallbackOn, fallbackOff, fallbackStatus, fallbackStatusText } from "../../../workers/fallback.js";
import { registerWorkerProviderCommands, registerWorkerClassCommands } from "./providers.js";
import { registerWorkerModelCommand } from "./model.js";
import { registerWorkerConfigCommands } from "./config.js";
import { loadStatus, saveStatus, setWorkerLabel, waitForTerminalStatus } from "../../../workers/status.js";
import { sayToWorker } from "../../../workers/operator.js";
import { handoffFromInside } from "../../../workers/handoff.js";
import { discardWorker, mergeWorker } from "../../../workers/worktree.js";
import { waitWorkers } from "../../../workers/wait.js";
import { describeMcp } from "../../../workers/mcp.js";
import { DEFAULT_PROXY_PORT, ensureProxyRunning, stopProxy } from "../../../workers/proxy/server.js";
import { err, dim } from "../../utils.js";

function currentLogDir(): string {
  const { workers } = readWorkersSection();
  return workersLogDir(workers);
}

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(err("pai worker: ") + msg);
  process.exitCode = 1;
}

export function registerWorkerCommands(workerCmd: Command): void {
  workerCmd
    .command("run")
    .description(
      "Run one claude-code worker through the configured provider.\n" +
        "Unknown options are passed to claude verbatim (e.g. -p, --allowedTools);\n" +
        "--output-format/--verbose are handled here.\n" +
        "--label \"<goal>\" is optional — it is the row shown in ps / follow /\n" +
        "the status line; when absent it is derived from the prompt's first line\n" +
        "(--chain/--agent derive their own instead).\n" +
        "--spec <file> (or --spec -) reads the prompt from a file/stdin instead of\n" +
        "an inline -p '<prompt>', which breaks on shell quoting; mutually\n" +
        "exclusive with -p.\n" +
        "Grant MCP tools by naming mcp__server__tool in --allowedTools (the server loads automatically);\n" +
        "--chain draft,implement[,review] runs a spec-first pipeline;\n" +
        "--agent <name> runs an agent definition from ~/.claude/agents."
    )
    .allowUnknownOption(true)
    .option("--provider <name>", "Provider to run on (default: active, else routing order)")
    .option("--class <name>", "Use the provider of this class (draft, implement, review, research, spotcheck, simple, complex, image)")
    .option("--role <name>", "Alias of --class (roles were renamed to classes)")
    .option("--chain <stages>", "Comma-separated stage classes, e.g. draft,implement or draft,implement,review")
    .option("--agent <name>", "Run the agent definition ~/.claude/agents/<name>.md on a worker")
    .option(
      "--model <model>",
      "Override the model for this run. Headless (-p) workers default to the --class model; " +
        "an interactive launch (no -p) with no --model uses the harness default model from settings.json."
    )
    .option("--label <text>", "Short task label shown in ps / follow / status line (default: first line of the prompt)")
    .option("--spec <path>", "Read the prompt from this file (or - for stdin) instead of -p; mutually exclusive with -p")
    .option("--cwd <dir>", "Directory the worker runs in (default: this process's cwd)")
    .option("--mcp <names>", "MCP servers/sets this worker may use (comma-separated; see `pai worker mcp`)")
    .option("--no-pane", "Do not open a follow pane for this worker")
    .option("--worktree", "Run in a git worktree on branch worker/<id> (default for implement/complex/plan in a git repo)")
    .option("--no-worktree", "Run in place, no worktree")
    .option("--print-cmd", "Print the assembled claude argv as JSON and exit, without spawning (audit tool)")
    .option("--report <format>", "Final-report contract/parser: json or ag2 (default: ag2, or PAI_WORKER_REPORT)")
    .option("--no-report-retry", "Skip the one bounded re-ask when the final AG2 message fails validation")
    .argument("[args...]", "claude arguments, e.g. -p '<task>' --allowedTools 'Read,Edit,Bash'")
    .action(
      async (
        args: string[],
        opts: {
          provider?: string;
          class?: string;
          role?: string;
          chain?: string;
          agent?: string;
          model?: string;
          label?: string;
          spec?: string;
          cwd?: string;
          mcp?: string;
          pane?: boolean;
          worktree?: boolean;
          printCmd?: boolean;
          report?: string;
          reportRetry?: boolean;
        }
      ) => {
        try {
          const className = opts.class ?? opts.role;
          if (opts.report !== undefined && opts.report !== "json" && opts.report !== "ag2") {
            throw new Error(`--report: expected "json" or "ag2", got "${opts.report}"`);
          }
          const reportFormatFlag = opts.report as "json" | "ag2" | undefined;
          // The picker passes the project dir; fail loudly rather than spawn elsewhere.
          if (opts.cwd !== undefined) {
            if (!existsSync(opts.cwd)) throw new Error(`--cwd: directory does not exist: ${opts.cwd}`);
            if (!statSync(opts.cwd).isDirectory()) throw new Error(`--cwd: not a directory: ${opts.cwd}`);
          }
          let claudeArgs = args;
          let specPath: string | undefined;
          if (opts.spec !== undefined) {
            if (parseRunnerArgs(args).headless) {
              throw new Error("--spec and -p/--print are mutually exclusive — pass the prompt one way, not both");
            }
            const cwdForSpec = opts.cwd ?? process.cwd();
            specPath = resolveSpecPath(opts.spec, cwdForSpec);
            const promptText = readSpecPrompt(opts.spec, cwdForSpec);
            claudeArgs = ["-p", promptText, ...args];
          } else {
            const hint = longInlinePromptHint(parseRunnerArgs(args).prompt);
            if (hint) process.stderr.write(hint + "\n");
          }

          let label = opts.label;
          let agentClass: string | undefined;
          if (opts.agent) {
            // agent definition: system prompt + tools come from the file, the
            // model maps to a class, the label defaults to "<agent>: <prompt>"
            const def = loadAgent(opts.agent);
            claudeArgs = [...agentClaudeArgs(def), ...claudeArgs];
            // provider models map into the tier table so routing survives
            // non-Anthropic ids; an unreadable config still resolves aliases
            let agentProviders: Record<string, WorkerProvider> | undefined;
            try {
              agentProviders = readWorkersSection().workers.providers;
            } catch {
              agentProviders = undefined;
            }
            agentClass = modelToClass(def.model, agentProviders);
            if (!label) label = agentLabel(opts.agent, parseRunnerArgs(claudeArgs).prompt);
          }
          if (opts.chain) {
            const brief = parseRunnerArgs(claudeArgs).prompt;
            if (!brief) {
              throw new Error("--chain needs the task as -p '<brief>'");
            }
            const rc = await runChain({
              stages: opts.chain.split(","),
              className: className ?? agentClass,
              providerFlag: opts.provider,
              modelFlag: opts.model,
              label,
              noPane: opts.pane === false,
              mcpFlag: opts.mcp,
              specPath,
              cwd: opts.cwd,
              brief,
              claudeArgs,
            });
            process.exitCode = rc;
            return;
          }
          if (!label) {
            label = deriveLabel(parseRunnerArgs(claudeArgs).prompt, className ?? agentClass ?? "default");
          }
          const rc = await runWorker({
            providerFlag: opts.provider,
            className: className ?? agentClass,
            modelFlag: opts.model,
            label,
            mcpFlag: opts.mcp,
            specPath,
            cwd: opts.cwd,
            noPane: opts.pane === false,
            worktreeFlag: opts.worktree,
            printCmd: opts.printCmd,
            reportFormatFlag,
            noReportRetry: opts.reportRetry === false,
            claudeArgs,
          });
          process.exitCode = rc;
        } catch (e) {
          fail(e);
        }
      }
    );

  workerCmd
    .command("ps")
    .description("List workers of this session (RUNNING + FINISHED); --all for every worker")
    .option("--all", "Show workers of all sessions, not just this terminal's")
    .action((opts: { all?: boolean }) => {
      try {
        console.log(psOutput(currentLogDir(), opts.all === true));
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("follow [id]")
    .description("Live transcript of one worker, or of this session's running workers")
    .option("--all", "Follow workers of all sessions")
    .option("--auto-exit [secs]", "Exit secs after the workers end (pane mode; default from config)")
    .action(async (id: string | undefined, opts: { all?: boolean; autoExit?: string | boolean }) => {
      try {
        const { workers } = readWorkersSection();
        const autoExit =
          opts.autoExit === undefined || opts.autoExit === false
            ? 0
            : opts.autoExit === true
              ? workers.pane.autoExitSecs
              : Number(opts.autoExit);
        await followWorkers(currentLogDir(), id ?? null, opts.all === true, autoExit);
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("replay <id>")
    .description("Print the transcript of one finished or running worker")
    .option("--tail <n>", "Only the last n rendered lines", parseIntArg)
    .action((id: string, opts: { tail?: number }) => {
      try {
        console.log(replayOutput(currentLogDir(), id, process.stdout.isTTY === true, opts.tail));
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("watch")
    .description("ps refreshed every 2 seconds (plain `watch`, colors kept)")
    .action(() => {
      const proc = spawn("watch", ["-n", "2", "pai worker ps --all"], { stdio: "inherit" });
      proc.on("error", (e) => fail(new Error(`cannot run watch: ${e.message}`)));
      proc.on("close", (code) => {
        process.exitCode = code ?? 1;
      });
    });

  workerCmd
    .command("pane [id]")
    .description("Open the follow pane for a worker (or one shared pane for this session)")
    .option("--check", "Only report whether the pane is open, plus the profile file's path, font, and the hosting window's bounds")
    .action(async (id: string | undefined, opts: { check?: boolean }) => {
      try {
        const { workers } = readWorkersSection();
        const logDir = currentLogDir();
        const term = process.env.ITERM_SESSION_ID ?? "";
        if (id) {
          const msg = opts.check
            ? await checkPaneForWorker(id, workers.pane.fontSize, term)
            : await openPaneForWorker(logDir, workers, id, term);
          console.log(msg);
        } else {
          console.log(await openFollowPane(logDir, workers, term, opts.check === true));
        }
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("log [what]")
    .description("all = ledger, tail = last ledger lines, <id> = raw event stream, none = list")
    .action((what: string | undefined) => {
      try {
        const logDir = currentLogDir();
        const ledger = ledgerPath(logDir);
        if (what === "all") {
          console.log(existsSync(ledger) ? readFileSync(ledger, "utf8") : dim("(no ledger yet)"));
          return;
        }
        if (what === "tail") {
          if (!existsSync(ledger)) {
            console.log(dim("(no ledger yet)"));
            return;
          }
          const lines = readFileSync(ledger, "utf8").trim().split("\n");
          console.log(lines.slice(-20).join("\n"));
          return;
        }
        if (what) {
          const path = eventsPath(logDir, what);
          if (!existsSync(path)) {
            fail(new Error(`no event log for ${what}`));
            return;
          }
          const lines = readFileSync(path, "utf8").trim().split("\n");
          console.log(lines.slice(-30).join("\n"));
          return;
        }
        if (!existsSync(logDir)) {
          console.log(dim("(no workers yet)"));
          return;
        }
        for (const f of readdirSync(logDir).filter((x) => x.endsWith(".jsonl")).sort()) {
          const st = statSync(`${logDir}/${f}`);
          const mb = (st.size / 1024 / 1024).toFixed(1);
          console.log(`  ${f.replace(".jsonl", "")}  ${mb} MB  ${st.mtime.toISOString().slice(0, 19).replace("T", " ")}`);
        }
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("say <id> <text>")
    .description("Send one message to a running worker (forwarded to its open stdin)")
    .option("--goal <text>", "Relabel the worker (its ps / pane goal) before sending the message")
    .action(async (id: string, text: string, opts: { goal?: string }) => {
      try {
        if (opts.goal !== undefined) setWorkerLabel(currentLogDir(), id, opts.goal);
        await sayToWorker(currentLogDir(), id, text);
        console.log("ok");
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("goal <id> <text>")
    .description("Relabel a running worker (its ps / pane goal) without sending it a message")
    .action((id: string, text: string) => {
      try {
        setWorkerLabel(currentLogDir(), id, text);
        console.log("ok");
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("handoff <json>")
    .description(
      "From inside a worker: append a handoff to the parent's inbox and (when it runs) say it to the parent.\n" +
        'Payload: {"kind":"proposal|question|blocker","text":"…","data":{…}} — from/to come from the environment.'
    )
    .action(async (json: string) => {
      try {
        let payload: unknown;
        try {
          payload = JSON.parse(json);
        } catch {
          fail(new Error(`payload is not JSON: ${json}`));
          return;
        }
        const h = await handoffFromInside(currentLogDir(), process.env, payload);
        console.log(`ok → ${h.to} (${h.kind}); inbox ${h.to}.inbox.jsonl`);
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("merge <id>")
    .description("Merge a worker's worktree branch (worker/<id>) into the original checkout, then remove the worktree and delete the branch")
    .action((id: string) => {
      try {
        console.log(mergeWorker(currentLogDir(), id));
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("wait <ids...>")
    .description(
      "Poll workers until they finish; prints each result as one JSON line, exit 1 on failure or timeout\n" +
        "Never busy-wait for a worker: no sleep loops, no sleep-then-`pai worker ps` polling, no manual retry loops. Two sanctioned waits: run workers as background Bash tasks (the harness notifies on completion), or call `pai worker wait`, which blocks until they finish and prints each result. If you catch yourself sleeping to re-check a worker, stop — you already get notified. Supervision events arrive automatically — no polling, no sleeps: the daemon watches your workers and tells you when one finishes, fails or stalls (docs/worker.md, Supervision)."
    )
    .option("--timeout <secs>", "Give up after this many seconds (default 900)", parseIntArg)
    .action(async (ids: string[], opts: { timeout?: number }) => {
      try {
        const { results, timedOut } = await waitWorkers(currentLogDir(), ids, {
          timeoutMs: (opts.timeout ?? 900) * 1000,
        });
        for (const r of results) console.log(JSON.stringify(r));
        if (timedOut.length) {
          console.error(err(`pai worker wait: timed out waiting for ${timedOut.join(", ")}`));
          process.exitCode = 1;
          return;
        }
        const failed = results.filter((r) => !r.ok).map((r) => r.id);
        if (failed.length) {
          console.error(err(`pai worker wait: failed: ${failed.join(", ")}`));
          process.exitCode = 1;
        }
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("discard <id>")
    .description("Drop a worker's worktree and branch, keeping nothing")
    .action((id: string) => {
      try {
        console.log(discardWorker(currentLogDir(), id));
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("kill <id>")
    .description("Send SIGTERM to a running worker process")
    .action(async (id: string) => {
      try {
        const logDir = currentLogDir();
        const status = loadStatus(logDir, id);
        if (!status) {
          fail(new Error(`no worker named "${id}"`));
          return;
        }
        if (status.state !== "running") {
          fail(new Error(`worker ${id} is not running (state: ${status.state})`));
          return;
        }
        if (!status.pid || status.pid <= 0) {
          fail(new Error(`worker ${id} has no pid recorded`));
          return;
        }
        try {
          process.kill(status.pid, "SIGTERM");
          // The run's own SIGTERM handler writes the terminal status (killed,
          // rc 143, secs) — it knows the numbers we do not. Give it a moment
          // and only write ourselves if it never got there: writing our own
          // pre-signal snapshot unconditionally raced that handler and put a
          // half-empty "killed rc=null ?s" row back on disk (2026-09-19).
          const selfReported = await waitForTerminalStatus(logDir, id);
          if (!selfReported) {
            const latest = loadStatus(logDir, id) ?? status;
            latest.state = "killed";
            latest.rc = latest.rc ?? 143;
            latest.last = latest.last || "killed by signal SIGTERM";
            saveStatus(logDir, latest);
          }
          console.log(`sent SIGTERM to worker ${id} (pid ${status.pid})`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("ESRCH")) {
            fail(new Error(`process ${status.pid} not found (already exited?)`));
          } else {
            fail(e);
          }
        }
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("controls <id> <who>")
    .description(
      "Hand the desktop controls (clickr) to a worker or take them back.\n" +
        "<who> is `you` (the worker may actuate) or `me` (the operator keeps them);\n" +
        "inside a worker's pane, typing \"your controls\" does the same."
    )
    .action((id: string, who: string) => {
      try {
        if (who !== "you" && who !== "me") {
          fail(new Error(`<who> must be "you" or "me"`));
          return;
        }
        if (!loadStatus(currentLogDir(), id)) {
          fail(new Error(`no worker named "${id}"`));
          return;
        }
        const proc = spawn("clickr", ["controls", who], { stdio: "inherit" });
        proc.on("error", (e) =>
          fail(new Error(`cannot run clickr controls: ${e.message} (is clickr installed?)`))
        );
        proc.on("close", (code) => {
          if (code === 0) console.log(`controls → ${who === "you" ? id : "operator"}`);
          process.exitCode = code ?? 1;
        });
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("resume <id> <text>")
    .description("Continue a finished worker on the same provider: claude --resume <session>")
    .option("--print-id", "Print the new worker id on its own line (pane follow handoff)")
    .option("--no-pane", "Do not open a follow pane for the resumed worker")
    .action(async (id: string, text: string, opts: { printId?: boolean; pane?: boolean }) => {
      try {
        const logDir = currentLogDir();
        const old = loadStatus(logDir, id);
        if (!old) {
          fail(new Error(`no worker named "${id}"`));
          return;
        }
        if (!old.claudeSession) {
          fail(
            new Error(
              `worker ${id} recorded no Claude session id — it predates resume support ` +
                `or ran through an engine that does not expose one`
            )
          );
          return;
        }
        let newId = "";
        const rc = await runWorker({
          providerFlag: old.provider,
          modelFlag: old.model,
          label: `↩ ${old.label}`,
          noPane: opts.pane === false,
          claudeArgs: ["--resume", old.claudeSession, "-p", text],
          onWorkerStart: (wid) => {
            newId = wid;
          },
        });
        if (opts.printId === true && newId) console.log(newId);
        process.exitCode = rc;
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("proxy [stop]")
    .description(
      "The local Anthropic↔OpenAI proxy (loopback only); started on demand by `run`,\n" +
        "`proxy` starts/verifies it, `proxy stop` stops it again"
    )
    .option("--port <n>", `Port to listen on (default ${DEFAULT_PROXY_PORT})`, parseIntArg)
    .action(async (stop: string | undefined, opts: { port?: number }) => {
      try {
        const logDir = currentLogDir();
        if (stop === "stop") {
          console.log(stopProxy(logDir));
          return;
        }
        if (stop) {
          fail(new Error(`unknown proxy argument "${stop}" (expected: stop)`));
          return;
        }
        const url = await ensureProxyRunning(opts.port ?? DEFAULT_PROXY_PORT, logDir);
        console.log(`proxy listening on ${url} — point openai providers at ${url}/<provider>`);
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("mcp [list]")
    .description("MCP servers workers may load via --mcp / roles, and the configured sets")
    .action((what: string | undefined) => {
      if (what && what !== "list") {
        fail(new Error(`unknown mcp argument "${what}" (expected: list)`));
        return;
      }
      try {
        const { workers } = readWorkersSection();
        console.log(describeMcp(workers).join("\n"));
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("status-line [term] [cwd] [session]")
    .description(
      "One-line worker summary for a status bar (empty when none in scope).\n" +
        "Called by statusline-command.sh with ITERM_SESSION_ID, the pane cwd and\n" +
        "the claude session id (claims workers spawned by that session's Bash)."
    )
    .action((term: string | undefined, cwd: string | undefined, session: string | undefined) => {
      try {
        const out = statusLineOutput(
          currentLogDir(),
          term ?? process.env.ITERM_SESSION_ID ?? "",
          cwd ?? process.cwd(),
          session ?? "",
          new Date(),
          readWorkersSection().workers.active
        );
        if (out) console.log(out);
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("on")
    .description("Route Agent-tool subagents to workers (default when a provider exists)")
    .action(() => {
      try {
        setWorkersEnabled(true);
        console.log("workers on — the Agent hook now denies and suggests `pai worker run`");
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("off")
    .description("Stop routing: Agent tool runs on Anthropic again")
    .action(() => {
      try {
        setWorkersEnabled(false);
        console.log("workers off — Agent-tool subagents run on Anthropic");
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("fallback [action] [provider]")
    .description(
      "Machine-wide fallback: every NEW Claude Code process runs on a worker\n" +
        "provider (settings.json env + model pin) until switched back.\n" +
        "on [provider] switches (default: active), off restores settings.json\n" +
        "exactly, status shows state and running sessions. CLAUDE_SETTINGS_PATH\n" +
        "points at another settings.json for dry runs."
    )
    .action((action: string | undefined, provider: string | undefined) => {
      try {
        if (action === undefined || action === "status") {
          console.log(fallbackStatusText(fallbackStatus()).join("\n"));
          return;
        }
        if (action === "on") {
          const r = fallbackOn(provider);
          console.log(
            r.alreadyOn
              ? `fallback already on — provider ${r.provider}, env re-applied`
              : `fallback on — provider ${r.provider}; every new Claude Code process uses it`
          );
          console.log(`  settings.json env: ${r.envKeys.join(", ")}`);
          console.log(`  model pin: ${r.model}`);
          console.log("running sessions keep their current provider until restarted (see: pai worker fallback status)");
          return;
        }
        if (action === "off") {
          const r = fallbackOff();
          console.log(`fallback off — provider ${r.provider} released, settings.json restored`);
          console.log(`  restored keys: ${r.envKeys.join(", ")}`);
          return;
        }
        fail(new Error(`unknown fallback action "${action}" (expected: on, off, status)`));
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("install")
    .description("Migrate: Agent hook in settings.json, ~/.local/bin glm* shims, old script cleanup")
    .action(() => {
      try {
        const r = installWorkers();
        for (const line of r.lines) console.log(`  ${line}`);
      } catch (e) {
        fail(e);
      }
    });

  const providersCmd = workerCmd
    .command("providers")
    .description("Providers: list, add, remove, use, enable, disable, test");

  registerWorkerProviderCommands(providersCmd);
  registerWorkerClassCommands(workerCmd);
  registerWorkerModelCommand(workerCmd);
  registerWorkerConfigCommands(workerCmd);
}

function parseIntArg(v: string): number {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}
