/** Step 10: PAI MCP server registration in ~/.claude.json. */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { c, line, section, type Rl, promptYesNo } from "../utils.js";

export async function stepMcp(rl: Rl): Promise<boolean> {
  section("Step 10: MCP Registration");
  line();
  line("  Registering the PAI MCP server lets Claude Code call PAI tools directly.");
  line();

  const claudeJsonPath = join(homedir(), ".claude.json");
  if (existsSync(claudeJsonPath)) {
    try {
      const raw = readFileSync(claudeJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const mcpServers = parsed["mcpServers"] as Record<string, unknown> | undefined;
      if (mcpServers && Object.prototype.hasOwnProperty.call(mcpServers, "pai")) {
        console.log(c.ok("PAI MCP server already registered in ~/.claude.json."));
        console.log(c.dim("  Skipping MCP registration."));
        return false;
      }
    } catch {
      // continue
    }
  }

  const register = await promptYesNo(rl, "Register the PAI MCP server in ~/.claude.json?", true);
  if (!register) {
    console.log(c.dim("  Skipping MCP registration. Run manually: pai mcp install"));
    return false;
  }

  line();
  const result = spawnSync("pai", ["mcp", "install"], { stdio: "inherit" });

  if (result.status !== 0) {
    console.log(c.warn("  MCP registration failed. Run manually: pai mcp install"));
    return false;
  }

  console.log(c.ok("PAI MCP server registered in ~/.claude.json."));
  return true;
}
