/**
 * Lifecycle shortcuts and maintenance: pause, end, resume, clear-names, cd, notes, list, find,
 * shell-init, launch, backup, restore, update. Logic: ./lifecycle/ and ./session/.
 */

import { CliError, OPT, type CommandDef } from "../define.js";
import { legacy } from "../lib/legacy.js";
import { SHELL_INIT } from "../lib/shell-init.js";
import { cmdList as cmdNotesList } from "./session/commands.js";
import { cmdEnd } from "./session/end.js";
import { cmdGoto } from "./session/goto.js";
import { cmdPause } from "./session/pause.js";
import { cmdPauseAll } from "./session/pause-all.js";
import { runBackup } from "./lifecycle/backup.js";
import { runCd } from "./lifecycle/cd.js";
import { cmdFind } from "./lifecycle/find.js";
import { runLaunch } from "./lifecycle/launch.js";
import { runRestore } from "./lifecycle/restore.js";
import { runUpdate } from "./lifecycle/update.js";
import { clearNamesCmd } from "./session-notes.js";

const bodyOpts: CommandDef["options"] = [
  { name: "body-file", type: "string", value: "FILE", summary: "File holding the checkpoint text to save ('-' reads standard input). Required unless --no-body" },
  { name: "session-id", type: "string", value: "UUID", summary: "Claude Code session id; recorded as the handle for `claude --resume`" },
  { name: "no-body", type: "boolean", default: false, summary: "Save a checkpoint with metadata only, no text" },
];

const checkpointOf = (c: Parameters<NonNullable<CommandDef["run"]>>[0]) => ({
  dryRun: c.dryRun,
  bodyFile: c.opts["body-file"] as string | undefined,
  sessionId: c.opts["session-id"] as string | undefined,
  noBody: c.opts["no-body"] === true,
});

export const pauseTop: CommandDef = {
  name: "pause",
  summary: "Save your place before leaving a session",
  description:
    "Writes a \"Continue\" block into the project's TODO.md so the next session knows where you stopped, then tells you how to leave safely.\n" +
    "`pai pause all` does it for every live session through AIBroker. Leave with /exit inside Claude Code; Ctrl+C skips the stop hook.",
  args: [{ name: "TARGET", summary: "Only the word `all`: pause every live session" }],
  options: [
    ...bodyOpts!,
    { name: "exit", type: "boolean", default: false, summary: "With `all`: also send /exit to each session after it has saved" },
    { name: "only", type: "string", value: "NAME", summary: "With `all`: only sessions whose name or id contains NAME (to rehearse on one tab first)" },
    { name: "wait", type: "number", value: "MS", default: 180000, summary: "With `all`: longest wait for a session to finish its checkpoint before /exit; busy ones are left open, never killed" },
    { ...OPT.dryRun, summary: "Show what would be written, write nothing" },
  ],
  examples: ["pai pause --dry-run --no-body", "pai pause --body-file checkpoint.md", "pai pause all --dry-run", "pai pause all --only api --exit"],
  seeAlso: ["pai end", "pai session handover"],
  daily: true,
  run(c) {
    const target = c.args.TARGET as string | undefined;
    if (target === "all") {
      return legacy(() =>
        cmdPauseAll({ exit: c.opts.exit === true, dryRun: c.dryRun, only: c.opts.only as string | undefined, wait: c.opts.wait as number | undefined })
      );
    }
    if (target !== undefined) throw new CliError(`Unknown target: ${target}. Did you mean 'pai pause all'?`, "pai pause all");
    return legacy(() => cmdPause(checkpointOf(c)));
  },
};

export const endTop: CommandDef = {
  name: "end",
  summary: "Finish the current session",
  description: "Saves the checkpoint, marks the session note Completed and tells you how to leave. Leave with /exit inside Claude Code afterwards.",
  options: [...bodyOpts!, { ...OPT.dryRun, summary: "Show what would be written, write nothing" }],
  examples: ["pai end --dry-run --no-body", "pai end --body-file checkpoint.md"],
  seeAlso: ["pai pause"],
  daily: true,
  run: (c) => legacy(() => cmdEnd(checkpointOf(c))),
};

export const resumeTop: CommandDef = {
  name: "resume",
  summary: "Open a session by name or id (same as `pai open`)",
  description: "Kept for old scripts. Resumes the session when possible, otherwise starts a fresh one in the same directory.",
  args: [{ name: "NAME", required: true, summary: "Session name or the first characters of its id" }],
  examples: ["pai resume my-session --dry-run", "pai resume 3a9f1c2e"],
  seeAlso: ["pai open"],
  run: (c) => legacy(() => cmdGoto(c.args.NAME as string, { dryRun: c.dryRun })),
};

export const cdTop: CommandDef = {
  name: "cd",
  summary: "Print a project's directory (the shell wrapper changes into it)",
  description: "Needs the shell integration: add `eval \"$(pai shell-init)\"` to your shell profile. If the project moved on disk, the registry is updated.",
  args: [{ name: "PROJECT", required: true, summary: "Project name, slug or path" }],
  examples: ["pai cd my-project", "cd \"$(pai cd my-project)\""],
  seeAlso: ["pai shell-init"],
  run: (c) => legacy(() => runCd(c.args.PROJECT as string)),
};

const notesOpts: CommandDef["options"] = [
  { name: "limit", type: "number", value: "N", default: 20, summary: "Most notes to show" },
  { name: "status", type: "string", value: "STATE", summary: "Only notes in this state: open, completed or compacted" },
];
const notesRun: CommandDef["run"] = (c) =>
  legacy(() => cmdNotesList(c.args.PROJECT as string | undefined, { limit: String(c.opts.limit), status: c.opts.status as string | undefined }));

export const notesTop: CommandDef = {
  name: "notes",
  summary: "List the markdown session notes",
  description: "Shows the session notes PAI keeps per project, newest first, optionally for one project.",
  args: [{ name: "PROJECT", summary: "Project slug (default: all projects)" }],
  options: notesOpts,
  examples: ["pai notes", "pai notes my-project --status open --limit 5"],
  seeAlso: ["pai session info", "pai ls"],
  subcommands: [
    {
      name: "list",
      summary: "List the markdown session notes (same as `pai notes`)",
      description: "Same as `pai notes`.",
      args: [{ name: "PROJECT", summary: "Project slug (default: all projects)" }],
      options: notesOpts,
      examples: ["pai notes list", "pai notes list my-project"],
      run: notesRun,
    },
  ],
  run: notesRun,
};

export const listTop: CommandDef = { ...notesTop, name: "list", aliasOf: "notes", subcommands: undefined };

export const findTop: CommandDef = {
  name: "find",
  summary: "Search your prompt history for sessions",
  description: "Looks for the words in everything you typed to Claude Code and lists the sessions where they appeared.",
  args: [{ name: "QUERY", required: true, summary: "Words to search for" }],
  options: [
    { name: "n", short: "n", type: "number", value: "COUNT", default: 20, summary: "Most sessions to show" },
    { ...OPT.json, summary: "Print a JSON array" },
  ],
  examples: ['pai find "retry loop"', "pai find login -n 5 --json"],
  seeAlso: ["pai ls", "pai open"],
  run: (c) => legacy(() => cmdFind(c.args.QUERY as string, { n: String(c.opts.n), json: c.opts.json === true })),
};

export const shellInitTop: CommandDef = {
  name: "shell-init",
  summary: "Print the shell integration code",
  description:
    "Prints shell functions that let `pai cd` and the picker change your shell's directory. Add this line to ~/.zshrc or ~/.bashrc:\n" +
    "  eval \"$(pai shell-init)\"",
  examples: ['eval "$(pai shell-init)"', "pai shell-init"],
  seeAlso: ["pai cd"],
  run() {
    process.stdout.write(SHELL_INIT);
  },
};

export const launchTop: CommandDef = {
  name: "launch",
  summary: "Start Claude Code on a chosen provider (for scripts)",
  description:
    "Starts a fresh Claude Code process in the current terminal on the provider and model you name. A running session cannot change provider, so this always starts a new one.\n" +
    "Without --provider in a terminal it shows a numbered table to pick from; --list prints the table and stops. Arguments after `--` go to claude unchanged.\n" +
    "For everyday use prefer `pai new` and `pai open`.",
  args: [],
  options: [
    { ...OPT.provider, summary: "Provider to start on (default: pick from the table)" },
    { ...OPT.model },
    { name: "list", type: "boolean", default: false, summary: "Print the provider and model table and stop" },
    { name: "current", type: "boolean", default: false, summary: "With --list: mark this session's own provider and model" },
    { ...OPT.dryRun },
  ],
  passthrough: true,
  examples: ["pai launch --list", "pai launch --provider glm --dry-run", "pai launch --provider glm -- --resume 3a9f1c2e"],
  seeAlso: ["pai new", "pai open", "pai providers"],
  run: (c) =>
    legacy(() =>
      runLaunch(c.rest, {
        provider: c.opts.provider as string | undefined,
        model: c.opts.model as string | undefined,
        list: c.opts.list === true,
        current: c.opts.current === true,
        dryRun: c.dryRun,
      })
    ),
};

export const backupTop: CommandDef = {
  name: "backup",
  summary: "Back up the registry, config and Postgres database",
  description: "Copies the registry database and config into a dated folder under PAI_HOME/backups and, unless told not to, dumps the Postgres database from its Docker container.",
  options: [
    { name: "no-postgres", type: "boolean", default: false, summary: "Skip the Postgres dump (faster; registry and config only)" },
    { ...OPT.dryRun, summary: "Print the database that would be dumped, write nothing" },
  ],
  examples: ["pai backup", "pai backup --no-postgres", "pai backup --dry-run"],
  seeAlso: ["pai restore"],
  run: (c) => legacy(() => runBackup({ postgres: c.opts["no-postgres"] !== true, dryRun: c.dryRun })),
};

export const restoreTop: CommandDef = {
  name: "restore",
  summary: "Restore PAI data from a backup",
  description: "Overwrites the current registry, config and (unless skipped) the Postgres database with a backup made by `pai backup`. Without a path the newest backup is used. Asks before overwriting.",
  args: [{ name: "BACKUP", summary: "Backup folder (default: the newest one)" }],
  options: [
    { name: "no-postgres", type: "boolean", default: false, summary: "Do not restore the Postgres database" },
    { name: "yes", type: "boolean", default: false, summary: "Do not ask for confirmation" },
  ],
  examples: ["pai restore", "pai restore ~/.pai/backups/20260101-120000 --no-postgres --yes"],
  seeAlso: ["pai backup"],
  run: (c) => legacy(() => runRestore(c.args.BACKUP as string | undefined, { postgres: c.opts["no-postgres"] !== true, yes: c.opts.yes === true })),
};

export const updateTop: CommandDef = {
  name: "update",
  summary: "Update PAI to the latest version",
  description: "Pulls the latest source, rebuilds and restarts the daemon. Your local customisations are kept.",
  examples: ["pai update", "pai update && pai daemon status"],
  seeAlso: ["pai daemon status"],
  run: () => legacy(() => runUpdate()),
};

export { clearNamesCmd };
