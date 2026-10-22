/** `pai setup`: the first-time setup wizard (steps live in ./setup/). */

import chalk from "chalk";
import type { CommandDef } from "../define.js";
import { legacy } from "../lib/legacy.js";
import { runSetup } from "./setup/index.js";
import { setupOptions } from "./setup/utils.js";

export const setupCommand: CommandDef = {
  name: "setup",
  summary: "First-time setup: storage, search, hooks, daemon",
  description:
    "Walks through everything PAI needs: where data is stored, search embeddings, Claude Code hooks and settings, the background daemon, AIBroker (messaging; installed automatically) and the first index.\n" +
    "Safe to run again. With --yes it takes every default and asks nothing.",
  options: [
    { name: "yes", short: "y", type: "boolean", default: false, summary: "Take every default and read no input" },
    { name: "storage", type: "string", value: "BACKEND", summary: "Where to store data: sqlite or postgres (with --yes: sqlite unless a local Postgres answers)" },
    { name: "no-aibroker", type: "boolean", default: false, summary: "Do not install AIBroker (the messaging layer)" },
    { name: "dry-run", type: "boolean", default: false, summary: "Print the AIBroker install commands and change nothing" },
  ],
  examples: ["pai setup", "pai setup --yes --storage sqlite"],
  seeAlso: ["pai update", "pai daemon status"],
  run(c) {
    const storage = c.opts.storage as string | undefined;
    return legacy(async () => {
      if (storage && storage !== "sqlite" && storage !== "postgres") {
        console.error(`pai setup: --storage must be sqlite or postgres, got "${storage}"`);
        process.exitCode = 1;
        return;
      }
      setupOptions.yes = c.opts.yes === true;
      setupOptions.noAibroker = c.opts["no-aibroker"] === true;
      setupOptions.dryRun = c.opts["dry-run"] === true;
      setupOptions.storage = storage as "sqlite" | "postgres" | undefined;
      try {
        await runSetup();
      } catch (e) {
        console.error(chalk.red(`pai setup: ${e instanceof Error ? e.message : String(e)}`));
        process.exitCode = 1;
      }
    });
  },
};

export const installAlias: CommandDef = { ...setupCommand, name: "install", aliasOf: "setup" };
