/**
 * `pai mcp`: front end for the mcp commands.
 * Behaviour lives in src/cli/impl/mcp.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import { mcpInstallCmd, mcpStatusCmd } from "../impl/mcp.js";

export const mcpSubcommands: CommandDef[] = [
{
  name: "install",
  summary: "Register the PAI MCP server with Claude Code",
  description: "Register the PAI MCP server with Claude Code.\n\nRegister the PAI MCP server (pai) in ~/.claude.json (restart Claude Code to activate)",
  examples: ["pai mcp install","pai mcp status"],
  seeAlso: ["pai mcp status"],
  run: (ctx) => mcpInstallCmd(),
},
{
  name: "status",
  summary: "Show whether the PAI MCP server is registered",
  description: "Show whether the PAI MCP server is registered.\n\nShow whether the PAI MCP server (pai) is registered and the binary exists",
  examples: ["pai mcp status","pai mcp status"],
  seeAlso: ["pai mcp install"],
  run: (ctx) => mcpStatusCmd(),
},
];

export const mcpCommand: CommandDef = {
  name: "mcp",
  summary: "Install the PAI tools for Claude Code",
  description: "Install the PAI tools for Claude Code.",
  examples: ["pai mcp status","pai mcp install"],
  subcommands: mcpSubcommands,
};
