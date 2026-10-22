/**
 * macos.ts — macOS notification provider
 *
 * Uses the `osascript` command to display a macOS system notification.
 * Non-blocking: spawns the process and returns success without waiting.
 */

import { spawn } from "node:child_process";
import type {
  NotificationProvider,
  NotificationPayload,
  NotificationConfig,
} from "../types.js";

export class MacOsProvider implements NotificationProvider {
  readonly channelId = "macos" as const;

  async send(
    payload: NotificationPayload,
    config: NotificationConfig
  ): Promise<boolean> {
    const cfg = config.channels.macos;
    if (!cfg.enabled) return false;
    if (process.platform !== "darwin") return false;

    try {
      const title = payload.title ?? "PAI";
      // The script is constant; text reaches AppleScript only as argv items.
      const args = [
        "-e", "on run argv",
        "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
        "-e", "end run",
        "--", payload.message, title,
      ];

      return new Promise((resolve) => {
        const child = spawn("osascript", args, {
          detached: true,
          stdio: "ignore",
        });
        child.unref();

        // Give the process a moment to start, then assume success.
        // osascript is always present on macOS.
        child.on("error", () => resolve(false));

        // Resolve after a short timeout — osascript exits quickly
        setTimeout(() => resolve(true), 200);
      });
    } catch {
      return false;
    }
  }
}
