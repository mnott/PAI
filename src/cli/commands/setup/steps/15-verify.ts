/** Step 18: Setup summary — displays all configuration choices made during setup. */

import chalk from "chalk";
import { CONFIG_FILE } from "../../../../daemon/config.js";
import { daemonServiceName } from "../../../impl/daemon.js";
import { line, section } from "../utils.js";
import type { AibrokerStatus } from "./18-aibroker.js";

export function stepSummary(
  configUpdates: Record<string, unknown>,
  claudeMdGenerated: boolean,
  paiSkillInstalled: boolean,
  aiSteeringRulesInstalled: boolean,
  skillStubsInstalled: boolean,
  hooksInstalled: boolean,
  tsHooksInstalled: boolean,
  settingsPatched: boolean,
  daName: string,
  daemonInstalled: boolean,
  mcpRegistered: boolean,
  plat: NodeJS.Platform = process.platform,
  aibroker?: AibrokerStatus,
  failures: readonly string[] = [],
): void {
  section("Setup Complete");
  line();
  console.log(chalk.green("  PAI Knowledge OS is configured!"));
  line();

  const backend = configUpdates.storageBackend as string;
  const model = configUpdates.embeddingModel as string;

  line(chalk.bold("  Configuration saved to: ") + chalk.dim(CONFIG_FILE));
  line();
  console.log(chalk.dim("  Storage backend:  ") + chalk.cyan(backend ?? "sqlite"));
  console.log(chalk.dim("  Embedding model:  ") + chalk.cyan(model && model !== "none" ? model : "(none — keyword search only)"));
  console.log(chalk.dim("  CLAUDE.md:        ") + chalk.cyan(claudeMdGenerated ? "~/.claude/CLAUDE.md (generated)" : "(unchanged)"));
  console.log(chalk.dim("  PAI skill:        ") + chalk.cyan(paiSkillInstalled ? "~/.claude/skills/PAI/SKILL.md (installed)" : "(unchanged)"));
  console.log(chalk.dim("  Steering rules:   ") + chalk.cyan(aiSteeringRulesInstalled ? "~/.claude/skills/PAI/AI-STEERING-RULES.md (installed)" : "(unchanged)"));
  console.log(chalk.dim("  Skill stubs:      ") + chalk.cyan(skillStubsInstalled ? "MCP prompt stubs symlinked to ~/.claude/skills/" : "(unchanged)"));
  console.log(chalk.dim("  Hooks (shell):    ") + chalk.cyan(hooksInstalled ? "pai-pre-compact.sh, pai-session-stop.sh (installed)" : "(unchanged)"));
  console.log(chalk.dim("  Hooks (TS):       ") + chalk.cyan(tsHooksInstalled ? ".mjs hooks installed to ~/.claude/Hooks/" : "(unchanged)"));
  console.log(chalk.dim("  Assistant name:   ") + chalk.cyan(daName));
  console.log(chalk.dim("  Settings:         ") + chalk.cyan(settingsPatched ? "env vars, hooks, permissions, flags (patched)" : "(unchanged)"));
  console.log(chalk.dim("  Daemon:           ") + chalk.cyan(daemonInstalled ? `${daemonServiceName(plat)} (installed)` : "(not installed by setup)"));
  console.log(chalk.dim("  MCP:              ") + chalk.cyan(mcpRegistered ? "registered in ~/.claude.json" : "(unchanged)"));
  if (aibroker) {
    const label = { ok: "installed and healthy", installed: "installed", skipped: "skipped", failed: "FAILED — retry: npm install -g aibroker@^0.62.4 && aibroker setup && aibroker doctor" }[aibroker];
    console.log(chalk.dim("  AIBroker:         ") + (aibroker === "failed" ? chalk.red(label) : chalk.cyan(label)));
  }
  for (const f of failures) console.log(chalk.red(`  ${f}`));
  line();
  console.log(chalk.bold.yellow("  → RESTART Claude Code to activate all changes."));
  line();

  line(chalk.bold("  Next steps:"));
  line();
  console.log(chalk.dim("    # Register a project"));
  console.log(chalk.cyan("    pai project add ~/your/project"));
  line();
  console.log(chalk.dim("    # Index your files"));
  console.log(chalk.cyan("    pai memory index --all"));
  line();
  console.log(chalk.dim("    # Search your knowledge"));
  console.log(chalk.cyan("    pai memory search \"your query\""));
  line();
  if (model && model !== "none") {
    console.log(chalk.dim("    # Generate embeddings for semantic search"));
    console.log(chalk.cyan("    pai memory embed"));
    line();
    console.log(chalk.dim("    # Semantic search"));
    console.log(chalk.cyan("    pai memory search --mode semantic \"your query\""));
    line();
  }
  console.log(chalk.dim("    # Start the background daemon"));
  console.log(chalk.cyan("    pai daemon serve"));
  line();
  console.log(chalk.dim("    # Show all commands"));
  console.log(chalk.cyan("    pai --help"));
  line();
}
