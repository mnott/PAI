/**
 * `pai pane`: run a command in a visible pane. Behaviour lives in src/workers/pane-run.ts;
 * this file declares names, flags and help.
 */

import { readWorkersSection } from "../../workers/config.js";
import { workersLogDir } from "../../workers/paths.js";
import { openVerifiedPane, realPaneOps, resolveHostSession } from "../../workers/pane.js";
import { PANE_RUN_ENV, runInPane } from "../../workers/pane-run.js";
import { CliError, type CommandDef, type RunContext } from "../define.js";

/** Inside a worker or another pane run there is already a pane: nothing to open. */
export const inVisiblePane = (env: NodeJS.ProcessEnv = process.env): boolean => env.PAI_WORKER === "1" || env[PANE_RUN_ENV] === "1";

/** Run `command` in a pane placed like a worker's (split, else tab, never a window); resolves to its exit code. */
export function runCommandInPane(command: string[], label?: string, cwd?: string): Promise<number> {
  const { workers } = readWorkersSection();
  const logDir = workersLogDir(workers);
  return runInPane({
    command,
    label,
    cwd,
    logDir,
    openPane: async (id) => {
      if (inVisiblePane()) return "already in a pane; none opened";
      const term = (await resolveHostSession()).term;
      return openVerifiedPane(logDir, workers, id, term, process.env, realPaneOps);
    },
  });
}

const runCmd: CommandDef = {
  name: "run",
  summary: "Run a command in a visible pane and wait for it",
  description:
    "Opens one pane (split of this window, else a tab, never a new window; an ended PAI pane of the session is reused) that shows the command's live output and its exit code, tees the output to <PAI home>/logs/panes/<id>.log, and blocks until the command ends. Then it prints the last 40 lines and exits with the command's exit code, so a backgrounded call still reports back to the session. " +
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

export const paneCommand: CommandDef = {
  name: "pane",
  summary: "Run a command in a visible pane: run",
  description: "Everything a session starts that does not run in its own pane runs in one: `pai pane run` is the way for background commands. See docs/worker-panes.md.",
  examples: ["pai pane run --label tests -- npx vitest run", "pai pane run -- sleep 30"],
  seeAlso: ["pai worker run", "pai build run"],
  subcommands: [runCmd],
};
