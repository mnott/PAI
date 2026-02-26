/**
 * pai setup — Interactive setup wizard for PAI Knowledge OS
 *
 * Guides new users through:
 *   1. Welcome and overview
 *   2. Storage backend selection (PostgreSQL/SQLite)
 *   3. Embedding model selection
 *   4. Agent configuration (CLAUDE.md generation)
 *   5. Directory scanning configuration
 *   6. Initial index (optional)
 *   7. Summary and next steps
 */

import type { Command } from "commander";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import chalk from "chalk";
import { CONFIG_DIR, CONFIG_FILE, loadConfig } from "../../daemon/config.js";

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
    join("/", "usr", "local", "lib", "node_modules", "@mnott", "pai", "docker"),
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
    join("/", "usr", "local", "lib", "node_modules", "@mnott", "pai", "templates"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "claude-md.template.md"))) return c;
  }
  return join(process.cwd(), "templates");
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
    const { default: pg } = await import("pg") as { default: typeof import("pg") };
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
 * Step 5: Directory scanning configuration
 */
async function stepDirectories(rl: ReturnType<typeof createRl>): Promise<void> {
  section("Step 5: Directories to Index");
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
 * Step 6: Initial index
 */
async function stepInitialIndex(rl: ReturnType<typeof createRl>): Promise<void> {
  section("Step 6: Initial Index");
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
 * Step 7: Summary and next steps
 */
function stepSummary(configUpdates: Record<string, unknown>, claudeMdGenerated: boolean): void {
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
    chalk.dim("  Agent config:     ") +
    chalk.cyan(claudeMdGenerated ? "~/.claude/CLAUDE.md (generated)" : "(unchanged)"),
  );
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
    section("Step 2: Storage Backend");
    const storageConfig = await stepStorage(rl);

    // Step 3: Embeddings
    const embeddingConfig = await stepEmbedding(rl);

    // Step 4: Agent configuration (CLAUDE.md)
    const claudeMdGenerated = await stepClaudeMd(rl);

    // Step 5: Directories (informational — no config written)
    await stepDirectories(rl);

    // Write config after gathering all choices
    const allUpdates = { ...storageConfig, ...embeddingConfig };
    mergeConfig(allUpdates);

    line();
    console.log(c.ok("Configuration saved."));

    // Step 6: Initial index
    await stepInitialIndex(rl);

    // Step 7: Summary
    stepSummary(allUpdates, claudeMdGenerated);

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
