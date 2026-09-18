import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  buildReminder,
  decideMcpDeferredReminder,
  REMINDER_SOURCES,
  type ReminderHookInput,
} from "./mcp-deferred-reminder.js";
import { STALE_HANDLE_MARKER } from "./mcp-deferred-gate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function hookInput(source?: string): ReminderHookInput {
  return { source };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

describe("decideMcpDeferredReminder", () => {
  it("emits the reminder for source resume", () => {
    const out = decideMcpDeferredReminder(hookInput("resume"));
    expect(out).not.toBeNull();
    expect(out).toContain("ToolSearch");
    expect(out).toContain("retry once");
    expect(out).toContain(STALE_HANDLE_MARKER);
  });

  it("emits the reminder for source compact", () => {
    expect(decideMcpDeferredReminder(hookInput("compact"))).not.toBeNull();
  });

  it("reminder stays consistent with the gate's shared stale-handle marker", () => {
    expect(buildReminder()).toContain(`"${STALE_HANDLE_MARKER}"`);
    expect(REMINDER_SOURCES).toEqual(new Set(["resume", "compact"]));
  });

  it("stays silent for source startup", () => {
    expect(decideMcpDeferredReminder(hookInput("startup"))).toBeNull();
  });

  it("stays silent for source clear", () => {
    expect(decideMcpDeferredReminder(hookInput("clear"))).toBeNull();
  });

  it("stays silent for missing or junk source", () => {
    expect(decideMcpDeferredReminder({})).toBeNull();
    expect(decideMcpDeferredReminder(hookInput("nonsense"))).toBeNull();
    expect(decideMcpDeferredReminder(hookInput("RESUME"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Entrypoint — junk input must exit 0 with nothing on stdout
// ---------------------------------------------------------------------------

describe("session-start/mcp-deferred-reminder entrypoint", () => {
  const ENTRYPOINT = "src/hooks/ts/session-start/mcp-deferred-reminder.ts";

  function runHook(stdin: string): { status: number; stdout: string } {
    const stdout = execFileSync("bun", [ENTRYPOINT], {
      input: stdin,
      encoding: "utf8",
      timeout: 15_000,
    });
    return { status: 0, stdout };
  }

  it("junk input exits 0 silent", () => {
    const { status, stdout } = runHook("this is not json {{{");
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("resume input exits 0 with the reminder on stdout", () => {
    const { status, stdout } = runHook(JSON.stringify({ source: "resume" }));
    expect(status).toBe(0);
    expect(stdout).toContain("ToolSearch");
    expect(stdout).toContain("retry once");
  });

  it("startup input exits 0 silent", () => {
    const { status, stdout } = runHook(JSON.stringify({ source: "startup" }));
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });
});
