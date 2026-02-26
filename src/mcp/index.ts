#!/usr/bin/env node
/**
 * PAI Knowledge OS — MCP server entry point
 *
 * When invoked as `node dist/mcp/index.mjs` (or via the `pai-mcp` bin),
 * starts the PAI MCP server on stdio transport so Claude Code can call
 * memory_search, memory_get, project_info, project_list, session_list,
 * and registry_search tools directly during conversations.
 */

import { startMcpServer } from "./server.js";

startMcpServer().catch((err) => {
  // Write errors to stderr only — stdout is reserved for JSON-RPC messages
  process.stderr.write(`PAI MCP server fatal error: ${String(err)}\n`);
  process.exit(1);
});
