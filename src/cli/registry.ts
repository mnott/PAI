/** The command groups, in the order the help shows them. One file per group lives in ./commands. */

import type { CommandDef, GroupDef } from "./define.js";
import { docCommand, helpCommand } from "./commands/meta.js";
import { workerCommand } from "./commands/worker.js";
import { providersCommand } from "./commands/providers.js";
import { PROVIDER_EDIT_COMMANDS, WORKER_CONFIG_COMMANDS } from "./commands/worker-config.js";
import { cockpitCommand, routerCommand } from "./commands/router.js";
import { moreCommand, setupsCommand } from "./commands/setups.js";
import { modelsCommand } from "./commands/models.js";
import { SESSION_NOTE_COMMANDS, sessionsCommand } from "./commands/session-notes.js";
import { backupTop, cdTop, clearNamesCmd, endTop, findTop, launchTop, listTop, notesTop, pauseTop, restoreTop, resumeTop, shellInitTop, updateTop } from "./commands/lifecycle.js";
import { hooksDbCommand } from "./commands/hooks-db.js";
import { installAlias, setupCommand } from "./commands/setup.js";
import { lsCommand, newTop, openTop, renameTop, sessionCommand } from "./commands/session.js";
import { BATCH_C } from "./commands/batch-c.js";
import { memoryCommand } from "./commands/memory.js";
import { kgCommand } from "./commands/kg.js";
import { zettelCommand } from "./commands/zettel.js";
import { observationCommand } from "./commands/observation.js";
import { obsidianCommand } from "./commands/obsidian.js";
import { skillCommand } from "./commands/skill.js";
import { reloadCommand } from "./commands/reload.js";
import { auditCommand } from "./commands/audit.js";
import { lessonsCommand } from "./commands/lessons.js";
import { harnessCommand } from "./commands/harness.js";

const sessionGroup: CommandDef = {
  ...sessionCommand,
  subcommands: [...(sessionCommand.subcommands ?? []), ...SESSION_NOTE_COMMANDS],
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
  { id: "sessions", title: "Sessions", daily: true, commands: [lsCommand, setupsCommand, openTop, newTop, renameTop, sessionGroup, pauseTop, endTop, resumeTop, clearNamesCmd, sessionsCommand] },
  { id: "providers", title: "Providers", daily: true, commands: [providersTop] },
  { id: "help", title: "Help", daily: true, commands: [moreCommand, helpCommand, docCommand] },
  ...(["workers", "memory", "daemon"] as const).map((id) => ({
    id,
    title: titles[id],
    daily: false,
    commands: [...(id === "workers" ? [workerGroup, routerCommand, cockpitCommand] : []), ...(BATCH_B_EXTRA[id] ?? []), ...(BATCH_C[id] ?? [])],
  })),
];

// Memory, knowledge and audit commands (one file per group in ./commands).
GROUPS.find((g) => g.id === "memory")!.commands.push(memoryCommand, kgCommand, zettelCommand, observationCommand, obsidianCommand, skillCommand, lessonsCommand);
GROUPS.find((g) => g.id === "workers")!.commands.push(modelsCommand);
GROUPS.find((g) => g.id === "daemon")!.commands.push(auditCommand, harnessCommand, reloadCommand);
