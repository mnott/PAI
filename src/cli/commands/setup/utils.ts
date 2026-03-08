/**
 * Shared helpers for the PAI setup wizard: chalk colour shortcuts,
 * readline prompts, config read/write, and filesystem path finders.
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { CONFIG_DIR, CONFIG_FILE } from "../../../daemon/config.js";

// ---------------------------------------------------------------------------
// Chalk colour helpers
// ---------------------------------------------------------------------------

export const c = {
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

export function line(text = ""): void {
  console.log(text);
}

export function section(title: string): void {
  line();
  console.log(chalk.bold.cyan("  " + title));
  console.log(chalk.dim("  " + "─".repeat(title.length)));
}

// ---------------------------------------------------------------------------
// Readline prompt helpers
// ---------------------------------------------------------------------------

export function createRl() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("SIGINT", () => {
    line();
    line(c.dim("  Setup cancelled. Run `pai setup` again to restart."));
    line();
    process.exit(0);
  });

  return rl;
}

export type Rl = ReturnType<typeof createRl>;

export async function prompt(rl: Rl, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/** Prompt for a numbered menu selection. Returns 0-based index. */
export async function promptMenu(
  rl: Rl,
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

/** Prompt for a yes/no answer. Returns true for yes. */
export async function promptYesNo(
  rl: Rl,
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

export function readConfigRaw(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeConfigRaw(data: Record<string, unknown>): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function mergeConfig(updates: Record<string, unknown>): void {
  const current = readConfigRaw();
  const merged = { ...current, ...updates };
  if (updates.postgres && typeof current.postgres === "object" && current.postgres !== null) {
    merged.postgres = { ...(current.postgres as object), ...(updates.postgres as object) };
  }
  writeConfigRaw(merged);
}

// ---------------------------------------------------------------------------
// Docker and connection helpers
// ---------------------------------------------------------------------------

export function hasDocker(): boolean {
  try {
    const result = spawnSync("docker", ["--version"], { stdio: "pipe" });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function getDockerDir(): string {
  const candidates = [
    join(process.cwd(), "docker"),
    join(homedir(), "dev", "ai", "PAI", "docker"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "docker"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "docker-compose.yml"))) return candidate;
  }
  return join(process.cwd(), "docker");
}

export async function testPostgresConnection(connectionString: string): Promise<boolean> {
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
// Filesystem path finders
// ---------------------------------------------------------------------------

export function getTemplatesDir(): string {
  const candidates = [
    join(process.cwd(), "templates"),
    join(homedir(), "dev", "ai", "PAI", "templates"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "templates"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "claude-md.template.md"))) return candidate;
  }
  return join(process.cwd(), "templates");
}

export function getHooksDir(): string {
  const candidates = [
    join(process.cwd(), "src", "hooks"),
    join(homedir(), "dev", "ai", "PAI", "src", "hooks"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "src", "hooks"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "session-stop.sh"))) return candidate;
  }
  return join(process.cwd(), "src", "hooks");
}

export function getDistHooksDir(): string {
  const moduleDir = new URL(".", import.meta.url).pathname;
  const fromModule = join(moduleDir, "..", "..", "hooks");

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

export function getDistDir(): string {
  const moduleDir = new URL(".", import.meta.url).pathname;
  const fromModule = join(moduleDir, "..", "..", "..");

  const candidates = [
    fromModule,
    join(process.cwd(), "dist"),
    join(homedir(), "dev", "ai", "PAI", "dist"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "dist"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "skills"))) return candidate;
  }
  return fromModule;
}

export function getStatuslineScript(): string | null {
  const candidates = [
    join(process.cwd(), "statusline-command.sh"),
    join(homedir(), "dev", "ai", "PAI", "statusline-command.sh"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "statusline-command.sh"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function getTabColorScript(): string | null {
  const candidates = [
    join(process.cwd(), "tab-color-command.sh"),
    join(homedir(), "dev", "ai", "PAI", "tab-color-command.sh"),
    join("/", "usr", "local", "lib", "node_modules", "@tekmidian", "pai", "tab-color-command.sh"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
