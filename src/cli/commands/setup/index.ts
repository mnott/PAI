/**
 * PAI setup wizard — main entry point.
 * Orchestrates all setup steps in order and registers the Commander command.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { CONFIG_FILE, loadConfig } from "../../../daemon/config.js";
import { createRl, prompt, promptYesNo, line, mergeConfig } from "./utils.js";
import {
  stepWelcome,
  stepStorage,
  stepEmbedding,
  stepClaudeMd,
  stepPaiSkill,
  stepAiSteeringRules,
  stepSkillStubs,
  stepHooks,
  stepTsHooks,
  stepDaName,
  stepSettings,
  stepDaemon,
  stepMcp,
  stepDirectories,
  stepInitialIndex,
  stepSummary,
} from "./steps/index.js";

async function runSetup(): Promise<void> {
  const rl = createRl();

  try {
    if (existsSync(CONFIG_FILE)) {
      const current = loadConfig();
      line();
      console.log(
        chalk.yellow("  Note: PAI is already configured.") +
        chalk.dim(" Proceeding will update your existing configuration."),
      );
      console.log(chalk.dim(`  Config: ${CONFIG_FILE}`));
      console.log(chalk.dim(`  Current backend: ${current.storageBackend}`));
      line();

      const proceed = await promptYesNo(rl, "Continue and update configuration?", true);
      if (!proceed) {
        rl.close();
        line(chalk.dim("  Setup cancelled."));
        line();
        return;
      }
    }

    // Step 1: Welcome
    stepWelcome();
    line();
    await prompt(rl, chalk.dim("  Press Enter to begin setup..."));

    // Step 2: Storage
    const storageConfig = await stepStorage(rl);

    // Step 3: Embeddings
    const embeddingConfig = await stepEmbedding(rl);

    // Step 4: Agent configuration (CLAUDE.md)
    const claudeMdGenerated = await stepClaudeMd(rl);

    // Step 5: PAI Skill
    const paiSkillInstalled = await stepPaiSkill(rl);

    // Step 6: AI Steering Rules
    const aiSteeringRulesInstalled = await stepAiSteeringRules(rl);

    // Step 7: Skill Stubs
    const skillStubsInstalled = await stepSkillStubs(rl);

    // Step 8: Hooks (shell scripts)
    const hooksInstalled = await stepHooks(rl);

    // Step 7b: TypeScript hooks (.mjs files)
    const tsHooksInstalled = await stepTsHooks(rl);

    // Step 8b: DA name
    const daName = await stepDaName(rl);

    // Step 8: Settings.json
    const settingsPatched = await stepSettings(rl, daName);

    // Step 9: Daemon
    const daemonInstalled = await stepDaemon(rl);

    // Step 10: MCP
    const mcpRegistered = await stepMcp(rl);

    // Step 11: Directories (informational — no config written)
    await stepDirectories(rl);

    // Write config after gathering all choices
    const allUpdates = { ...storageConfig, ...embeddingConfig };
    mergeConfig(allUpdates);

    line();
    console.log(chalk.green("  Configuration saved."));

    // Step 12: Initial index
    await stepInitialIndex(rl);

    // Step 13: Summary
    stepSummary(
      allUpdates,
      claudeMdGenerated,
      paiSkillInstalled,
      aiSteeringRulesInstalled,
      skillStubsInstalled,
      hooksInstalled,
      tsHooksInstalled,
      settingsPatched,
      daName,
      daemonInstalled,
      mcpRegistered,
    );

  } finally {
    rl.close();
  }
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .alias("install")
    .description(
      "Interactive setup wizard — configure storage, embeddings, agent config, and indexing",
    )
    .action(async () => {
      await runSetup();
    });
}
