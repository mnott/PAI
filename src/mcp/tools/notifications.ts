/**
 * MCP tool handler: notification_config
 */

import type { NotificationMode, NotificationEvent } from "../../notifications/types.js";
import type { ToolResult } from "./types.js";
// Static on purpose: a lazy import() of a dist chunk first hit after a rebuild
// throws "Cannot find module" in a long-running daemon (prune-dist.mjs deletes superseded chunks).
import { PaiClient } from "../../daemon/ipc-client.js";

// ---------------------------------------------------------------------------
// Tool: notification_config
// ---------------------------------------------------------------------------

export interface NotificationConfigParams {
  /** Action to perform */
  action: "get" | "set" | "send";
  /** For action="set": the notification mode to activate */
  mode?: NotificationMode;
  /** For action="set": partial channel config overrides (JSON object) */
  channels?: Record<string, unknown>;
  /** For action="set": partial routing overrides (JSON object) */
  routing?: Record<string, unknown>;
  /** For action="send": the event type */
  event?: NotificationEvent;
  /** For action="send": the notification message */
  message?: string;
  /** For action="send": optional title */
  title?: string;
}

/**
 * Handle notification config queries and updates via the daemon IPC.
 * Falls back gracefully if the daemon is not running.
 */
export async function toolNotificationConfig(
  params: NotificationConfigParams
): Promise<ToolResult> {
  try {
    const client = new PaiClient();

    if (params.action === "get") {
      const { config, activeChannels } = await client.getNotificationConfig();
      const lines = [
        `mode: ${config.mode}`,
        `active_channels: ${activeChannels.join(", ") || "(none)"}`,
        "",
        "channels:",
        ...Object.entries(config.channels).map(([ch, cfg]) => {
          const c = cfg as { enabled: boolean };
          return `  ${ch}: ${c.enabled ? "enabled" : "disabled"}`;
        }),
        "",
        "routing:",
        ...Object.entries(config.routing).map(
          ([event, channels]) => `  ${event}: ${(channels as string[]).join(", ") || "(none)"}`
        ),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }

    if (params.action === "set") {
      if (!params.mode && !params.channels && !params.routing) {
        return {
          content: [
            {
              type: "text",
              text: "notification_config set: provide at least one of mode, channels, or routing.",
            },
          ],
          isError: true,
        };
      }
      const result = await client.setNotificationConfig({
        mode: params.mode,
        channels: params.channels as Parameters<typeof client.setNotificationConfig>[0]["channels"],
        routing: params.routing as Parameters<typeof client.setNotificationConfig>[0]["routing"],
      });
      return {
        content: [
          {
            type: "text",
            text: `Notification config updated. Mode: ${result.config.mode}`,
          },
        ],
      };
    }

    if (params.action === "send") {
      if (!params.message) {
        return {
          content: [
            { type: "text", text: "notification_config send: message is required." },
          ],
          isError: true,
        };
      }
      const result = await client.sendNotification({
        event: params.event ?? "info",
        message: params.message,
        title: params.title,
      });
      const lines = [
        `mode: ${result.mode}`,
        `attempted: ${result.channelsAttempted.join(", ") || "(none)"}`,
        `succeeded: ${result.channelsSucceeded.join(", ") || "(none)"}`,
        ...(result.channelsFailed.length > 0
          ? [`failed: ${result.channelsFailed.join(", ")}`]
          : []),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Unknown action: ${String(params.action)}. Use "get", "set", or "send".`,
        },
      ],
      isError: true,
    };
  } catch (e) {
    return {
      content: [
        { type: "text", text: `notification_config error: ${String(e)}` },
      ],
      isError: true,
    };
  }
}
