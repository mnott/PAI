/** `pai obsidian ...`: mirror project notes into an Obsidian vault. */

import type { CommandDef, OptDef } from "../define.js";
import { obsidianSyncCmd, obsidianStatusCmd, obsidianOpenCmd } from "../lib/obsidian.js";

const vault: OptDef = { name: "vault", type: "string", value: "PATH", summary: "Use this vault folder instead of the configured one" };

export const obsidianCommand: CommandDef = {
  name: "obsidian",
  summary: "Mirror project notes into an Obsidian vault",
  description: "Keeps an Obsidian vault in step with your project notes so you can browse them there. Sync, check health, or open the vault.",
  examples: ["pai obsidian sync", "pai obsidian status", "pai obsidian open"],
  seeAlso: ["pai zettel", "pai memory search"],
  subcommands: [
    {
      name: "sync",
      summary: "Copy project notes into the vault and rebuild its index pages",
      description: "Links each project's Notes folder into the vault and regenerates the index and topic pages.",
      options: [vault, { name: "quiet", type: "boolean", summary: "Minimal output, for scheduled runs" }],
      examples: ["pai obsidian sync", "pai obsidian sync --quiet"],
      seeAlso: ["pai obsidian status"],
      run: async (ctx) => {
        const { getRegistryBackend } = await import("../../../storage/factory.js");
        const registry = await getRegistryBackend();
        return obsidianSyncCmd(registry, {
          vault: ctx.opts.vault as string | undefined,
          quiet: ctx.opts.quiet === true,
        });
      },
    },
    {
      name: "status",
      summary: "Check the vault: healthy, broken, orphaned and missing links",
      description: "Counts the vault's links by state so you can see whether a sync is needed.",
      options: [{ ...vault, summary: "Check this vault folder instead of the configured one" }],
      examples: ["pai obsidian status", "pai obsidian status --vault ./vault"],
      seeAlso: ["pai obsidian sync"],
      run: async (ctx) => {
        const { getRegistryBackend } = await import("../../../storage/factory.js");
        const registry = await getRegistryBackend();
        return obsidianStatusCmd(registry, {
          vault: ctx.opts.vault as string | undefined,
        });
      },
    },
    {
      name: "open",
      summary: "Open the vault in Obsidian (macOS)",
      description: "Launches Obsidian on the vault folder.",
      options: [{ ...vault, summary: "Open this vault folder instead of the configured one" }],
      examples: ["pai obsidian open", "pai obsidian open --vault ./vault"],
      seeAlso: ["pai obsidian sync"],
      run: (ctx) => {
        return obsidianOpenCmd({
          vault: ctx.opts.vault as string | undefined,
        });
      },
    },
  ],
};
