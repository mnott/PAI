/**
 * Shared helpers for the PAI setup wizard: chalk colour shortcuts,
 * readline prompts, config read/write, and filesystem path finders.
 */

import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { readMainConfigRaw, writeMainConfigRaw } from "../../../daemon/config.js";
import { exitAfterFlush } from "../../lib/exit.js";
import { packageRoot } from "../../../module-paths.js";

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
    // Control can't return here — readline is still blocking on input, so
    // there is no natural exit to fall through to. exitAfterFlush() waits
    // for the lines above to actually reach the OS before terminating.
    void exitAfterFlush(0);
  });

  return rl;
}

export type Rl = ReturnType<typeof createRl>;

/** Unattended-mode switches (`pai setup --yes --storage …`), set once by the command. */
export const setupOptions: { yes: boolean; storage?: "sqlite" | "postgres" } = { yes: false };

/**
 * The one place every wizard question passes through. Under --yes it answers
 * `defaultValue` without touching stdin; a question with no default cannot be
 * answered unattended, so it fails naming the flag instead of returning "".
 */
export async function prompt(rl: Rl, question: string, defaultValue?: string): Promise<string> {
  if (setupOptions.yes) {
    if (defaultValue === undefined) {
      throw new Error(`"${question.trim()}" has no default; cannot answer it with --yes. Run without --yes, or skip the feature that asks it.`);
    }
    console.log(chalk.dim(`  ${question.trim()} -> ${defaultValue || "(default)"}`));
    return defaultValue;
  }
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
      "",
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
  const answer = await prompt(rl, `  ${question} ${chalk.dim(hint)}: `, "");

  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

// ---------------------------------------------------------------------------
// Config read/write helpers
// ---------------------------------------------------------------------------

/**
 * This file holds the Postgres connection string, the storage backend choice,
 * notification routing and any tracker API token — none of which the user can
 * reconstruct from memory. It previously returned {} on a parse failure and
 * then overwrote the file, so a damaged config was replaced by whatever the
 * current command happened to be setting.
 */
export function readConfigRaw(): Record<string, unknown> {
  return readMainConfigRaw();
}

export function writeConfigRaw(data: Record<string, unknown>): void {
  writeMainConfigRaw(data);
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
  return join(packageRoot(import.meta.url), "docker");
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
  return join(packageRoot(import.meta.url), "templates");
}

export function getHooksDir(): string {
  return join(packageRoot(import.meta.url), "src", "hooks");
}

export function getDistHooksDir(): string {
  return join(getDistDir(), "hooks");
}

export function getDistDir(): string {
  return join(packageRoot(import.meta.url), "dist");
}

export function getStatuslineScript(): string | null {
  const p = join(packageRoot(import.meta.url), "statusline-command.sh");
  return existsSync(p) ? p : null;
}

export function getTabColorScript(): string | null {
  const p = join(packageRoot(import.meta.url), "tab-color-command.sh");
  return existsSync(p) ? p : null;
}
