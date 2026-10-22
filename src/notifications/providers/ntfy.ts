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
        // HTTP header values must be Latin-1; RFC 2047 carries the rest (ntfy decodes it).
        // eslint-disable-next-line no-control-regex
        headers["Title"] = /^[\x20-\x7e]*$/.test(payload.title)
          ? payload.title
          : `=?UTF-8?B?${Buffer.from(payload.title, "utf8").toString("base64")}?=`;
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
