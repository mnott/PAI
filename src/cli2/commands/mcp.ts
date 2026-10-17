/**
 * `pai mcp`: front end for the mcp commands.
 * Behaviour lives in src/cli2/impl/mcp.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import { legacyRunner } from "../lib/legacy.js";
import { registerMcpCommands } from "../impl/mcp.js";

const L = legacyRunner("mcp", registerMcpCommands);

export const mcpSubcommands: CommandDef[] = [
L({
  name: "install",
  summary: "Register the PAI MCP server with Claude Code",
  description: "Register the PAI MCP server with Claude Code.\n\nRegister the PAI MCP server (pai) in ~/.claude.json (restart Claude Code to activate)",
  examples: ["pai mcp install","pai mcp status"],
  seeAlso: ["pai mcp status"],
}),
L({
  name: "status",
  summary: "Show whether the PAI MCP server is registered",
  description: "Show whether the PAI MCP server is registered.\n\nShow whether the PAI MCP server (pai) is registered and the binary exists",
  examples: ["pai mcp status","pai mcp status"],
  seeAlso: ["pai mcp install"],
}),
];

export const mcpCommand: CommandDef = {
  name: "mcp",
  summary: "Install the PAI tools for Claude Code",
  description: "Install the PAI tools for Claude Code.",
  examples: ["pai mcp status","pai mcp install"],
  subcommands: mcpSubcommands,
};
