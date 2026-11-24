import { describe, it, expect } from "vitest";
import { decideMailGate } from "./mail-whitelist-gate.js";

const id = { selfEmails: ["me@example.com"], mailWhitelist: ["colleague@example.com"] };
const send = (tool_input: Record<string, unknown>, tool_name = "mcp__coogle__send_gmail_message") => decideMailGate({ tool_name, tool_input }, id);
const reason = (addr: string) => `not on the mail whitelist: ${addr} — create a draft instead`;

describe("mail whitelist gate", () => {
  it("allows self and whitelisted, case-insensitive, Name <addr> and lists", () => {
    expect(send({ to: "ME@example.com" }).decision).toBe("allow");
    expect(send({ to: ["Col <colleague@example.com>"], cc: "me@example.com, colleague@example.com" }).decision).toBe("allow");
  });
  it("denies others with the exact reason on every mail server", () => {
    expect(send({ to: "stranger@example.net" })).toEqual({ decision: "deny", reason: reason("stranger@example.net") });
    expect(send({ to: "me@example.com" }, "mcp__aibroker__aibroker_mail_send").decision).toBe("allow");
    expect(send({ to: "x@example.net" }, "mcp__claude_ai_Gmail__send_message").decision).toBe("deny");
    expect(send({ to: "x@example.net" }, "mcp__aibroker__aibroker_mail_send").decision).toBe("deny");
  });
  it("checks cc and bcc", () => {
    expect(send({ to: "me@example.com", cc: "a@example.net" })).toEqual({ decision: "deny", reason: reason("a@example.net") });
    expect(send({ to: "me@example.com", bcc: ["Z <z@example.net>"] })).toEqual({ decision: "deny", reason: reason("z@example.net") });
  });
  it("allows draft tools and ignores non-mail tools", () => {
    expect(send({ to: "x@example.net" }, "mcp__coogle__create_gmail_draft").decision).toBe("allow");
    expect(send({ to: "x@example.net" }, "mcp__other__send_message").decision).toBe("allow");
    expect(send({ to: "x@example.net" }, "Bash").decision).toBe("allow");
  });
  it("denies everything when no identity is configured", () => {
    expect(decideMailGate({ tool_name: "mcp__coogle__send_gmail_message", tool_input: { to: "me@example.com" } }, undefined).decision).toBe("deny");
  });
});
