/**
 * ntfy.ts — ntfy.sh notification provider
 *
 * Sends notifications to a configured ntfy.sh topic via HTTP.
 */

import type {
  NotificationProvider,
  NotificationPayload,
  NotificationConfig,
} from "../types.js";

export class NtfyProvider implements NotificationProvider {
  readonly channelId = "ntfy" as const;

  async send(
    payload: NotificationPayload,
    config: NotificationConfig
  ): Promise<boolean> {
    const cfg = config.channels.ntfy;
    if (!cfg.enabled || !cfg.url) return false;

    try {
      const headers: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
      };

      if (payload.title) {
        headers["Title"] = payload.title;
      }

      if (cfg.priority && cfg.priority !== "default") {
        headers["Priority"] = cfg.priority;
      }

      const response = await fetch(cfg.url, {
        method: "POST",
        headers,
        body: payload.message,
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
