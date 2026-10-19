/**
 * `pai home`: front end for the PAI home commands.
 * Behaviour lives in src/cli/impl/home.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import { homeMigrateCmd, homePathCmd } from "../impl/home.js";

export const homeSubcommands: CommandDef[] = [
  {
    name: "path",
    summary: "Print where PAI's home is",
    description: "Print where PAI's home is.\n\nThe resolved PAI_HOME: $PAI_HOME, else ~/.pai, else ~/.claude/pai until `pai home migrate` has run.",
    examples: ["pai home path"],
    seeAlso: ["pai home migrate"],
    run: () => homePathCmd(),
  },
  {
    name: "migrate",
    summary: "Move PAI's home from ~/.claude/pai to ~/.pai",
    description:
      "Move PAI's home from ~/.claude/pai to ~/.pai.\n\nRefuses while the daemon, router or any worker runs. Renames every entry of ~/.claude/pai into ~/.pai (stops on name clashes; ~/.pai/pgdata is never touched), moves leftovers (*.migrated-*, *.bak*, tarballs) to ~/.pai/attic/<date>/, leaves ~/.claude/pai as a symlink to ~/.pai, rewrites ~/.claude/pai paths in config.yaml, workers.yaml and PAI's launchd plists, and prints a before/after table. See docs/pai-home.md.",
    options: [{ name: "dry-run", type: "boolean", summary: "Print exactly what would happen, change nothing" }],
    examples: ["pai home migrate --dry-run", "pai home migrate"],
    seeAlso: ["pai home path", "pai config migrate"],
    run: (ctx) => homeMigrateCmd({ dryRun: ctx.opts["dry-run"] === true }),
  },
];

export const homeCommand: CommandDef = {
  name: "home",
  summary: "Where PAI keeps its files; move them out of ~/.claude",
  description: "Where PAI keeps its files; move them out of ~/.claude.",
  examples: ["pai home path", "pai home migrate --dry-run"],
  subcommands: homeSubcommands,
};
