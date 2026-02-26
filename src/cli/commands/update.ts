/**
 * pai update — Update PAI from the GitHub repository without losing customizations.
 *
 * Steps:
 *   1. Verify we're in a git repo with a remote (origin)
 *   2. Stash any local changes
 *   3. Pull latest from origin/main
 *   4. Pop the stash if there was one (handle conflicts gracefully)
 *   5. Rebuild: bun install && bun run build
 *   6. Restart the daemon (SIGHUP or pai daemon restart)
 *   7. Check if the CLAUDE.md template has changed and offer to refresh
 *   8. Run pai registry scan to update markers
 *   9. Report what changed
 */

import type { Command } from "commander";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import chalk from "chalk";
import { ok, warn, err, dim, bold } from "../utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function line(text = "") {
  console.log(text);
}

function step(msg: string) {
  console.log(chalk.bold.cyan(`\n  ${msg}`));
}

function info(msg: string) {
  console.log(dim(`  ${msg}`));
}

function success(msg: string) {
  console.log(ok(`  ${msg}`));
}

function warning(msg: string) {
  console.log(warn(`  ${msg}`));
}

function error(msg: string) {
  console.log(err(`  ${msg}`));
}

/**
 * Run a shell command, streaming output to stdout.
 * Returns true on success, false on failure.
 */
function run(cmd: string, cwd?: string): boolean {
  try {
    execSync(cmd, {
      stdio: "inherit",
      cwd: cwd ?? process.cwd(),
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a shell command silently, returning stdout or null on failure.
 */
function capture(cmd: string, cwd?: string): string | null {
  try {
    return execSync(cmd, {
      stdio: "pipe",
      cwd: cwd ?? process.cwd(),
      env: process.env,
    }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Get the PAI source directory: walk up from dist/cli/ or src/cli/ to the
 * package root where package.json lives.
 */
function getPaiSrcDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // dist/cli/index.mjs → dist/ → package root
  return join(__dirname, "../..");
}

/**
 * Locate the templates directory relative to the installed package.
 */
function getTemplatesDir(): string {
  const candidates = [
    join(getPaiSrcDir(), "templates"),
    join(homedir(), "dev", "ai", "PAI", "templates"),
    join("/", "usr", "local", "lib", "node_modules", "@mnott", "pai", "templates"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "claude-md.template.md"))) return c;
  }
  return join(getPaiSrcDir(), "templates");
}

// ---------------------------------------------------------------------------
// Update steps
// ---------------------------------------------------------------------------

/**
 * Step 1: Verify git repo + remote.
 * Returns the PAI source directory (repo root) or null if not a git repo.
 */
function stepVerifyRepo(): string | null {
  step("Checking repository...");

  const paiDir = getPaiSrcDir();

  // Check git repo
  const gitDir = capture("git rev-parse --show-toplevel", paiDir);
  if (!gitDir) {
    error("Not a git repository. Cannot update automatically.");
    info("Install PAI via npm to get automatic updates: npm install -g @mnott/pai");
    return null;
  }

  // Check remote
  const remote = capture("git remote get-url origin", gitDir);
  if (!remote) {
    error("No 'origin' remote configured. Cannot pull updates.");
    info("Add a remote: git remote add origin https://github.com/mnott/PAI.git");
    return null;
  }

  info(`Repository: ${gitDir}`);
  info(`Remote:     ${remote}`);
  return gitDir;
}

/**
 * Step 2: Stash local changes.
 * Returns true if something was stashed (so we need to pop later).
 */
function stepStash(repoDir: string): boolean {
  step("Stashing local changes...");

  // Check if there are any changes to stash
  const status = capture("git status --porcelain", repoDir);
  if (!status) {
    info("Working tree is clean — nothing to stash.");
    return false;
  }

  info("Uncommitted changes found:");
  const statusLines = status.split("\n").slice(0, 5);
  for (const l of statusLines) {
    info(`  ${l}`);
  }
  if (status.split("\n").length > 5) {
    info(`  ... and ${status.split("\n").length - 5} more`);
  }

  const result = capture("git stash push -m 'pai update: auto-stash'", repoDir);
  if (result === null) {
    warning("Could not stash changes. Proceeding anyway — merge conflicts may occur.");
    return false;
  }

  if (result.includes("No local changes to save")) {
    info("Nothing to stash.");
    return false;
  }

  success("Changes stashed.");
  return true;
}

/**
 * Step 3: Pull latest from origin/main.
 * Returns the git log summary of new commits or null if already up to date.
 */
function stepPull(repoDir: string): string | null {
  step("Pulling latest from origin/main...");

  // Get current HEAD before pull
  const headBefore = capture("git rev-parse HEAD", repoDir);

  const pulled = run("git pull origin main", repoDir);
  if (!pulled) {
    warning("git pull failed. There may be merge conflicts with your stash.");
    return null;
  }

  // Get HEAD after pull
  const headAfter = capture("git rev-parse HEAD", repoDir);

  if (headBefore === headAfter) {
    success("Already up to date — no new commits.");
    return null;
  }

  // Show what changed
  const log = capture(
    `git log --oneline ${headBefore ?? ""}..${headAfter ?? "HEAD"}`,
    repoDir,
  );
  if (log) {
    success("New commits pulled:");
    for (const l of log.split("\n")) {
      info(`  ${l}`);
    }
  }

  return log;
}

/**
 * Step 4: Pop stash (if we stashed anything).
 */
function stepPopStash(repoDir: string): void {
  step("Restoring local changes (git stash pop)...");

  const result = spawnSync("git", ["stash", "pop"], {
    cwd: repoDir,
    stdio: "pipe",
    encoding: "utf8",
  });

  if (result.status === 0) {
    success("Local changes restored.");
  } else {
    const stderr = result.stderr ?? "";
    if (stderr.includes("CONFLICT")) {
      warning("Stash pop caused merge conflicts. Resolve them manually:");
      info("  git status");
      info("  # Edit conflicting files");
      info("  git add <files>");
      info("  git stash drop");
    } else {
      warning(`Stash pop encountered an issue: ${stderr.trim() || "unknown error"}`);
      info("  Run: git stash pop");
      info("  Or:  git stash list  (to see stashed changes)");
    }
  }
}

/**
 * Step 5: Rebuild.
 */
function stepBuild(repoDir: string): boolean {
  step("Rebuilding PAI (bun install && bun run build)...");

  info("Installing dependencies...");
  const installed = run("bun install", repoDir);
  if (!installed) {
    error("bun install failed.");
    return false;
  }

  info("Building...");
  const built = run("bun run build", repoDir);
  if (!built) {
    error("bun run build failed.");
    return false;
  }

  success("Build complete.");
  return true;
}

/**
 * Step 6: Restart the daemon.
 * Tries SIGHUP first (graceful reload); falls back to pai daemon restart.
 */
function stepRestartDaemon(repoDir: string): void {
  step("Restarting PAI daemon...");

  // Try to find the daemon PID from the socket/pid file
  const pidFile = "/tmp/pai-daemon.pid";
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (!isNaN(pid) && pid > 0) {
        const killed = capture(`kill -HUP ${pid}`);
        if (killed !== null) {
          success(`Sent SIGHUP to daemon (PID ${pid}).`);
          return;
        }
      }
    } catch {
      // fall through to pai daemon restart
    }
  }

  // Fall back to pai daemon restart subcommand
  const result = spawnSync("pai", ["daemon", "restart"], {
    cwd: repoDir,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 10_000,
  });

  if (result.status === 0) {
    success("Daemon restarted.");
  } else {
    warning("Could not restart daemon automatically.");
    info("  Restart manually: pai daemon restart");
    info("  Or:               pai daemon serve");
  }
}

/**
 * Step 7: Check if CLAUDE.md template changed and offer to refresh.
 */
function stepRefreshClaudeMd(repoDir: string, newCommitsLog: string | null): void {
  step("Checking CLAUDE.md template...");

  const templatesDir = getTemplatesDir();
  const templatePath = join(templatesDir, "claude-md.template.md");
  const claudeMd = join(homedir(), ".claude", "CLAUDE.md");

  if (!existsSync(templatePath)) {
    info("Template not found — skipping CLAUDE.md check.");
    return;
  }

  if (!existsSync(claudeMd)) {
    info("No ~/.claude/CLAUDE.md found — skipping.");
    return;
  }

  const userContent = readFileSync(claudeMd, "utf8");
  const isPaiGenerated = userContent.includes("Generated by PAI Setup");

  if (!isPaiGenerated) {
    warning("~/.claude/CLAUDE.md appears to be custom (not PAI-generated).");
    info("  Skipping auto-update. Review the new template manually:");
    info(`    ${templatePath}`);
    return;
  }

  // Check if the template was actually modified in the new commits
  let templateChanged = false;
  if (newCommitsLog) {
    // Check git diff on the template file for newly pulled commits
    const diff = capture(
      "git diff HEAD~1..HEAD -- templates/claude-md.template.md",
      repoDir,
    );
    templateChanged = !!(diff && diff.trim().length > 0);
  }

  if (!templateChanged) {
    info("CLAUDE.md template unchanged in this update.");
    return;
  }

  info("CLAUDE.md template was updated in this release.");
  info("Refreshing ~/.claude/CLAUDE.md (PAI-generated — safe to overwrite)...");

  let template = readFileSync(templatePath, "utf8");
  // Substitute ${HOME} with actual home directory
  template = template.replace(/\$\{HOME\}/g, homedir());
  writeFileSync(claudeMd, template, "utf8");

  success("~/.claude/CLAUDE.md refreshed from updated template.");
}

/**
 * Step 8: Run pai registry scan.
 */
function stepRegistryScan(repoDir: string): void {
  step("Running pai registry scan...");

  const result = spawnSync("pai", ["registry", "scan"], {
    cwd: repoDir,
    stdio: "inherit",
    timeout: 60_000,
  });

  if (result.status === 0) {
    success("Registry scan complete.");
  } else {
    warning("Registry scan encountered issues.");
    info("  Run manually: pai registry scan");
  }
}

// ---------------------------------------------------------------------------
// Main update action
// ---------------------------------------------------------------------------

async function runUpdate(): Promise<void> {
  line();
  console.log(chalk.bold.cyan("  ╔═══════════════════════════════════╗"));
  console.log(chalk.bold.cyan("  ║     PAI Knowledge OS — Update     ║"));
  console.log(chalk.bold.cyan("  ╚═══════════════════════════════════╝"));
  line();

  // Step 1: Verify repo
  const repoDir = stepVerifyRepo();
  if (!repoDir) {
    line();
    process.exit(1);
  }

  // Step 2: Stash local changes
  const didStash = stepStash(repoDir);

  // Step 3: Pull
  const newCommitsLog = stepPull(repoDir);

  // Step 4: Pop stash (only if we stashed something)
  if (didStash) {
    stepPopStash(repoDir);
  }

  // If no new commits and no stash needed, we can short-circuit after
  // confirming things are current. But we still offer rebuild in case the
  // user's build is stale.

  // Step 5: Build
  const buildOk = stepBuild(repoDir);
  if (!buildOk) {
    line();
    error("Update failed at build step. Check errors above.");
    line();
    process.exit(1);
  }

  // Step 6: Restart daemon
  stepRestartDaemon(repoDir);

  // Step 7: CLAUDE.md refresh
  stepRefreshClaudeMd(repoDir, newCommitsLog);

  // Step 8: Registry scan
  stepRegistryScan(repoDir);

  // Summary
  line();
  console.log(chalk.bold.cyan("  ─────────────────────────────────────"));
  if (newCommitsLog) {
    success("PAI updated successfully!");
  } else {
    success("PAI is up to date and rebuilt successfully!");
  }
  console.log(dim("  Version: ") + chalk.cyan(capture("pai --version", repoDir) ?? "unknown"));
  line();
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "Update PAI from GitHub (git pull + rebuild + daemon restart). Preserves local customizations.",
    )
    .action(async () => {
      await runUpdate();
    });
}
