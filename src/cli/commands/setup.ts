/**
 * pai setup — Interactive setup wizard for PAI Knowledge OS
 *
 * Guides new users through:
 *   1.  Welcome and overview
 *   2.  Storage backend selection (PostgreSQL/SQLite)
 *   3.  Embedding model selection
 *   4.  Agent configuration (CLAUDE.md generation)
 *   5.  PAI skill installation (~/.claude/skills/PAI/SKILL.md)
 *   6.  AI steering rules installation (~/.claude/skills/PAI/AI-STEERING-RULES.md)
 *   6b. CORE skill installation (~/.claude/Skills/CORE/)
 *   7.  Hook scripts (shell: pre-compact, session-stop, statusline)
 *   7b. TypeScript hooks installation (compiled .mjs hooks to ~/.claude/Hooks/)
 *   8.  Settings.json patching (env vars, all 17 hook registrations, permissions, flags)
 *   8b. DA name prompt (assistant name stored in env.DA)
 *   9.  Daemon install (launchd plist)
 *   10. MCP registration (~/.claude.json)
 *   11. Directory scanning configuration
 *   12. Initial index (optional)
 *   13. Summary and next steps
 */

import type { Command } from "commander";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import chalk from "chalk";
import { CONFIG_DIR, CONFIG_FILE, loadConfig } from "../../daemon/config.js";
import { mergeSettings } from "./settings-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const c = {
  bold: (s: string) => chalk.bold(s),
  dim: (s: string) => chalk.dim(s),
  green: (s: string) => chalk.green(s),
  yellow: (s: string) => chalk.yellow(s),
  cyan: (s: string) => chalk.cyan(s),
  red: (s: string) => chalk.red(s),
  blue: (s: string) => chalk.blue(s),
  ok: (s: string) => chalk.green("  " + s),
  warn: (s: string) => chalk.yellow("  " + s),
  err: (s: string) => chalk.red("  " + s),
};

function line(text = "") {
  console.log(text);
}

function section(title: string) {
  line();
  console.log(chalk.bold.cyan("  " + title));
  console.log(chalk.dim("  " + "─".repeat(title.length)));
}

// ---------------------------------------------------------------------------
// Readline prompt helper
// ---------------------------------------------------------------------------

function createRl() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Handle Ctrl+C gracefully
  rl.on("SIGINT", () => {
    line();
    line(c.dim("  Setup cancelled. Run `pai setup` again to restart."));
    line();
    process.exit(0);
  });

  return rl;
}

async function prompt(rl: ReturnType<typeof createRl>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for a numbered menu selection.
 * Returns the 0-based index of the selected option, or defaultIdx if empty input.
 */
async function promptMenu(
  rl: ReturnType<typeof createRl>,
  options: Array<{ label: string; description?: string }>,
  defaultIdx = 0,
): Promise<number> {
  for (let i = 0; i < options.length; i++) {
    const num = chalk.bold(`  ${i + 1}.`);
    const label = i === defaultIdx ? chalk.cyan(options[i].label) : options[i].label;
    const marker = i === defaultIdx ? chalk.dim(" (recommended)") : "";
    console.log(`${num} ${label}${marker}`);
    if (options[i].description) {
      console.log(chalk.dim(`     ${options[i].description}`));
    }
  }
  line();

  while (true) {
    const answer = await prompt(
      rl,
      chalk.bold(`  Enter number [1-${options.length}] (default: ${defaultIdx + 1}): `),
    );

    if (answer === "") return defaultIdx;

    const n = parseInt(answer, 10);
    if (!isNaN(n) && n >= 1 && n <= options.length) {
      return n - 1;
    }

    console.log(c.warn(`Please enter a number between 1 and ${options.length}.`));
  }
}

/**
 * Prompt for a yes/no answer. Returns true for yes.
 */
async function promptYesNo(
  rl: ReturnType<typeof createRl>,
  question: string,
  defaultYes = true,
): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await prompt(rl, `  ${question} ${chalk.dim(hint)}: `);

  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

// ---------------------------------------------------------------------------
// Config read/write helpers
// ---------------------------------------------------------------------------

function readConfigRaw(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeConfigRaw(data: Record<string, unknown>): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function mergeConfig(updates: Record<string, unknown>): void {
  const current = readConfigRaw();
  const merged = { ...current, ...updates };
  // Merge nested postgres object if present
  if (updates.postgres && typeof current.postgres === "object" && current.postgres !== null) {
    merged.postgres = { ...(current.postgres as object), ...(updates.postgres as object) };
  }
  writeConfigRaw(merged);
}

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

function hasDocker(): boolean {
  try {
    const result = spawnSync("docker", ["--version"], { stdio: "pipe" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getDockerDir(): string {
  // Find the docker/ directory relative to the installed package
  // When running from dist/cli/index.mjs, go up to find docker/
  // Try common locations: cwd, parent dirs, and npm install paths
  const candidates = [
    join(process.cwd(), "docker"),
    join(homedir(), "dev", "ai", "PAI", "docker"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "docker"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "docker-compose.yml"))) return c;
  }
  return join(process.cwd(), "docker");
}

function getTemplatesDir(): string {
  // Find the templates/ directory relative to the installed package
  const candidates = [
    join(process.cwd(), "templates"),
    join(homedir(), "dev", "ai", "PAI", "templates"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "templates"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "claude-md.template.md"))) return c;
  }
  return join(process.cwd(), "templates");
}

function getHooksDir(): string {
  // Find the src/hooks/ directory relative to the installed package
  const candidates = [
    join(process.cwd(), "src", "hooks"),
    join(homedir(), "dev", "ai", "PAI", "src", "hooks"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "src", "hooks"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "session-stop.sh"))) return c;
  }
  return join(process.cwd(), "src", "hooks");
}

function getDistHooksDir(): string {
  // Find the dist/hooks/ directory — where compiled TypeScript hooks (.mjs) live.
  // When running from dist/cli/index.mjs, import.meta.url points to that file.
  // Go up two levels: dist/cli/ → dist/ → package root, then into dist/hooks/.
  const moduleDir = new URL(".", import.meta.url).pathname;
  // moduleDir is something like /path/to/pai/dist/cli/
  const fromModule = join(moduleDir, "..", "hooks");

  const candidates = [
    fromModule,
    join(process.cwd(), "dist", "hooks"),
    join(homedir(), "dev", "ai", "PAI", "dist", "hooks"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "dist", "hooks"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "stop-hook.mjs"))) return candidate;
  }
  return fromModule;
}

function getStatuslineScript(): string | null {
  const candidates = [
    join(process.cwd(), "statusline-command.sh"),
    join(homedir(), "dev", "ai", "PAI", "statusline-command.sh"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "statusline-command.sh"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function getTabColorScript(): string | null {
  const candidates = [
    join(process.cwd(), "tab-color-command.sh"),
    join(homedir(), "dev", "ai", "PAI", "tab-color-command.sh"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "tab-color-command.sh"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function startDocker(rl: ReturnType<typeof createRl>): Promise<boolean> {
  const dockerDir = getDockerDir();
  const composePath = join(dockerDir, "docker-compose.yml");

  if (!existsSync(composePath)) {
    console.log(c.warn(`docker-compose.yml not found at ${dockerDir}`));
    console.log(c.dim("  You can start it manually later:"));
    console.log(c.dim("    docker compose up -d"));
    return false;
  }

  console.log(c.dim(`  Starting PostgreSQL container from ${dockerDir}...`));

  try {
    const result = spawnSync("docker", ["compose", "up", "-d"], {
      cwd: dockerDir,
      stdio: "inherit",
    });

    if (result.status !== 0) {
      console.log(c.warn("  Docker compose failed. You can start it manually:"));
      console.log(c.dim(`    cd ${dockerDir} && docker compose up -d`));
      return false;
    }

    console.log(c.ok("PostgreSQL container started."));
    return true;
  } catch (e) {
    console.log(c.warn(`  Could not run docker compose: ${e}`));
    return false;
  }
}

async function testPostgresConnection(connectionString: string): Promise<boolean> {
  // Quick connection test using pg
  try {
    const pgModule = await import("pg");
    const pg = pgModule.default ?? pgModule;
    const client = new pg.Client({ connectionString });
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Step 1: Welcome banner and overview
 */
function stepWelcome(): void {
  line();
  line(chalk.bold.cyan("  ╔════════════════════════════════════════╗"));
  line(chalk.bold.cyan("  ║      PAI Knowledge OS — Setup Wizard  ║"));
  line(chalk.bold.cyan("  ╚════════════════════════════════════════╝"));
  line();
  line(
    "  PAI is a personal knowledge system that indexes your files, generates",
  );
  line(
    "  semantic embeddings for intelligent search, and stores everything in a",
  );
  line(
    "  local database so you can search your knowledge base with natural language.",
  );
  line();
  line(c.dim("  This wizard will guide you through the initial configuration."));
  line(c.dim("  Press Ctrl+C at any time to cancel."));
}

/**
 * Step 2: Storage backend selection
 */
async function stepStorage(rl: ReturnType<typeof createRl>): Promise<Record<string, unknown>> {
  section("Step 2: Storage Backend");

  // Idempotency: check if config already exists with a storage backend
  const existing = readConfigRaw();
  if (existing.storageBackend) {
    const backend = String(existing.storageBackend);
    if (backend === "postgres") {
      // Verify container is running
      try {
        const result = spawnSync("docker", ["ps", "--filter", "name=pai-pgvector", "--format", "{{.Status}}"], { stdio: "pipe" });
        const status = result.stdout?.toString().trim();
        if (status && status.includes("Up")) {
          console.log(c.ok(`Storage backend: PostgreSQL (container running). Skipping.`));
          return existing;
        }
        // Container exists but not running — try to start it
        console.log(c.dim("  PostgreSQL container found but not running. Starting..."));
        await startDocker(rl);
        await new Promise((r) => setTimeout(r, 3000));
        console.log(c.ok("PostgreSQL container started."));
      } catch {
        console.log(c.ok(`Storage backend: PostgreSQL (configured). Skipping.`));
      }
      return existing;
    } else {
      console.log(c.ok(`Storage backend: ${backend}. Skipping.`));
      return existing;
    }
  }

  line();
  line("  Choose how PAI stores your indexed knowledge:");
  line();

  const choice = await promptMenu(rl, [
    {
      label: "PostgreSQL with pgvector",
      description:
        "Best for large collections, semantic search, and production use. Requires Docker or a Postgres server.",
    },
    {
      label: "SQLite",
      description:
        "Simple, no dependencies, zero configuration. Good for trying PAI out. Keyword search only.",
    },
  ]);

  if (choice === 1) {
    // SQLite
    line();
    console.log(c.ok("SQLite selected. No additional setup needed."));
    return { storageBackend: "sqlite" };
  }

  // PostgreSQL
  line();
  line("  PostgreSQL requires a running Postgres server with the pgvector extension.");
  line();

  if (hasDocker()) {
    console.log(c.ok("Docker is installed."));
    line();

    const useDocker = await promptYesNo(
      rl,
      "Start the PAI PostgreSQL container with Docker? (recommended)",
      true,
    );

    if (useDocker) {
      line();
      await startDocker(rl);
      line();

      // Brief wait for container to start
      console.log(c.dim("  Waiting 3 seconds for container to be ready..."));
      await new Promise((r) => setTimeout(r, 3000));

      const connStr = "postgresql://pai:pai@localhost:5432/pai";
      console.log(c.dim(`  Testing connection to ${connStr}...`));

      const ok2 = await testPostgresConnection(connStr);
      if (ok2) {
        console.log(c.ok("Connection successful!"));
        return {
          storageBackend: "postgres",
          postgres: { connectionString: connStr },
        };
      } else {
        console.log(c.warn("Connection test failed. The container may still be starting."));
        console.log(c.dim("  Using default connection string — you can verify with `pai daemon status`."));
        return {
          storageBackend: "postgres",
          postgres: { connectionString: connStr },
        };
      }
    }
  } else {
    console.log(c.dim("  Docker not found. Using manual connection string entry."));
  }

  // Manual connection string entry
  line();
  line("  Enter your PostgreSQL connection details:");
  line();

  const useConnStr = await promptYesNo(
    rl,
    "Use a full connection string? (e.g. postgresql://user:pass@host:5432/dbname)",
    true,
  );

  if (useConnStr) {
    const connStr = await prompt(
      rl,
      chalk.bold("  Connection string: "),
    );

    if (connStr) {
      console.log(c.dim("  Testing connection..."));
      const connected = await testPostgresConnection(connStr);
      if (connected) {
        console.log(c.ok("Connection successful!"));
      } else {
        console.log(c.warn("Connection test failed — check credentials and try again later."));
      }
      return {
        storageBackend: "postgres",
        postgres: { connectionString: connStr },
      };
    }
  }

  // Field-by-field entry
  const host = await prompt(rl, chalk.bold("  Host [localhost]: ")) || "localhost";
  const portStr = await prompt(rl, chalk.bold("  Port [5432]: ")) || "5432";
  const database = await prompt(rl, chalk.bold("  Database [pai]: ")) || "pai";
  const user = await prompt(rl, chalk.bold("  User [pai]: ")) || "pai";
  const password = await prompt(rl, chalk.bold("  Password [pai]: ")) || "pai";

  const connStr = `postgresql://${user}:${password}@${host}:${portStr}/${database}`;

  console.log(c.dim(`  Connection string: ${connStr}`));
  console.log(c.dim("  Testing connection..."));

  const connected = await testPostgresConnection(connStr);
  if (connected) {
    console.log(c.ok("Connection successful!"));
  } else {
    console.log(c.warn("Connection test failed — check credentials and try again later."));
  }

  return {
    storageBackend: "postgres",
    postgres: { connectionString: connStr },
  };
}

/**
 * Step 3: Embedding model selection
 */
async function stepEmbedding(rl: ReturnType<typeof createRl>): Promise<Record<string, unknown>> {
  section("Step 3: Embedding Model");

  // Idempotency: check if embedding model is already configured
  const existing = readConfigRaw();
  if (existing.embeddingModel) {
    console.log(c.ok(`Embedding model: ${existing.embeddingModel}. Skipping.`));
    return { embeddingModel: existing.embeddingModel };
  }

  line();
  line(
    "  An embedding model converts your text into vectors for semantic search.",
  );
  line(
    "  Models are downloaded from HuggingFace on first use.",
  );
  line();

  const choice = await promptMenu(rl, [
    {
      label: "Snowflake Arctic Embed m v1.5",
      description:
        "768 dims, ~118MB download. Best retrieval quality per MB (MTEB score 55.14). " +
        "Asymmetric retrieval — different handling for queries vs documents. Best for most users.",
    },
    {
      label: "BGE Small EN v1.5",
      description:
        "384 dims, ~32MB download. Lightweight and fast. Good for limited disk space " +
        "or when faster embedding is more important than maximum quality. English only.",
    },
    {
      label: "Nomic Embed Text v1.5",
      description:
        "768 dims, ~100MB download. 8K token context window — excellent for long documents. " +
        "Matryoshka dimensions (can truncate for speed/size tradeoffs).",
    },
    {
      label: "None — skip embeddings",
      description:
        "BM25/keyword search only. No model download needed. You can add embeddings later " +
        "by running `pai memory embed` after selecting a model.",
    },
  ]);

  const models: Record<number, string | null> = {
    0: "Snowflake/snowflake-arctic-embed-m-v1.5",
    1: "BAAI/bge-small-en-v1.5",
    2: "nomic-ai/nomic-embed-text-v1.5",
    3: null,
  };

  const selectedModel = models[choice];

  line();
  if (selectedModel) {
    console.log(c.ok(`Model selected: ${selectedModel}`));
    console.log(c.dim("  The model will be downloaded on first use of `pai memory embed`."));
  } else {
    console.log(c.ok("Skipping embeddings. Keyword search will still work."));
    console.log(c.dim("  Add later: update embeddingModel in ~/.config/pai/config.json"));
  }

  return {
    embeddingModel: selectedModel ?? "none",
  };
}

/**
 * Step 4: Agent configuration — generate ~/.claude/CLAUDE.md from template
 */
async function stepClaudeMd(rl: ReturnType<typeof createRl>): Promise<boolean> {
  section("Step 4: Agent Configuration (CLAUDE.md)");
  line();
  line(
    "  PAI ships a CLAUDE.md template with agent orchestration patterns:",
  );
  line(
    "  swarm mode, model escalation, parallel execution, quality standards.",
  );
  line();

  const claudeDir = join(homedir(), ".claude");
  const claudeMd = join(claudeDir, "CLAUDE.md");
  const agentPrefs = join(CONFIG_DIR, "agent-prefs.md");
  const templatesDir = getTemplatesDir();
  const templatePath = join(templatesDir, "claude-md.template.md");

  if (!existsSync(templatePath)) {
    console.log(c.warn("Template not found: " + templatePath));
    console.log(c.dim("  Skipping CLAUDE.md generation. You can copy it manually from templates/."));
    return false;
  }

  // Check existing CLAUDE.md
  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, "utf-8");
    const isGenerated = content.includes("Generated by PAI Setup");
    if (isGenerated) {
      console.log(c.dim("  Found existing PAI-generated CLAUDE.md."));
    } else {
      console.log(c.yellow("  Found existing CLAUDE.md (custom, not PAI-generated)."));
      console.log(c.dim("  A backup will be created before overwriting."));
    }
    line();

    const overwrite = await promptYesNo(
      rl,
      "Update ~/.claude/CLAUDE.md with the latest PAI template?",
      isGenerated, // default yes if already generated, no if custom
    );

    if (!overwrite) {
      console.log(c.dim("  Keeping existing CLAUDE.md unchanged."));
      return false;
    }

    // Backup custom CLAUDE.md
    if (!isGenerated) {
      const backupPath = claudeMd + ".backup";
      writeFileSync(backupPath, content, "utf-8");
      console.log(c.ok(`Backed up existing CLAUDE.md to ${backupPath}`));
    }
  }

  // Read template
  let template = readFileSync(templatePath, "utf-8");

  // Substitute ${HOME} with actual home directory
  template = template.replace(/\$\{HOME\}/g, homedir());

  // Write CLAUDE.md
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }
  writeFileSync(claudeMd, template, "utf-8");

  line();
  console.log(c.ok("Generated ~/.claude/CLAUDE.md from PAI template."));

  // Check for agent-prefs.md
  if (!existsSync(agentPrefs)) {
    line();
    line("  For personal settings (project mappings, notification preferences),");
    line("  copy the example and customize:");
    line();
    console.log(chalk.cyan(`    cp ${templatesDir}/agent-prefs.example.md ${agentPrefs}`));
    line();

    const createPrefs = await promptYesNo(
      rl,
      "Copy the example agent-prefs.md now?",
      true,
    );

    if (createPrefs) {
      const examplePath = join(templatesDir, "agent-prefs.example.md");
      if (existsSync(examplePath)) {
        if (!existsSync(CONFIG_DIR)) {
          mkdirSync(CONFIG_DIR, { recursive: true });
        }
        writeFileSync(agentPrefs, readFileSync(examplePath, "utf-8"), "utf-8");
        console.log(c.ok(`Created ${agentPrefs}`));
        console.log(c.dim("  Edit this file to add your personal preferences and project mappings."));
      } else {
        console.log(c.warn("Example file not found. Create agent-prefs.md manually."));
      }
    }
  } else {
    console.log(c.dim("  Personal preferences: " + agentPrefs));
  }

  return true;
}

/**
 * Step 5: PAI skill installation (~/.claude/skills/PAI/SKILL.md)
 */
async function stepPaiSkill(rl: ReturnType<typeof createRl>): Promise<boolean> {
  section("Step 5: PAI Skill Installation");
  line();
  line("  PAI ships a SKILL.md that tells Claude Code how to invoke PAI commands.");
  line();

  const templatesDir = getTemplatesDir();
  const templatePath = join(templatesDir, "pai-skill.template.md");

  if (!existsSync(templatePath)) {
    console.log(c.warn("Skill template not found: " + templatePath));
    console.log(c.dim("  Skipping PAI skill installation."));
    return false;
  }

  const skillDir = join(homedir(), ".claude", "skills", "PAI");
  const skillFile = join(skillDir, "SKILL.md");

  if (existsSync(skillFile)) {
    const content = readFileSync(skillFile, "utf-8");
    const isGenerated = content.includes("Generated by PAI Setup");
    if (isGenerated) {
      console.log(c.dim("  Found existing PAI-generated SKILL.md."));
    } else {
      console.log(c.yellow("  Found existing SKILL.md (not PAI-generated)."));
      console.log(c.dim("  A backup will be created before overwriting."));
    }
    line();

    const overwrite = await promptYesNo(
      rl,
      "Update ~/.claude/skills/PAI/SKILL.md with the latest PAI skill?",
      isGenerated,
    );

    if (!overwrite) {
      console.log(c.dim("  Keeping existing SKILL.md unchanged."));
      return false;
    }

    if (!isGenerated) {
      const backupPath = skillFile + ".backup";
      writeFileSync(backupPath, content, "utf-8");
      console.log(c.ok(`Backed up existing SKILL.md to ${backupPath}`));
    }
  } else {
    const install = await promptYesNo(
      rl,
      "Install PAI skill to ~/.claude/skills/PAI/SKILL.md?",
      true,
    );

    if (!install) {
      console.log(c.dim("  Skipping PAI skill installation."));
      return false;
    }
  }

  // Read template and substitute ${HOME}
  let template = readFileSync(templatePath, "utf-8");
  template = template.replace(/\$\{HOME\}/g, homedir());

  // Write skill file
  if (!existsSync(skillDir)) {
    mkdirSync(skillDir, { recursive: true });
  }
  writeFileSync(skillFile, template, "utf-8");

  line();
  console.log(c.ok("Installed ~/.claude/skills/PAI/SKILL.md"));
  return true;
}

/**
 * Step 6: AI Steering Rules installation (~/.claude/skills/PAI/AI-STEERING-RULES.md)
 */
async function stepAiSteeringRules(rl: ReturnType<typeof createRl>): Promise<boolean> {
  section("Step 6: AI Steering Rules");
  line();
  line("  PAI ships a set of universal behavioral rules for AI assistants:");
  line("  surgical fixes, verification before assertion, root cause analysis,");
  line("  and honest failure modes. These rules load at startup as a skill.");
  line();

  const templatesDir = getTemplatesDir();
  const templatePath = join(templatesDir, "ai-steering-rules.template.md");

  if (!existsSync(templatePath)) {
    console.log(c.warn("AI steering rules template not found: " + templatePath));
    console.log(c.dim("  Skipping AI steering rules installation."));
    return false;
  }

  const skillDir = join(homedir(), ".claude", "skills", "PAI");
  const skillFile = join(skillDir, "AI-STEERING-RULES.md");

  if (existsSync(skillFile)) {
    const content = readFileSync(skillFile, "utf-8");
    const isGenerated = content.includes("Generated by PAI Setup");
    if (isGenerated) {
      console.log(c.dim("  Found existing PAI-generated AI-STEERING-RULES.md."));
    } else {
      console.log(c.yellow("  Found existing AI-STEERING-RULES.md (not PAI-generated)."));
      console.log(c.dim("  A backup will be created before overwriting."));
    }
    line();

    const overwrite = await promptYesNo(
      rl,
      "Update ~/.claude/skills/PAI/AI-STEERING-RULES.md with the latest rules?",
      isGenerated,
    );

    if (!overwrite) {
      console.log(c.dim("  Keeping existing AI-STEERING-RULES.md unchanged."));
      return false;
    }

    if (!isGenerated) {
      const backupPath = skillFile + ".backup";
      writeFileSync(backupPath, content, "utf-8");
      console.log(c.ok(`Backed up existing AI-STEERING-RULES.md to ${backupPath}`));
    }
  } else {
    const install = await promptYesNo(
      rl,
      "Install AI steering rules to ~/.claude/skills/PAI/AI-STEERING-RULES.md?",
      true,
    );

    if (!install) {
      console.log(c.dim("  Skipping AI steering rules installation."));
      return false;
    }
  }

  // Read template (no substitutions needed for this template)
  const template = readFileSync(templatePath, "utf-8");

  // Write skill file (skillDir may already exist from stepPaiSkill, but ensure it)
  if (!existsSync(skillDir)) {
    mkdirSync(skillDir, { recursive: true });
  }
  writeFileSync(skillFile, template, "utf-8");

  line();
  console.log(c.ok("Installed ~/.claude/skills/PAI/AI-STEERING-RULES.md"));
  return true;
}

/**
 * Step 6b: CORE skill installation (~/.claude/Skills/CORE/)
 *
 * Installs the CORE skill template and supporting docs from templates/skills/CORE/
 * to ~/.claude/Skills/CORE/. Also creates the user skills directory at
 * ~/.claude/Skills/user/ if it doesn't exist.
 */
async function stepCoreSkill(rl: ReturnType<typeof createRl>): Promise<boolean> {
  section("Step 6b: CORE Skill Installation");
  line();
  line("  The CORE skill defines PAI's identity, response format, session commands,");
  line("  compaction resilience, and operating principles. It auto-loads at session start.");
  line();

  const templatesDir = getTemplatesDir();
  const coreSrcDir = join(templatesDir, "skills", "CORE");

  if (!existsSync(coreSrcDir)) {
    console.log(c.warn("CORE skill template not found: " + coreSrcDir));
    console.log(c.dim("  Skipping CORE skill installation."));
    return false;
  }

  const skillsDir = join(homedir(), ".claude", "Skills");
  const coreDestDir = join(skillsDir, "CORE");
  const userSkillsDir = join(skillsDir, "user");

  // Check if CORE already exists
  const coreSkillDest = join(coreDestDir, "SKILL.md");
  if (existsSync(coreSkillDest)) {
    console.log(c.dim("  Found existing CORE skill at ~/.claude/Skills/CORE/"));
    line();

    const overwrite = await promptYesNo(
      rl,
      "Update ~/.claude/Skills/CORE/ with the latest CORE skill templates?",
      true,
    );

    if (!overwrite) {
      console.log(c.dim("  Keeping existing CORE skill unchanged."));
      // Still create user dir if missing
      if (!existsSync(userSkillsDir)) {
        mkdirSync(userSkillsDir, { recursive: true });
        console.log(c.ok("Created ~/.claude/Skills/user/ for custom skills"));
      }
      return false;
    }
  } else {
    const install = await promptYesNo(
      rl,
      "Install CORE skill to ~/.claude/Skills/CORE/?",
      true,
    );

    if (!install) {
      console.log(c.dim("  Skipping CORE skill installation."));
      return false;
    }
  }

  // Ensure directories exist
  if (!existsSync(coreDestDir)) {
    mkdirSync(coreDestDir, { recursive: true });
  }
  if (!existsSync(userSkillsDir)) {
    mkdirSync(userSkillsDir, { recursive: true });
  }

  // Copy all files from templates/skills/CORE/ to ~/.claude/Skills/CORE/
  const files = readdirSync(coreSrcDir).filter(f => f.endsWith(".md"));
  let copied = 0;
  for (const file of files) {
    const src = join(coreSrcDir, file);
    const dest = join(coreDestDir, file);
    copyFileSync(src, dest);
    copied++;
  }

  line();
  console.log(c.ok(`Installed ${copied} CORE skill files to ~/.claude/Skills/CORE/`));
  console.log(c.ok("Created ~/.claude/Skills/user/ for custom skills"));
  return true;
}

/**
 * Step 7: Hook scripts (pre-compact, session-stop, statusline)
 */
async function stepHooks(rl: ReturnType<typeof createRl>): Promise<boolean> {
  section("Step 7: Lifecycle Hooks");
  line();
  line("  PAI hooks fire on session stop and context compaction to save state,");
  line("  update notes, and display live statusline information.");
  line();

  const install = await promptYesNo(
    rl,
    "Install PAI lifecycle hooks (session stop, pre-compact, statusline)?",
    true,
  );

  if (!install) {
    console.log(c.dim("  Skipping hook installation."));
    return false;
  }

  const hooksDir = getHooksDir();
  const statuslineSrc = getStatuslineScript();
  const tabColorSrc = getTabColorScript();

  const claudeDir = join(homedir(), ".claude");
  const hooksTarget = join(claudeDir, "Hooks");

  if (!existsSync(hooksTarget)) {
    mkdirSync(hooksTarget, { recursive: true });
  }

  let anyInstalled = false;

  // Helper: copy a file if it differs from destination
  function installFile(src: string, dest: string, label: string): void {
    if (!existsSync(src)) {
      console.log(c.warn(`  Source not found: ${src}`));
      return;
    }

    const srcContent = readFileSync(src, "utf-8");

    if (existsSync(dest)) {
      const destContent = readFileSync(dest, "utf-8");
      if (srcContent === destContent) {
        console.log(c.dim(`  Unchanged: ${label}`));
        return;
      }
    }

    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
    console.log(c.ok(`Installed: ${label}`));
    anyInstalled = true;
  }

  line();
  installFile(
    join(hooksDir, "pre-compact.sh"),
    join(hooksTarget, "pai-pre-compact.sh"),
    "pai-pre-compact.sh",
  );
  installFile(
    join(hooksDir, "session-stop.sh"),
    join(hooksTarget, "pai-session-stop.sh"),
    "pai-session-stop.sh",
  );

  if (statuslineSrc) {
    installFile(
      statuslineSrc,
      join(claudeDir, "statusline-command.sh"),
      "statusline-command.sh",
    );
  } else {
    console.log(c.warn("  statusline-command.sh not found — skipping statusline."));
  }

  if (tabColorSrc) {
    installFile(
      tabColorSrc,
      join(claudeDir, "tab-color-command.sh"),
      "tab-color-command.sh",
    );
  } else {
    console.log(c.warn("  tab-color-command.sh not found — skipping tab color."));
  }

  return anyInstalled;
}

/**
 * Step 7b: Install compiled TypeScript hooks (.mjs) to ~/.claude/Hooks/
 *
 * Finds all .mjs files in the package's dist/hooks/ directory and copies them
 * to ~/.claude/Hooks/. Content is compared before copying — identical files are
 * skipped for idempotent re-runs. Each installed file gets chmod 755.
 */
async function stepTsHooks(rl: ReturnType<typeof createRl>): Promise<boolean> {
  section("Step 7b: TypeScript Hooks Installation");
  line();
  line("  PAI ships 14 compiled TypeScript hooks (.mjs) that fire on session events,");
  line("  tool use, and context compaction to capture context and update notes.");
  line();

  const install = await promptYesNo(
    rl,
    "Install PAI TypeScript hooks to ~/.claude/Hooks/?",
    true,
  );

  if (!install) {
    console.log(c.dim("  Skipping TypeScript hooks installation."));
    return false;
  }

  const distHooksDir = getDistHooksDir();

  if (!existsSync(distHooksDir)) {
    console.log(c.warn(`  dist/hooks/ directory not found at: ${distHooksDir}`));
    console.log(c.dim("  Build the package first: bun run build"));
    return false;
  }

  const claudeDir = join(homedir(), ".claude");
  const hooksTarget = join(claudeDir, "Hooks");

  if (!existsSync(hooksTarget)) {
    mkdirSync(hooksTarget, { recursive: true });
  }

  // Collect all .mjs files from dist/hooks/ (exclude .map files)
  let allFiles: string[];
  try {
    allFiles = readdirSync(distHooksDir).filter((f) => f.endsWith(".mjs"));
  } catch (e) {
    console.log(c.warn(`  Could not read dist/hooks/: ${e}`));
    return false;
  }

  if (allFiles.length === 0) {
    console.log(c.warn("  No .mjs files found in dist/hooks/. Build first: bun run build"));
    return false;
  }

  line();
  let copiedCount = 0;
  let skippedCount = 0;
  let cleanedCount = 0;

  for (const filename of allFiles) {
    const src = join(distHooksDir, filename);
    const dest = join(hooksTarget, filename);

    const srcContent = readFileSync(src, "utf-8");

    if (existsSync(dest)) {
      const destContent = readFileSync(dest, "utf-8");
      if (srcContent === destContent) {
        console.log(c.dim(`  Unchanged: ${filename}`));
        skippedCount++;
        // Still clean up stale .ts even if .mjs is unchanged
        const staleTsPath = join(hooksTarget, filename.replace(/\.mjs$/, ".ts"));
        if (existsSync(staleTsPath)) {
          unlinkSync(staleTsPath);
          console.log(c.ok(`Cleaned up stale: ${filename.replace(/\.mjs$/, ".ts")}`));
          cleanedCount++;
        }
        continue;
      }
    }

    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
    console.log(c.ok(`Installed: ${filename}`));
    copiedCount++;

    // Clean up stale .ts file if a .mjs replacement was just installed
    const staleTsPath = join(hooksTarget, filename.replace(/\.mjs$/, ".ts"));
    if (existsSync(staleTsPath)) {
      unlinkSync(staleTsPath);
      console.log(c.ok(`Cleaned up stale: ${filename.replace(/\.mjs$/, ".ts")}`));
      cleanedCount++;
    }
  }

  line();
  if (copiedCount > 0 || cleanedCount > 0) {
    const parts = [];
    if (copiedCount > 0) parts.push(`${copiedCount} hook(s) installed`);
    if (skippedCount > 0) parts.push(`${skippedCount} unchanged`);
    if (cleanedCount > 0) parts.push(`${cleanedCount} stale .ts file(s) cleaned up`);
    console.log(c.ok(parts.join(", ") + "."));
  } else {
    console.log(c.dim(`  All ${skippedCount} hook(s) already up-to-date.`));
  }

  return copiedCount > 0 || cleanedCount > 0;
}

/**
 * Step 8b: Prompt for the DA (Digital Assistant) name
 *
 * The name appears in tab titles, session notes, and hook output.
 * Stored in env.DA via settings merge.
 */
async function stepDaName(rl: ReturnType<typeof createRl>): Promise<string> {
  section("Step 8b: Assistant Name");
  line();
  line("  Choose a name for your AI assistant. This name appears in tab titles");
  line("  and session notes when hooks are active.");
  line();

  const answer = await prompt(
    rl,
    chalk.bold("  Assistant name [PAI]: "),
  );

  const daName = answer || "PAI";
  line();
  console.log(c.ok(`Assistant name set to: ${daName}`));
  return daName;
}

/**
 * Step 8: Patch ~/.claude/settings.json with PAI hooks, env vars, permissions, and flags
 *
 * Registers all 17 hook entries across 8 event types, adds env vars including DA name,
 * sets the statusline command, adds tool permissions (allow/deny), and sets flags.
 */
async function stepSettings(rl: ReturnType<typeof createRl>, daName: string): Promise<boolean> {
  section("Step 8: Settings Patch");
  line();
  line("  PAI will add env vars, all hook registrations, permissions, and flags");
  line("  to ~/.claude/settings.json. Existing values are never overwritten.");
  line();

  const patch = await promptYesNo(
    rl,
    "Patch ~/.claude/settings.json with PAI hooks, env vars, and settings?",
    true,
  );

  if (!patch) {
    console.log(c.dim("  Skipping settings patch."));
    return false;
  }

  const paiDir = join(homedir(), ".claude");

  const result = mergeSettings({
    env: {
      PAI_DIR: paiDir,
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
      DA: daName,
    },
    hooks: [
      // SessionStart — 4 hooks
      {
        hookType: "SessionStart",
        command: "${PAI_DIR}/Hooks/load-core-context.mjs",
      },
      {
        hookType: "SessionStart",
        command: "${PAI_DIR}/Hooks/load-project-context.mjs",
      },
      {
        hookType: "SessionStart",
        command: "${PAI_DIR}/Hooks/initialize-session.mjs",
      },
      {
        hookType: "SessionStart",
        command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type SessionStart",
      },
      // SessionStart(compact) — post-compaction state injection
      {
        hookType: "SessionStart",
        matcher: "compact",
        command: "${PAI_DIR}/Hooks/post-compact-inject.mjs",
      },
      // UserPromptSubmit — 3 hooks
      {
        hookType: "UserPromptSubmit",
        command: "${PAI_DIR}/Hooks/cleanup-session-files.mjs",
      },
      {
        hookType: "UserPromptSubmit",
        command: "${PAI_DIR}/Hooks/update-tab-titles.mjs",
      },
      {
        hookType: "UserPromptSubmit",
        command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type UserPromptSubmit",
      },
      // PreToolUse — 2 hooks (Bash-specific security validator + catch-all event capture)
      {
        hookType: "PreToolUse",
        matcher: "Bash",
        command: "${PAI_DIR}/Hooks/security-validator.mjs",
      },
      {
        hookType: "PreToolUse",
        matcher: "*",
        command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type PreToolUse",
      },
      // PostToolUse — 4 hooks (TodoWrite-specific sync + catch-all event capture, tool output, tab update)
      {
        hookType: "PostToolUse",
        matcher: "TodoWrite",
        command: "${PAI_DIR}/Hooks/sync-todo-to-md.mjs",
      },
      {
        hookType: "PostToolUse",
        matcher: "*",
        command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type PostToolUse",
      },
      {
        hookType: "PostToolUse",
        matcher: "*",
        command: "${PAI_DIR}/Hooks/capture-tool-output.mjs",
      },
      {
        hookType: "PostToolUse",
        matcher: "*",
        command: "${PAI_DIR}/Hooks/update-tab-on-action.mjs",
      },
      // Stop — 3 hooks (TypeScript stop hook + event capture + legacy shell hook)
      {
        hookType: "Stop",
        command: "${PAI_DIR}/Hooks/stop-hook.mjs",
      },
      {
        hookType: "Stop",
        command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type Stop",
      },
      {
        hookType: "Stop",
        command: "${PAI_DIR}/Hooks/pai-session-stop.sh",
      },
      // SubagentStop — 2 hooks
      {
        hookType: "SubagentStop",
        command: "${PAI_DIR}/Hooks/subagent-stop-hook.mjs",
      },
      {
        hookType: "SubagentStop",
        command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type SubagentStop",
      },
      // SessionEnd — 2 hooks
      {
        hookType: "SessionEnd",
        command: "${PAI_DIR}/Hooks/capture-session-summary.mjs",
      },
      {
        hookType: "SessionEnd",
        command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type SessionEnd",
      },
      // PreCompact — 3 hooks (TypeScript context compression + event capture + legacy shell hook)
      {
        hookType: "PreCompact",
        command: "${PAI_DIR}/Hooks/context-compression-hook.mjs",
      },
      {
        hookType: "PreCompact",
        command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type PreCompact",
      },
      {
        hookType: "PreCompact",
        matcher: "",
        command: "${PAI_DIR}/Hooks/pai-pre-compact.sh",
      },
    ],
    statusLine: {
      type: "command",
      command: "bash ${PAI_DIR}/statusline-command.sh",
    },
    permissions: {
      allow: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "NotebookEdit",
        "TodoWrite",
        "ExitPlanMode",
        "mcp__pai",
      ],
      deny: [
        "Bash(rm -rf /)",
        "Bash(rm -rf /*)",
        "Bash(rm -rf ~)",
        "Bash(rm -rf $HOME)",
        "Bash(sudo rm -rf /)",
        "Bash(sudo rm -rf /*)",
      ],
    },
    flags: {
      enableAllProjectMcpServers: true,
    },
  });

  line();
  for (const r of result.report) {
    console.log(r);
  }

  if (!result.changed) {
    console.log(c.dim("  Settings already up-to-date. No changes made."));
  }

  return result.changed;
}

/**
 * Step 9: Daemon install (launchd plist)
 */
async function stepDaemon(rl: ReturnType<typeof createRl>): Promise<boolean> {
  section("Step 9: Daemon Install");
  line();
  line("  The PAI daemon indexes your projects every 5 minutes in the background.");
  line();

  const plistPath = join(
    homedir(),
    "Library",
    "LaunchAgents",
    "com.pai.pai-daemon.plist",
  );

  const exists = existsSync(plistPath);

  if (exists) {
    console.log(c.dim("  PAI daemon plist already installed."));
    line();

    const reinstall = await promptYesNo(
      rl,
      "Reinstall the PAI daemon launchd plist?",
      false,
    );

    if (!reinstall) {
      console.log(c.dim("  Keeping existing daemon installation."));
      return false;
    }
  } else {
    const install = await promptYesNo(
      rl,
      "Install the PAI daemon to run automatically at login?",
      true,
    );

    if (!install) {
      console.log(c.dim("  Skipping daemon install. Run manually: pai daemon install"));
      return false;
    }
  }

  line();
  const result = spawnSync("pai", ["daemon", "install"], { stdio: "inherit" });

  if (result.status !== 0) {
    console.log(c.warn("  Daemon install failed. Run manually: pai daemon install"));
    return false;
  }

  console.log(c.ok("Daemon installed as com.pai.pai-daemon."));
  return true;
}

/**
 * Step 10: MCP registration in ~/.claude.json
 */
async function stepMcp(rl: ReturnType<typeof createRl>): Promise<boolean> {
  section("Step 10: MCP Registration");
  line();
  line("  Registering the PAI MCP server lets Claude Code call PAI tools directly.");
  line();

  // Check if already registered
  const claudeJsonPath = join(homedir(), ".claude.json");
  if (existsSync(claudeJsonPath)) {
    try {
      const raw = readFileSync(claudeJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const mcpServers = parsed["mcpServers"] as Record<string, unknown> | undefined;
      if (mcpServers && Object.prototype.hasOwnProperty.call(mcpServers, "pai")) {
        console.log(c.ok("PAI MCP server already registered in ~/.claude.json."));
        console.log(c.dim("  Skipping MCP registration."));
        return false;
      }
    } catch {
      // If we can't parse, continue with registration attempt
    }
  }

  const register = await promptYesNo(
    rl,
    "Register the PAI MCP server in ~/.claude.json?",
    true,
  );

  if (!register) {
    console.log(c.dim("  Skipping MCP registration. Run manually: pai mcp install"));
    return false;
  }

  line();
  const result = spawnSync("pai", ["mcp", "install"], { stdio: "inherit" });

  if (result.status !== 0) {
    console.log(c.warn("  MCP registration failed. Run manually: pai mcp install"));
    return false;
  }

  console.log(c.ok("PAI MCP server registered in ~/.claude.json."));
  return true;
}

/**
 * Step 11: Directory scanning configuration
 */
async function stepDirectories(rl: ReturnType<typeof createRl>): Promise<void> {
  section("Step 11: Directories to Index");
  line();
  line(
    "  PAI indexes files in your registered projects. You can register projects",
  );
  line(
    "  individually with `pai project add <path>`, or let the registry scanner",
  );
  line(
    "  discover them automatically with `pai registry scan`.",
  );
  line();

  const defaults = [
    join(homedir(), "Projects"),
    join(homedir(), "Documents"),
    join(homedir(), "dev"),
  ].filter(existsSync);

  if (defaults.length > 0) {
    line("  These directories exist on your system:");
    for (const d of defaults) {
      console.log(chalk.dim(`    ${d}`));
    }
    line();
  }

  const runScan = await promptYesNo(
    rl,
    "Run `pai registry scan` to auto-detect projects after setup?",
    false,
  );

  if (runScan) {
    line();
    console.log(c.dim("  Registry scan will run after setup completes."));
  } else {
    console.log(c.dim("  Add projects manually: pai project add <path>"));
    console.log(c.dim("  Or discover them later: pai registry scan"));
  }

  // Store whether scan was requested for use in step 5
  (stepDirectories as { _runScan?: boolean })._runScan = runScan;
}

/**
 * Step 12: Initial index
 */
async function stepInitialIndex(rl: ReturnType<typeof createRl>): Promise<void> {
  section("Step 12: Initial Index");
  line();
  line(
    "  Indexing scans your registered projects and builds the search index.",
  );
  line(
    "  The daemon runs indexing automatically every 5 minutes once started.",
  );
  line();

  const willScan = (stepDirectories as { _runScan?: boolean })._runScan;

  if (willScan) {
    const startDaemon = await promptYesNo(
      rl,
      "Start the PAI daemon now? (enables background indexing)",
      true,
    );

    if (startDaemon) {
      line();
      console.log(c.dim("  Starting daemon..."));

      try {
        const result = spawnSync("pai", ["daemon", "serve", "--background"], {
          stdio: "pipe",
          timeout: 10000,
        });

        if (result.status === 0) {
          console.log(c.ok("Daemon started in background."));
        } else {
          console.log(c.warn("Could not start daemon. Run manually: pai daemon serve"));
        }
      } catch {
        console.log(c.warn("Could not start daemon. Run manually: pai daemon serve"));
      }

      line();
      console.log(c.dim("  Running registry scan to detect projects..."));

      try {
        const result = spawnSync("pai", ["registry", "scan"], {
          stdio: "inherit",
          timeout: 30000,
        });

        if (result.status !== 0) {
          console.log(c.warn("Registry scan encountered issues. Run `pai registry scan` manually."));
        }
      } catch {
        console.log(c.warn("Could not run registry scan. Run manually: pai registry scan"));
      }
    } else {
      console.log(c.dim("  Start the daemon later: pai daemon serve"));
      console.log(c.dim("  Scan projects later: pai registry scan"));
    }
  } else {
    console.log(c.dim("  Register projects with: pai project add <path>"));
    console.log(c.dim("  Then index them with: pai memory index --all"));
    console.log(c.dim("  Or start the daemon: pai daemon serve"));
  }
}

/**
 * Step 13: Summary and next steps
 */
function stepSummary(
  configUpdates: Record<string, unknown>,
  claudeMdGenerated: boolean,
  paiSkillInstalled: boolean,
  aiSteeringRulesInstalled: boolean,
  coreSkillInstalled: boolean,
  hooksInstalled: boolean,
  tsHooksInstalled: boolean,
  settingsPatched: boolean,
  daName: string,
  daemonInstalled: boolean,
  mcpRegistered: boolean,
): void {
  section("Setup Complete");
  line();
  console.log(c.ok("PAI Knowledge OS is configured!"));
  line();

  // Show what was configured
  const backend = configUpdates.storageBackend as string;
  const model = configUpdates.embeddingModel as string;

  line(chalk.bold("  Configuration saved to: ") + chalk.dim(CONFIG_FILE));
  line();
  console.log(chalk.dim("  Storage backend:  ") + chalk.cyan(backend ?? "sqlite"));
  console.log(
    chalk.dim("  Embedding model:  ") +
    chalk.cyan(model && model !== "none" ? model : "(none — keyword search only)"),
  );
  console.log(
    chalk.dim("  CLAUDE.md:        ") +
    chalk.cyan(claudeMdGenerated ? "~/.claude/CLAUDE.md (generated)" : "(unchanged)"),
  );
  console.log(
    chalk.dim("  PAI skill:        ") +
    chalk.cyan(
      paiSkillInstalled
        ? "~/.claude/skills/PAI/SKILL.md (installed)"
        : "(unchanged)",
    ),
  );
  console.log(
    chalk.dim("  Steering rules:   ") +
    chalk.cyan(
      aiSteeringRulesInstalled
        ? "~/.claude/skills/PAI/AI-STEERING-RULES.md (installed)"
        : "(unchanged)",
    ),
  );
  console.log(
    chalk.dim("  CORE skill:       ") +
    chalk.cyan(
      coreSkillInstalled
        ? "~/.claude/Skills/CORE/ (installed)"
        : "(unchanged)",
    ),
  );
  console.log(
    chalk.dim("  Hooks (shell):    ") +
    chalk.cyan(
      hooksInstalled
        ? "pai-pre-compact.sh, pai-session-stop.sh (installed)"
        : "(unchanged)",
    ),
  );
  console.log(
    chalk.dim("  Hooks (TS):       ") +
    chalk.cyan(tsHooksInstalled ? "14 .mjs hooks installed to ~/.claude/Hooks/" : "(unchanged)"),
  );
  console.log(
    chalk.dim("  Assistant name:   ") + chalk.cyan(daName),
  );
  console.log(
    chalk.dim("  Settings:         ") +
    chalk.cyan(settingsPatched ? "env vars, hooks, permissions, flags (patched)" : "(unchanged)"),
  );
  console.log(
    chalk.dim("  Daemon:           ") +
    chalk.cyan(daemonInstalled ? "com.pai.pai-daemon (installed)" : "(unchanged)"),
  );
  console.log(
    chalk.dim("  MCP:              ") +
    chalk.cyan(mcpRegistered ? "registered in ~/.claude.json" : "(unchanged)"),
  );
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

// ---------------------------------------------------------------------------
// Main setup action
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  const rl = createRl();

  try {
    // Check if already configured
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

      const proceed = await promptYesNo(
        rl,
        "Continue and update configuration?",
        true,
      );

      if (!proceed) {
        rl.close();
        line(c.dim("  Setup cancelled."));
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

    // Step 6b: CORE Skill
    const coreSkillInstalled = await stepCoreSkill(rl);

    // Step 7: Hooks (shell scripts)
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
    console.log(c.ok("Configuration saved."));

    // Step 12: Initial index
    await stepInitialIndex(rl);

    // Step 13: Summary
    stepSummary(
      allUpdates,
      claudeMdGenerated,
      paiSkillInstalled,
      aiSteeringRulesInstalled,
      coreSkillInstalled,
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

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Interactive setup wizard — configure storage, embeddings, agent config, and indexing",
    )
    .action(async () => {
      await runSetup();
    });
}
