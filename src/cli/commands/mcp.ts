/**
 * pai mcp <sub-command>
 *
 * install  — Register the PAI MCP server in ~/.claude.json
 * status   — Show whether the PAI MCP server is registered and the binary exists
 */

import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { ok, warn, err, dim, bold } from "../utils.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CLAUDE_JSON_PATH = join(homedir(), ".claude.json");

/**
 * Resolve the absolute path to the built MCP entry point.
 *
 * tsdown bundles all CLI commands into a single dist/cli/index.mjs file, so
 * import.meta.url always resolves to dist/cli/index.mjs at runtime.
 * From dist/cli/ we go up one level to dist/ and then into mcp/index.mjs.
 */
function getMcpBinPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // dist/cli/index.mjs  →  dist/  →  dist/mcp/index.mjs
  return join(__dirname, "../mcp/index.mjs");
}

// ---------------------------------------------------------------------------
// Read / write ~/.claude.json safely
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
// install
// ---------------------------------------------------------------------------

function cmdInstall(): void {
  const mcpBin = getMcpBinPath();

  const config = readClaudeJson();

  // Ensure mcpServers key exists
  if (typeof config.mcpServers !== "object" || config.mcpServers === null) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;

  if ("pai" in servers) {
    console.log(warn("PAI MCP server is already registered in ~/.claude.json."));
    console.log(dim(`  Entry: ${JSON.stringify(servers["pai"])}`));
    console.log(dim("  Use `pai mcp status` to verify the configuration."));
    return;
  }

  servers["pai"] = {
    command: "node",
    args: [mcpBin],
  };

  try {
    writeClaudeJson(config);
  } catch (e) {
    console.error(err(`Failed to write ~/.claude.json: ${e}`));
    process.exit(1);
  }

  console.log(ok("PAI MCP server registered in ~/.claude.json."));
  console.log(dim(`  Binary: ${mcpBin}`));
  console.log(dim(""));
  console.log(dim("  Restart Claude Code to activate the PAI MCP tools:"));
  console.log(dim("    memory_search, memory_get, project_info,"));
  console.log(dim("    project_list, session_list, registry_search"));

  if (!existsSync(mcpBin)) {
    console.log();
    console.log(
      warn(`  Note: MCP binary not found at ${mcpBin}`)
    );
    console.log(dim("  Run `bun run build` to compile it first."));
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function cmdStatus(): void {
  const mcpBin = getMcpBinPath();
  const config = readClaudeJson();

  const servers =
    typeof config.mcpServers === "object" && config.mcpServers !== null
      ? (config.mcpServers as Record<string, unknown>)
      : {};

  const registered = "pai" in servers;
  const binExists = existsSync(mcpBin);

  console.log();
  console.log(bold("  PAI MCP Server Status"));
  console.log();

  if (registered) {
    const entry = servers["pai"];
    console.log(ok(`  Registered in ~/.claude.json`));
    console.log(dim(`    Config: ${JSON.stringify(entry)}`));
  } else {
    console.log(warn(`  NOT registered in ~/.claude.json`));
    console.log(dim(`    Run: pai mcp install`));
  }

  console.log();

  if (binExists) {
    console.log(ok(`  MCP binary found: ${mcpBin}`));
  } else {
    console.log(warn(`  MCP binary NOT found: ${mcpBin}`));
    console.log(dim("    Run: bun run build"));
  }

  console.log();

  if (registered && binExists) {
    console.log(dim("  Status: READY — restart Claude Code to use PAI tools"));
  } else if (registered && !binExists) {
    console.log(warn("  Status: NEEDS BUILD — run `bun run build`"));
  } else {
    console.log(dim("  Status: NOT INSTALLED — run `pai mcp install`"));
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerMcpCommands(mcpCmd: Command): void {
  mcpCmd
    .command("install")
    .description(
      "Register the PAI MCP server in ~/.claude.json (restart Claude Code to activate)"
    )
    .action(() => {
      cmdInstall();
    });

  mcpCmd
    .command("status")
    .description(
      "Show whether the PAI MCP server is registered and the binary exists"
    )
    .action(() => {
      cmdStatus();
    });
}
