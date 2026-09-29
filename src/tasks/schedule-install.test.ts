/**
 * installSchedule on non-darwin must not touch launchctl or the filesystem —
 * only darwin has launchd, and there is no Linux/Windows equivalent wired up
 * for the task scheduler yet. Before this guard, a non-darwin call would write
 * a macOS plist to a garbage location and then fail confusingly on launchctl.
 */

import { describe, it, expect, afterEach } from "vitest";
import { installSchedule } from "./schedule-install.js";

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
