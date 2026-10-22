/**
 * installSchedule on non-darwin must not touch launchctl or the filesystem —
 * only darwin has launchd, and there is no Linux/Windows equivalent wired up
 * for the task scheduler yet. Before this guard, a non-darwin call would write
 * a macOS plist to a garbage location and then fail confusingly on launchctl.
 */

import { describe, it, expect, afterEach } from "vitest";
import { installSchedule, generateSchedulePlist } from "./schedule-install.js";

const REAL_PLATFORM = process.platform;

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform });
}

describe("installSchedule on an unsupported platform", () => {
  afterEach(() => {
    setPlatform(REAL_PLATFORM);
  });

  it("returns a one-line message instead of writing a plist or calling launchctl", () => {
    setPlatform("linux");
    const result = installSchedule(900);
    expect(result.loaded).toBe(false);
    expect(result.message).toBe("scheduler install supports launchd (macOS) only");
  });
});

describe("generateSchedulePlist escaping", () => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  it("XML-escapes interpolated paths and uses the running node", () => {
    const plist = generateSchedulePlist(900, "/tmp/a&b/<x>/cli.mjs");
    expect(plist).toContain("<string>/tmp/a&amp;b/&lt;x&gt;/cli.mjs</string>");
    expect(plist).not.toContain("a&b");
    expect(plist).toContain(`<string>${esc(process.execPath)}</string>`);
  });
});
