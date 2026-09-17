#!/usr/bin/env node
/**
 * pai-browser-mcp — stdio MCP server for the PAI browser bridge.
 *
 * The provider-independent claude-in-chrome replacement: drives the user's
 * real running Chrome (tabs + DOM) through the browser-bridge extension's
 * native messaging host, over ws://127.0.0.1:8756. Any MCP client works —
 * nothing here is Anthropic-specific.
 *
 *   provider → MCP (this server) → WebSocket → native host → extension → Chrome
 *
 * If Chrome is not running (or the extension is not loaded), every tool
 * returns a clear "start Chrome" error; the server itself stays alive and
 * reconnects lazily per call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient, globalWebSocketFactory } from "./bridge-client.js";
import { registerBrowserTools } from "./tools.js";

async function main(): Promise<void> {
  if (globalThis.WebSocket === undefined) {
    // Node < 22 has no global WebSocket client; say so instead of crashing
    // with an opaque TypeError when the first tool call connects.
    process.stderr.write(
      "pai-browser-mcp: this node runtime has no global WebSocket — run with node >= 22\n"
    );
    process.exit(1);
  }

  const server = new McpServer({
    name: "pai-browser",
    version: "0.1.0",
  });

  const bridge = new BridgeClient(undefined, globalWebSocketFactory);
  registerBrowserTools(server, bridge);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`pai-browser-mcp fatal error: ${String(e)}\n`);
  process.exit(1);
});
