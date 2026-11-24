/**
 * mail-whitelist-gate.ts — the decision behind the PreToolUse mail whitelist gate.
 *
 * Pure: the hook entry (pre-tool-use/block-unlisted-mail.ts) reads stdin and
 * identity.selfEmails / identity.mailWhitelist from config.yaml; this module
 * decides. A send tool on a mail server may only address the user's own
 * addresses and the whitelist; anything else must go through a draft.
 */

import { isMailWhitelisted, normalizeEmail, type IdentityLike } from "../../../identity/index.js";

export interface MailGateInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export type MailGateDecision = { decision: "allow" } | { decision: "deny"; reason: string };

const SEND_TOOL_RE = /send.*(mail|message)|(mail|message).*send/i;
const RECIPIENT_FIELDS = ["to", "cc", "bcc"];

/** Is this an MCP tool that sends mail (draft tools never do)? */
export function isMailSendTool(name: string | undefined): boolean {
  if (!name || !name.startsWith("mcp__")) return false;
  const tool = name.split("__").slice(2).join("__");
  // mail servers only: "mail" in server or tool name (gmail, coogle send_gmail_message, aibroker_mail_send)
  return SEND_TOOL_RE.test(tool) && /mail/i.test(name) && !/draft/i.test(name);
}

/** Every To/Cc/Bcc entry as written (string, comma list or array; "Name <a@b.c>" kept whole per address). */
export function recipientsOf(input: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const field of RECIPIENT_FIELDS) {
    const v = input?.[field];
    const parts = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    for (const p of parts) {
      if (typeof p !== "string") continue;
      // split on commas/semicolons outside <...> and quotes
      for (const s of p.match(/(?:"[^"]*"|<[^>]*>|[^,;])+/g) ?? []) if (s.trim()) out.push(s.trim());
    }
  }
  return out;
}

export function decideMailGate(input: MailGateInput, identity: IdentityLike & { mailWhitelist?: string[] } | undefined): MailGateDecision {
  if (!isMailSendTool(input.tool_name)) return { decision: "allow" };
  for (const r of recipientsOf(input.tool_input)) {
    if (!isMailWhitelisted(r, identity)) {
      return { decision: "deny", reason: `not on the mail whitelist: ${normalizeEmail(r) ?? r} — create a draft instead` };
    }
  }
  return { decision: "allow" };
}
