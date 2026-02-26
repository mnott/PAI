/**
 * cli.ts — CLI notification provider
 *
 * Writes notifications to the PAI daemon log (stderr).
 * Always succeeds — it's the fallback channel.
 */

import type {
  NotificationProvider,
  NotificationPayload,
  NotificationConfig,
} from "../types.js";

export class CliProvider implements NotificationProvider {
  readonly channelId = "cli" as const;

  async send(
    payload: NotificationPayload,
    _config: NotificationConfig
  ): Promise<boolean> {
    const prefix = `[pai-notify:${payload.event}]`;
    const title = payload.title ? ` ${payload.title}:` : "";
    process.stderr.write(`${prefix}${title} ${payload.message}\n`);
    return true;
  }
}
