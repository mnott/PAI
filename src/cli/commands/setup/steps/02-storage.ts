/** Step 2: Storage backend selection (SQLite or PostgreSQL) and Docker helper. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { c, line, section, type Rl, prompt, promptMenu, promptYesNo, readConfigRaw, getDockerDir, hasDocker, testPostgresConnection } from "../utils.js";

async function startDocker(rl: Rl): Promise<boolean> {
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

export async function stepStorage(rl: Rl): Promise<Record<string, unknown>> {
  section("Step 2: Storage Backend");

  const existing = readConfigRaw();
  if (existing.storageBackend) {
    const backend = String(existing.storageBackend);
    if (backend === "postgres") {
      try {
        const result = spawnSync("docker", ["ps", "--filter", "name=pai-pgvector", "--format", "{{.Status}}"], { stdio: "pipe" });
        const status = result.stdout?.toString().trim();
        if (status && status.includes("Up")) {
          console.log(c.ok(`Storage backend: PostgreSQL (container running). Skipping.`));
          return existing;
        }
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
      description: "Best for large collections, semantic search, and production use. Requires Docker or a Postgres server.",
    },
    {
      label: "SQLite",
      description: "Simple, no dependencies, zero configuration. Good for trying PAI out. Keyword search only.",
    },
  ]);

  if (choice === 1) {
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

    const useDocker = await promptYesNo(rl, "Start the PAI PostgreSQL container with Docker? (recommended)", true);

    if (useDocker) {
      line();
      await startDocker(rl);
      line();

      console.log(c.dim("  Waiting 3 seconds for container to be ready..."));
      await new Promise((r) => setTimeout(r, 3000));

      const connStr = "postgresql://pai:pai@localhost:5432/pai";
      console.log(c.dim(`  Testing connection to ${connStr}...`));

      const ok2 = await testPostgresConnection(connStr);
      if (ok2) {
        console.log(c.ok("Connection successful!"));
      } else {
        console.log(c.warn("Connection test failed. The container may still be starting."));
        console.log(c.dim("  Using default connection string — you can verify with `pai daemon status`."));
      }
      return { storageBackend: "postgres", postgres: { connectionString: connStr } };
    }
  } else {
    console.log(c.dim("  Docker not found. Using manual connection string entry."));
  }

  // Manual entry
  line();
  line("  Enter your PostgreSQL connection details:");
  line();

  const useConnStr = await promptYesNo(rl, "Use a full connection string? (e.g. postgresql://user:pass@host:5432/dbname)", true);

  if (useConnStr) {
    const connStr = await prompt(rl, chalk.bold("  Connection string: "));
    if (connStr) {
      console.log(c.dim("  Testing connection..."));
      const connected = await testPostgresConnection(connStr);
      if (connected) {
        console.log(c.ok("Connection successful!"));
      } else {
        console.log(c.warn("Connection test failed — check credentials and try again later."));
      }
      return { storageBackend: "postgres", postgres: { connectionString: connStr } };
    }
  }

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

  return { storageBackend: "postgres", postgres: { connectionString: connStr } };
}
