#!/usr/bin/env node

/**
 * block-unlisted-mail.ts — PreToolUse (mcp__*)
 *
 * Denies a mail-send MCP tool when any To/Cc/Bcc address is neither in
 * identity.selfEmails nor identity.mailWhitelist (config.yaml). Draft tools
 * stay allowed. The decision lives in lib/mail-whitelist-gate.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { decideMailGate, isMailSendTool, type MailGateInput } from "../lib/mail-whitelist-gate.js";
import { allow, deny, readGateInput } from "../lib/gate-io.js";

function readIdentity(): { selfEmails?: string[]; mailWhitelist?: string[] } | undefined {
  try {
    const file = process.env.PAI_CONFIG_FILE || join(homedir(), ".pai", "config.yaml");
    if (!existsSync(file)) return undefined;
    return (parse(readFileSync(file, "utf8")) as { identity?: { selfEmails?: string[]; mailWhitelist?: string[] } })?.identity;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const input = await readGateInput<MailGateInput>();
  if (!input || !isMailSendTool(input.tool_name)) return allow();
  const d = decideMailGate(input, readIdentity());
  if (d.decision === "deny") return deny(d.reason);
  return allow();
}

main().catch(() => process.exit(0));
