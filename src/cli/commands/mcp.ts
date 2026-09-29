/**
 * pai mcp <sub-command>
 *
 * install  — Register the PAI MCP servers in ~/.claude.json
 * status   — Show whether the PAI MCP servers are registered and the binaries exist
 *
 * One server is managed: `pai` (memory/project tools, dist/daemon-mcp/index.mjs).
 * Registration is idempotent: an already-present entry is skipped
 * with a note, a missing one is added.
 */

import type { Command } from "commander";
import { existsSync } from "node:fs";
import { ok, warn, err, dim, bold } from "../utils.js";
import { readClaudeJson, writeClaudeJson } from "../../config/claude-json.js";
import { resolveFromModule } from "../../module-paths.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Absolute path of a built entry under dist/ (chunk depth varies, so walk up — see module-paths). */
function distEntry(entry: string): string {
  return resolveFromModule(import.meta.url, `dist/${entry}`);
}

interface McpServerSpec {
  /** key under mcpServers in ~/.claude.json */
  name: string;
  /** dist/ relative entry path */
  entry: string;
  /** shown in install/status output */
  label: string;
  tools: string;
}

const SERVERS: McpServerSpec[] = [
  {
    name: "pai",
    entry: "daemon-mcp/index.mjs",
    label: "PAI MCP server",
    tools: "memory_search, memory_get, memory_outline, project_info, project_list, session_list, registry_search",
  },
];

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

function cmdInstall(): void {
  const config = readClaudeJson();

  // Ensure mcpServers key exists
  if (typeof config.mcpServers !== "object" || config.mcpServers === null) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  let changed = false;

  for (const spec of SERVERS) {
    const bin = distEntry(spec.entry);

    if (spec.name in servers) {
      console.log(warn(`${spec.label} is already registered in ~/.claude.json as "${spec.name}".`));
      console.log(dim(`  Entry: ${JSON.stringify(servers[spec.name])}`));
      continue;
    }

    servers[spec.name] = {
      command: "node",
      args: [bin],
    };
    changed = true;

    console.log(ok(`${spec.label} registered in ~/.claude.json as "${spec.name}".`));
    console.log(dim(`  Binary: ${bin}`));
    console.log(dim(""));
    console.log(dim("  Restart Claude Code to activate the tools:"));
    console.log(dim(`    ${spec.tools}`));

    if (!existsSync(bin)) {
      console.log();
      console.log(warn(`  Note: MCP binary not found at ${bin}`));
      console.log(dim("  Run `bun run build` to compile it first."));
    }
  }

  if (!changed) {
    console.log(dim("  Use `pai mcp status` to verify the configuration."));
    return;
  }

  try {
    writeClaudeJson(config);
  } catch (e) {
    console.error(err(`Failed to write ~/.claude.json: ${e}`));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function cmdStatus(): void {
  const config = readClaudeJson();

  const servers =
    typeof config.mcpServers === "object" && config.mcpServers !== null
      ? (config.mcpServers as Record<string, unknown>)
      : {};

  console.log();
  console.log(bold("  PAI MCP Server Status"));
  console.log();

  let allReady = true;

  for (const spec of SERVERS) {
    const bin = distEntry(spec.entry);
    const registered = spec.name in servers;
    const binExists = existsSync(bin);

    if (registered) {
      console.log(ok(`  ${spec.name}: registered in ~/.claude.json`));
      console.log(dim(`    Config: ${JSON.stringify(servers[spec.name])}`));
    } else {
      console.log(warn(`  ${spec.name}: NOT registered in ~/.claude.json`));
      console.log(dim(`    Run: pai mcp install`));
    }

    if (binExists) {
      console.log(ok(`    Binary found: ${bin}`));
    } else {
      console.log(warn(`    Binary NOT found: ${bin}`));
      console.log(dim(`      Run: bun run build`));
    }

    if (!registered || !binExists) allReady = false;
    console.log();
  }

  console.log(
    allReady
      ? dim("  Status: READY — restart Claude Code to use the PAI tools")
      : warn("  Status: INCOMPLETE — run `pai mcp install` and/or `bun run build`")
  );

  console.log();
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerMcpCommands(mcpCmd: Command): void {
  mcpCmd
    .command("install")
    .description(
      "Register the PAI MCP server (pai) in ~/.claude.json (restart Claude Code to activate)"
    )
    .action(() => {
      cmdInstall();
    });

  mcpCmd
    .command("status")
    .description(
      "Show whether the PAI MCP server (pai) is registered and the binary exists"
    )
    .action(() => {
      cmdStatus();
    });
}
