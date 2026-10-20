/**
 * `pai pane`: run a command in a visible pane. Behaviour lives in src/workers/pane-run.ts;
 * this file declares names, flags and help.
 */

import { readWorkersSection } from "../../workers/config.js";
import { workersLogDir } from "../../workers/paths.js";
import { closePaneForWorker, closeSelfPane, inVisiblePane, resolveHostSession } from "../../workers/pane.js";
import { launchPane } from "../../workers/pane-launch.js";
import { runPaneExec } from "../../workers/pane-exec.js";
import { writePaneTitle } from "../../workers/pane-title.js";
import { runInPane } from "../../workers/pane-run.js";
import { CliError, type CommandDef, type RunContext } from "../define.js";

/** Run `command` in a pane placed like a worker's (split, else tab, never a window); resolves to its exit code. */
export function runCommandInPane(command: string[], label?: string, cwd?: string): Promise<number> {
  const { workers } = readWorkersSection();
  const logDir = workersLogDir(workers);
  return runInPane({
    command,
    label,
    cwd,
    logDir,
    launch: async (id) => {
      if (inVisiblePane()) return null;
      const term = (await resolveHostSession()).term;
      return launchPane({ logDir, config: workers, id, kind: "pane", term });
    },
  });
}

const runCmd: CommandDef = {
  name: "run",
  summary: "Run a command in a visible pane and wait for it",
  description:
    "Opens one pane (split of this window, never a new window) FIRST and runs the command in it as the child of `pai pane exec`, which shows the live output and its exit code, writes <PAI home>/state/pane-exec/<id>.exit and closes the pane when the command ends, whatever the exit code. The caller tees the output to <PAI home>/logs/panes/<id>.log and blocks until the command ends. With no terminal at all the command runs directly. Then it prints the last 40 lines and exits with the command's exit code, so a backgrounded call still reports back to the session. " +
    "SIGTERM/SIGINT/SIGHUP to this command kill the command's whole process group. Every background shell command of a session goes through here: the Bash guard denies a bare run_in_background command. Several words are exec'd as given; a single word is run by sh -c.",
  options: [
    { name: "label", type: "string", value: "TEXT", summary: "Name shown in `pai worker ps` and the cockpit (default: the command)" },
    { name: "cwd", type: "string", value: "DIR", summary: "Directory to run in (default: here)" },
  ],
  passthrough: true,
  examples: ["pai pane run --label tests -- npx vitest run", "pai pane run --cwd ~/proj -- make build", "pai pane run -- sleep 30"],
  seeAlso: ["pai worker ps", "pai worker follow", "pai build run"],
  run: async (ctx: RunContext) => {
    if (!ctx.rest.length) throw new CliError("no command given", "pai pane run [--label TEXT] -- <command...>");
    return runCommandInPane(ctx.rest, typeof ctx.opts.label === "string" ? ctx.opts.label : undefined, typeof ctx.opts.cwd === "string" ? ctx.opts.cwd : undefined);
  },
};

const execCmd: CommandDef = {
  name: "exec",
  summary: "Internal: the wrapper a pane runs; owns the process started in it",
  description:
    "The command of every pane PAI opens for a process it starts (a worker, a plan runner, `pai pane run`). It connects to the starting `pai` process, which sends the real command; the wrapper runs it as its child, shows its output in the pane, writes <PAI home>/state/pane-exec/<id>.exit (exit code + end time) and exits when the child exits, so the pane closes with the process. If the starting process goes away, the child is killed. Not for direct use.",
  args: [{ name: "ID", required: true, summary: "Run id the starting process listens for" }],
  examples: ["pai pane exec pane-20260101-0000-ab12"],
  seeAlso: ["pai pane run"],
  run: async (ctx: RunContext) =>
    runPaneExec(String(ctx.args.ID), {
      setTitle: (t) => writePaneTitle(t, process.env),
      closePane: async () => {
        // registry entry and iTerm session by run id; the session by its own id when the registry has none
        const { workers } = readWorkersSection();
        if (!(await closePaneForWorker(workersLogDir(workers), String(ctx.args.ID)))) await closeSelfPane();
      },
    }),
};

export const paneCommand: CommandDef = {
  name: "pane",
  summary: "Run a command in a visible pane: run",
  description: "Everything a session starts that does not run in its own pane runs in one: `pai pane run` is the way for background commands. See docs/worker-panes.md.",
  examples: ["pai pane run --label tests -- npx vitest run", "pai pane run -- sleep 30"],
  seeAlso: ["pai worker run", "pai build run"],
  subcommands: [runCmd, execCmd],
};
