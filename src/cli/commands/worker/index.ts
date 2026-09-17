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
import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir, eventsPath, ledgerPath } from "../../../workers/paths.js";
import { parseRunnerArgs } from "../../../workers/args.js";
import { runWorker } from "../../../workers/run.js";
import { runChain } from "../../../workers/chain.js";
import { agentClaudeArgs, agentLabel, loadAgent, modelToClass } from "../../../workers/agents.js";
import { followWorkers, psOutput, replayOutput, statusLineOutput } from "../../../workers/viewer.js";
import { openFollowPane, openPaneForWorker, checkPaneForWorker } from "../../../workers/pane.js";
import { installWorkers } from "../../../workers/install.js";
import { setWorkersEnabled } from "../../../workers/providers.js";
import { registerWorkerProviderCommands, registerWorkerClassCommands } from "./providers.js";
import { loadStatus } from "../../../workers/status.js";
import { sayToWorker } from "../../../workers/operator.js";
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
        "--chain draft,implement[,review] runs a spec-first pipeline;\n" +
        "--agent <name> runs an agent definition from ~/.claude/agents."
    )
    .allowUnknownOption(true)
    .option("--provider <name>", "Provider to run on (default: active, else routing order)")
    .option("--class <name>", "Use the provider of this class (draft, implement, review, research, spotcheck, simple, complex, image)")
    .option("--role <name>", "Alias of --class (roles were renamed to classes)")
    .option("--chain <stages>", "Comma-separated stage classes, e.g. draft,implement or draft,implement,review")
    .option("--agent <name>", "Run the agent definition ~/.claude/agents/<name>.md on a worker")
    .option("--model <model>", "Override the provider's model for this run")
    .option("--label <text>", "Short task label shown in ps / follow / status line")
    .option("--mcp <names>", "MCP servers/sets this worker may use (comma-separated; see `pai worker mcp`)")
    .option("--no-pane", "Do not open a follow pane for this worker")
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
          mcp?: string;
          pane?: boolean;
        }
      ) => {
        try {
          const className = opts.class ?? opts.role;
          let claudeArgs = args;
          let label = opts.label;
          let agentClass: string | undefined;
          if (opts.agent) {
            // agent definition: system prompt + tools come from the file, the
            // model maps to a class, the label defaults to "<agent>: <prompt>"
            const def = loadAgent(opts.agent);
            claudeArgs = [...agentClaudeArgs(def), ...args];
            agentClass = modelToClass(def.model);
            if (!label) label = agentLabel(opts.agent, parseRunnerArgs(args).prompt);
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
              brief,
              claudeArgs,
            });
            process.exitCode = rc;
            return;
          }
          const rc = await runWorker({
            providerFlag: opts.provider,
            className: className ?? agentClass,
            modelFlag: opts.model,
            label,
            mcpFlag: opts.mcp,
            noPane: opts.pane === false,
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
    .action(async (id: string, text: string) => {
      try {
        await sayToWorker(currentLogDir(), id, text);
        console.log("ok");
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
        console.log(describeMcp(workers));
      } catch (e) {
        fail(e);
      }
    });

  workerCmd
    .command("status-line [term] [cwd]")
    .description(
      "One-line worker summary for a status bar (empty when none in scope).\n" +
        "Called by statusline-command.sh with ITERM_SESSION_ID and the pane cwd."
    )
    .action((term: string | undefined, cwd: string | undefined) => {
      try {
        const out = statusLineOutput(
          currentLogDir(),
          term ?? process.env.ITERM_SESSION_ID ?? "",
          cwd ?? process.cwd()
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
}

function parseIntArg(v: string): number {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}
