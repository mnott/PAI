/** The command groups, in the order the help shows them. One file per group lives in ./commands. */

import type { CommandDef, GroupDef } from "./define.js";
import { docCommand, helpCommand } from "./commands/meta.js";
import { LATER_GROUPS, SESSION_LATER, SESSION_SHORTCUTS_LATER } from "./commands/later.js";
import { workerCommand } from "./commands/worker.js";
import { providersCommand } from "./commands/providers.js";
import { PROVIDER_EDIT_COMMANDS, WORKER_CONFIG_COMMANDS } from "./commands/worker-config.js";
import { routerCommand } from "./commands/router.js";
import { moreCommand, setupsCommand } from "./commands/setups.js";
import { SESSION_NOTE_COMMANDS, sessionsCommand } from "./commands/session-notes.js";
import { backupTop, cdTop, clearNamesCmd, endTop, findTop, launchTop, listTop, notesTop, pauseTop, restoreTop, resumeTop, shellInitTop, updateTop } from "./commands/lifecycle.js";
import { hooksDbCommand } from "./commands/hooks-db.js";
import { installAlias, setupCommand } from "./commands/setup.js";
import { lsCommand, newTop, openTop, renameTop, sessionCommand } from "./commands/session.js";
import { BATCH_C } from "./commands/batch-c.js";

const sessionGroup: CommandDef = {
  ...sessionCommand,
  subcommands: [...(sessionCommand.subcommands ?? []), ...SESSION_NOTE_COMMANDS, ...SESSION_LATER],
};

const workerGroup: CommandDef = {
  ...workerCommand,
  summary: "Run tasks on other providers: run, ps, follow, merge, providers, classes, config, ...",
  description: workerCommand.description + "\nSetup lives here too: providers, classes, config, policy, local, fallback, pool, proxy, mcp, on, off, install.",
  examples: [...(workerCommand.examples ?? []), "pai worker providers", "pai worker policy"],
  subcommands: [...(workerCommand.subcommands ?? []), ...WORKER_CONFIG_COMMANDS],
};

// `pai providers add|remove|...` are the same command objects as `pai worker providers ...`.
const providersTop: CommandDef = {
  ...providersCommand,
  subcommands: [...(providersCommand.subcommands ?? []), ...PROVIDER_EDIT_COMMANDS],
};

const titles = {
  workers: "Workers",
  memory: "Memory & projects",
  daemon: "Daemon & setup",
} as const;

const BATCH_B_EXTRA: Partial<Record<string, CommandDef[]>> = {
  memory: [findTop, notesTop, listTop, cdTop],
  daemon: [setupCommand, installAlias, updateTop, hooksDbCommand, backupTop, restoreTop, shellInitTop, launchTop],
};

export const GROUPS: GroupDef[] = [
  { id: "sessions", title: "Sessions", daily: true, commands: [lsCommand, setupsCommand, openTop, newTop, renameTop, sessionGroup, pauseTop, endTop, resumeTop, clearNamesCmd, sessionsCommand, ...SESSION_SHORTCUTS_LATER] },
  { id: "providers", title: "Providers", daily: true, commands: [providersTop] },
  { id: "help", title: "Help", daily: true, commands: [moreCommand, helpCommand, docCommand] },
  ...LATER_GROUPS.map((g) => ({
    id: g.id,
    title: titles[g.id as keyof typeof titles],
    daily: false,
    commands: [...(g.id === "workers" ? [workerGroup, routerCommand] : []), ...g.commands, ...(BATCH_B_EXTRA[g.id] ?? []), ...(BATCH_C[g.id] ?? [])],
  })),
];
