/**
 * pai daemon <sub-command>
 *
 * serve      — Start the PAI daemon in the foreground
 * status     — Query daemon status via IPC
 * restart    — Send SIGTERM to running daemon (launchd will restart it)
 * install    — Write launchd plist + update ~/.claude.json to use the shim
 * uninstall  — Remove launchd plist + revert ~/.claude.json to direct MCP
 * logs       — Tail the daemon log file
 */

import type { Command } from "commander";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import { ok, warn, err, dim, bold } from "../utils.js";
import { loadConfig } from "../../daemon/config.js";
import { PaiClient } from "../../daemon/ipc-client.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HOME = homedir();
const CLAUDE_JSON_PATH = join(HOME, ".claude.json");
const PLIST_LABEL = "com.pai.pai-daemon";
const LAUNCH_AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${PLIST_LABEL}.plist`);
const DAEMON_LOG = "/tmp/pai-daemon.log";

/**
 * Resolve the absolute path to the built daemon entry point.
 * tsdown bundles into dist/daemon/index.mjs (or similar).
 * From dist/cli/index.mjs → dist/ → dist/daemon/index.mjs
 */
function getDaemonBinPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, "../daemon/index.mjs");
}

/**
 * Resolve the absolute path to the built MCP shim entry point.
 * dist/cli/index.mjs → dist/ → dist/daemon-mcp/index.mjs
 */
function getShimBinPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, "../daemon-mcp/index.mjs");
}

// ---------------------------------------------------------------------------
// claude.json helpers
// ---------------------------------------------------------------------------

function readClaudeJson(): Record<string, unknown> {
  if (!existsSync(CLAUDE_JSON_PATH)) return {};
  try {
    const raw = readFileSync(CLAUDE_JSON_PATH, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeClaudeJson(data: Record<string, unknown>): void {
  writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// launchd plist generation
// ---------------------------------------------------------------------------

function generatePlist(daemonBin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${daemonBin}</string>
        <string>serve</string>
    </array>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>3</integer>

    <key>StandardOutPath</key>
    <string>${DAEMON_LOG}</string>

    <key>StandardErrorPath</key>
    <string>${DAEMON_LOG}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const client = new PaiClient(config.socketPath);

  try {
    const status = await client.status();
    const s = status as Record<string, unknown>;

    console.log();
    console.log(bold("  PAI Daemon Status"));
    console.log();
    console.log(ok(`  Daemon running`));
    console.log(dim(`    Uptime:      ${s["uptime"]}s`));
    console.log(dim(`    Socket:      ${s["socketPath"]}`));
    console.log(
      dim(
        `    Index:       ${s["indexInProgress"] ? "in progress" : "idle"}  (interval: ${s["indexIntervalSecs"]}s)`
      )
    );
    if (s["lastIndexTime"]) {
      console.log(dim(`    Last index:  ${s["lastIndexTime"]}`));
    }
    if (s["db"]) {
      const db = s["db"] as Record<string, unknown>;
      console.log(
        dim(
          `    DB:          ${db["projects"]} projects, ${db["files"]} files, ${db["chunks"]} chunks`
        )
      );
    }
    console.log();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log();
    console.log(warn("  PAI Daemon Status"));
    console.log();
    console.log(warn(`  Daemon not running: ${msg}`));
    console.log(dim("    Start with: pai daemon serve"));
    console.log(dim("    Or install as service: pai daemon install"));
    console.log();
    process.exit(1);
  }
}

function cmdRestart(): void {
  // Find and signal the running daemon
  try {
    const result = spawnSync("pgrep", ["-f", "pai-daemon.*serve"], {
      encoding: "utf8",
    });

    if (result.status !== 0 || !result.stdout.trim()) {
      console.log(warn("No running pai-daemon process found."));

      // If launchd is managing it, kick it via launchctl
      const unloadResult = spawnSync(
        "launchctl",
        ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`],
        { encoding: "utf8" }
      );
      if (unloadResult.status === 0) {
        console.log(ok("Sent kickstart to launchd."));
      } else {
        console.log(dim("Not managed by launchd either. Run: pai daemon serve"));
      }
      return;
    }

    const pids = result.stdout
      .trim()
      .split("\n")
      .map((p) => p.trim());
    for (const pid of pids) {
      try {
        process.kill(parseInt(pid, 10), "SIGTERM");
        console.log(ok(`Sent SIGTERM to pid ${pid}.`));
      } catch {
        console.log(warn(`Could not signal pid ${pid}.`));
      }
    }
    console.log(dim("launchd will restart the daemon automatically."));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`restart error: ${msg}`));
    process.exit(1);
  }
}

function cmdInstall(): void {
  const daemonBin = getDaemonBinPath();
  const shimBin = getShimBinPath();

  console.log();
  console.log(bold("  PAI Daemon Install"));
  console.log();

  // 1. Write launchd plist
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }

  const plistContent = generatePlist(daemonBin);
  try {
    writeFileSync(PLIST_PATH, plistContent, "utf8");
    console.log(ok(`  Wrote launchd plist: ${PLIST_PATH}`));
  } catch (e) {
    console.error(err(`  Failed to write plist: ${e}`));
    process.exit(1);
  }

  // 2. Load the plist (unload first in case it was already there)
  try {
    spawnSync("launchctl", ["unload", PLIST_PATH], { encoding: "utf8" });
    const loadResult = spawnSync("launchctl", ["load", PLIST_PATH], {
      encoding: "utf8",
    });
    if (loadResult.status === 0) {
      console.log(ok("  Loaded plist with launchctl."));
    } else {
      console.log(warn(`  launchctl load: ${loadResult.stderr?.trim() ?? "unknown error"}`));
    }
  } catch {
    console.log(warn("  Could not run launchctl. Load manually:"));
    console.log(dim(`    launchctl load ${PLIST_PATH}`));
  }

  // 3. Update ~/.claude.json to use the shim
  const config = readClaudeJson();

  if (typeof config.mcpServers !== "object" || config.mcpServers === null) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;

  // Check if already pointing to the shim
  const existing = servers["pai"] as Record<string, unknown> | undefined;
  const existingArgs = existing?.args as string[] | undefined;
  const alreadyShim = existingArgs?.includes(shimBin);

  if (alreadyShim) {
    console.log(ok("  ~/.claude.json already points to the shim."));
  } else {
    // Back up the existing entry if any
    if (existing) {
      servers["pai-legacy"] = existing;
      console.log(dim("  Backed up existing 'pai' entry as 'pai-legacy'."));
    }

    servers["pai"] = {
      command: "node",
      args: [shimBin],
    };

    try {
      writeClaudeJson(config);
      console.log(ok("  Updated ~/.claude.json to use daemon shim."));
    } catch (e) {
      console.error(err(`  Failed to write ~/.claude.json: ${e}`));
      process.exit(1);
    }
  }

  // 4. Verify binaries exist
  console.log();
  if (!existsSync(daemonBin)) {
    console.log(warn(`  Daemon binary not found: ${daemonBin}`));
    console.log(dim("  Run: bun run build"));
  } else {
    console.log(ok(`  Daemon binary: ${daemonBin}`));
  }

  if (!existsSync(shimBin)) {
    console.log(warn(`  Shim binary not found: ${shimBin}`));
    console.log(dim("  Run: bun run build"));
  } else {
    console.log(ok(`  Shim binary: ${shimBin}`));
  }

  console.log();
  console.log(dim("  Restart Claude Code to activate the daemon-backed PAI tools."));
  console.log();
}

function cmdUninstall(): void {
  console.log();
  console.log(bold("  PAI Daemon Uninstall"));
  console.log();

  // 1. Unload and remove plist
  if (existsSync(PLIST_PATH)) {
    try {
      spawnSync("launchctl", ["unload", PLIST_PATH], { encoding: "utf8" });
      console.log(ok("  Unloaded launchd plist."));
    } catch {
      console.log(warn("  Could not unload plist via launchctl."));
    }
    try {
      unlinkSync(PLIST_PATH);
      console.log(ok(`  Removed plist: ${PLIST_PATH}`));
    } catch (e) {
      console.log(warn(`  Could not remove plist: ${e}`));
    }
  } else {
    console.log(dim("  No launchd plist found."));
  }

  // 2. Revert ~/.claude.json to legacy direct MCP
  const config = readClaudeJson();
  const servers =
    typeof config.mcpServers === "object" && config.mcpServers !== null
      ? (config.mcpServers as Record<string, unknown>)
      : {};

  const legacy = servers["pai-legacy"];
  if (legacy) {
    servers["pai"] = legacy;
    delete servers["pai-legacy"];
    try {
      writeClaudeJson(config);
      console.log(ok("  Reverted ~/.claude.json to legacy direct MCP."));
    } catch (e) {
      console.log(warn(`  Could not update ~/.claude.json: ${e}`));
    }
  } else {
    console.log(dim("  No legacy PAI entry found in ~/.claude.json."));
  }

  console.log();
  console.log(dim("  Restart Claude Code to deactivate daemon-backed tools."));
  console.log();
}

async function cmdMigrate(connectionString?: string): Promise<void> {
  console.log();
  console.log(bold("  PAI Daemon Migrate"));
  console.log();
  console.log(dim("  Running SQLite → PostgreSQL migration..."));
  console.log();

  // Resolve the migration script path relative to this built file
  const { fileURLToPath } = await import("node:url");
  const { dirname: pathDirname, join: pathJoin } = await import("node:path");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = pathDirname(__filename);

  // The migration script is at docker/migrate-sqlite.ts in the source tree
  // When built, we look for it relative to the package root
  const migrationScript = pathJoin(__dirname, "../..", "docker", "migrate-sqlite.ts");
  const { spawnSync: spawn } = await import("node:child_process");

  // Use npx tsx to run the TypeScript migration script (bun doesn't support better-sqlite3)
  const spawnArgs = ["tsx", migrationScript];
  if (connectionString) {
    spawnArgs.push("--connection-string", connectionString);
  }

  const result = spawn("npx", spawnArgs, { stdio: "inherit", encoding: "utf8" });

  if (result.status !== 0) {
    console.error(err("  Migration failed. Check output above."));
    process.exit(result.status ?? 1);
  }
}

function cmdLogs(opts: { lines?: string; follow?: boolean }): void {
  const lines = opts.lines ?? "50";

  if (!existsSync(DAEMON_LOG)) {
    console.log(warn(`No daemon log found at ${DAEMON_LOG}.`));
    console.log(dim("The daemon may not have run yet."));
    return;
  }

  if (opts.follow) {
    // exec stays running
    try {
      execSync(`tail -f -n ${lines} "${DAEMON_LOG}"`, { stdio: "inherit" });
    } catch {
      // User pressed Ctrl+C — that's fine
    }
  } else {
    try {
      execSync(`tail -n ${lines} "${DAEMON_LOG}"`, { stdio: "inherit" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(err(`Could not read log: ${msg}`));
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerDaemonCommands(daemonCmd: Command): void {
  daemonCmd
    .command("serve")
    .description("Start the PAI daemon in the foreground")
    .action(async () => {
      const { serve } = await import("../../daemon/daemon.js");
      const { loadConfig: lc, ensureConfigDir } = await import(
        "../../daemon/config.js"
      );
      ensureConfigDir();
      const config = lc();
      await serve(config);
    });

  daemonCmd
    .command("migrate")
    .description("Migrate federation data from SQLite to PostgreSQL")
    .option(
      "--connection-string <url>",
      "Postgres connection string (default: from config or postgresql://pai:pai@localhost:5432/pai)"
    )
    .action(async (opts: { connectionString?: string }) => {
      await cmdMigrate(opts.connectionString);
    });

  daemonCmd
    .command("status")
    .description("Query the running daemon status")
    .action(async () => {
      await cmdStatus();
    });

  daemonCmd
    .command("restart")
    .description("Send SIGTERM to the running daemon (launchd will restart it)")
    .action(() => {
      cmdRestart();
    });

  daemonCmd
    .command("install")
    .description(
      "Install daemon as a launchd service and update ~/.claude.json to use the shim"
    )
    .action(() => {
      cmdInstall();
    });

  daemonCmd
    .command("uninstall")
    .description("Remove the launchd service and revert to direct MCP")
    .action(() => {
      cmdUninstall();
    });

  daemonCmd
    .command("logs")
    .description(`Tail the daemon log (${DAEMON_LOG})`)
    .option("-n, --lines <n>", "Number of lines to show", "50")
    .option("-f, --follow", "Follow log output (like tail -f)")
    .action((opts: { lines?: string; follow?: boolean }) => {
      cmdLogs(opts);
    });
}
