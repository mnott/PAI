/**
 * Placeholders for every old command not yet ported. Each entry keeps the
 * old name (and its summary from src/cli/program.ts) so the port workers
 * have a checklist and `pai help more` shows the whole surface. Running one
 * says to use the old `pai`.
 */

import type { CommandDef, GroupDef } from "../define.js";

const later = (name: string, summary: string, oldCommand = name): CommandDef => ({
  name,
  summary,
  description: summary,
  examples: [`pai ${oldCommand}`],
  later: oldCommand,
});

export const SESSION_LATER: CommandDef[] = [
];

export const SESSION_SHORTCUTS_LATER: CommandDef[] = [
];


export const LATER_GROUPS: Pick<GroupDef, "id" | "commands">[] = [
  {
    id: "workers",
    commands: [
    ],
  },
  {
    id: "memory",
    commands: [
    ],
  },
  {
    id: "daemon",
    commands: [
    ],
  },
];
