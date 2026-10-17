/** The command groups, in the order the help shows them. One file per group lives in ./commands. */

import type { CommandDef, GroupDef } from "./define.js";
import { docCommand, helpCommand } from "./commands/meta.js";
import { LATER_GROUPS, SESSION_LATER, SESSION_SHORTCUTS_LATER } from "./commands/later.js";
import { providersCommand } from "./commands/providers.js";
import { moreCommand, setupsCommand } from "./commands/setups.js";
import { lsCommand, newTop, openTop, renameTop, sessionCommand } from "./commands/session.js";
import { findCommand, memoryCommand } from "./commands/memory.js";
import { kgCommand } from "./commands/kg.js";
import { zettelCommand } from "./commands/zettel.js";
import { observationCommand } from "./commands/observation.js";
import { obsidianCommand } from "./commands/obsidian.js";
import { skillCommand } from "./commands/skill.js";
import { auditCommand } from "./commands/audit.js";

const sessionGroup: CommandDef = {
  ...sessionCommand,
  subcommands: [...(sessionCommand.subcommands ?? []), ...SESSION_LATER],
};

const titles = {
  workers: "Workers",
  memory: "Memory & projects",
  daemon: "Daemon & setup",
} as const;

export const GROUPS: GroupDef[] = [
  { id: "sessions", title: "Sessions", daily: true, commands: [lsCommand, setupsCommand, openTop, newTop, renameTop, sessionGroup, ...SESSION_SHORTCUTS_LATER] },
  { id: "providers", title: "Providers", daily: true, commands: [providersCommand] },
  { id: "help", title: "Help", daily: true, commands: [moreCommand, helpCommand, docCommand] },
  ...LATER_GROUPS.map((g) => ({ id: g.id, title: titles[g.id as keyof typeof titles], daily: false, commands: g.commands })),
];

// Memory, knowledge and audit commands (one file per group in ./commands).
GROUPS.find((g) => g.id === "memory")!.commands.push(memoryCommand, findCommand, kgCommand, zettelCommand, observationCommand, obsidianCommand, skillCommand);
GROUPS.find((g) => g.id === "daemon")!.commands.push(auditCommand);
