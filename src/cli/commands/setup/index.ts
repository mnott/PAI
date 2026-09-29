/**
 * PAI setup wizard — main entry point.
 * Orchestrates all setup steps in order and registers the Commander command.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { CONFIG_FILE, loadConfig } from "../../../daemon/config.js";
import { createRl, prompt, promptYesNo, line, mergeConfig, setupOptions } from "./utils.js";
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
  stepTaskBus,
  stepWorkers,
  stepInitialIndex,
  stepSummary,
} from "./steps/index.js";

/** Runs one wizard step; a throw is re-raised naming the step so unattended runs say where they died. */
async function step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`setup step "${name}" failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

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
    await prompt(rl, chalk.dim("  Press Enter to begin setup..."), "");

    // Step 2: Storage
    const storageConfig = await step("stepStorage", () => stepStorage(rl));

    // Step 3: Embeddings
    const embeddingConfig = await step("stepEmbedding", () => stepEmbedding(rl));

    // Step 4: Agent configuration (CLAUDE.md)
    const claudeMdGenerated = await step("stepClaudeMd", () => stepClaudeMd(rl));

    // Step 5: PAI Skill
    const paiSkillInstalled = await step("stepPaiSkill", () => stepPaiSkill(rl));

    // Step 6: AI Steering Rules
    const aiSteeringRulesInstalled = await step("stepAiSteeringRules", () => stepAiSteeringRules(rl));

    // Step 7: Skill Stubs
    const skillStubsInstalled = await step("stepSkillStubs", () => stepSkillStubs(rl));

    // Step 8: Hooks (shell scripts)
    const hooksInstalled = await step("stepHooks", () => stepHooks(rl));

    // Step 7b: TypeScript hooks (.mjs files)
    const tsHooksInstalled = await step("stepTsHooks", () => stepTsHooks(rl));

    // Step 8b: DA name
    const daName = await step("stepDaName", () => stepDaName(rl));

    // Step 8: Settings.json
    const settingsPatched = await step("stepSettings", () => stepSettings(rl, daName));

    // Step 9: Daemon
    const daemonInstalled = await step("stepDaemon", () => stepDaemon(rl));

    // Step 10: MCP
    const mcpRegistered = await step("stepMcp", () => stepMcp(rl));

    // Step 11: Directories (informational — no config written)
    await step("stepDirectories", () => stepDirectories(rl));

    // Step 11b: Task bus (optional external tracker)
    const taskConfig = await step("stepTaskBus", () => stepTaskBus(rl));

    // Step 11c: Worker providers (optional subagent routing)
    const workersConfig = await step("stepWorkers", () => stepWorkers(rl));

    // Write config after gathering all choices
    const allUpdates = { ...storageConfig, ...embeddingConfig, ...taskConfig, ...workersConfig };
    mergeConfig(allUpdates);

    line();
    console.log(chalk.green("  Configuration saved."));

    // Step 12: Initial index
    await step("stepInitialIndex", () => stepInitialIndex(rl));

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
      "Setup wizard — configure storage, embeddings, agent config, and indexing (--yes for unattended)",
    )
    .option("-y, --yes", "Unattended: take every default, read no input")
    .option("--storage <backend>", "Storage backend: sqlite | postgres (default under --yes: sqlite unless local Postgres answers)")
    .action(async (opts: { yes?: boolean; storage?: string }) => {
      if (opts.storage && opts.storage !== "sqlite" && opts.storage !== "postgres") {
        console.error(`pai setup: --storage must be sqlite or postgres, got "${opts.storage}"`);
        process.exitCode = 1;
        return;
      }
      setupOptions.yes = opts.yes === true;
      setupOptions.storage = opts.storage as "sqlite" | "postgres" | undefined;
      try {
        await runSetup();
      } catch (e) {
        console.error(chalk.red(`pai setup: ${e instanceof Error ? e.message : String(e)}`));
        process.exitCode = 1;
      }
    });
}
