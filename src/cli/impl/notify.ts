/**
 * pai notify <sub-command>
 *
 * status   — Show current notification mode and active channels
 * get      — Alias for status
 * set      — Set notification mode or channel/routing config
 * test     — Send a test notification through configured channels
 * send     — Send a notification (event + message)
 *
 * All sub-commands communicate with the running daemon via IPC.
 */

import { ok, warn, err, dim, bold, header } from "../lib/utils.js";
import { loadConfig } from "../../daemon/config.js";
import { PaiClient } from "../../daemon/ipc-client.js";
import type {
  NotificationConfig,
  NotificationMode,
  NotificationEvent,
} from "../../notifications/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): PaiClient {
  const config = loadConfig();
  return new PaiClient(config.socketPath);
}

function modeColor(mode: NotificationMode): string {
  switch (mode) {
    case "off":
      return warn(mode);
    case "voice":
      return bold(ok(mode));
    case "auto":
      return ok(mode);
    default:
      return ok(mode);
  }
}

function printConfig(config: NotificationConfig, activeChannels: string[]): void {
  console.log();
  console.log(header("  PAI Notification Config"));
  console.log();
  console.log(`  ${bold("Mode:")}    ${modeColor(config.mode)}`);
  console.log();
  console.log(`  ${bold("Channels:")}`);
  for (const [ch, cfg] of Object.entries(config.channels)) {
    const c = cfg as { enabled: boolean; url?: string; voiceName?: string };
    const status = c.enabled ? ok("enabled") : dim("disabled");
    let extra = "";
    if (ch === "ntfy" && c.url) extra = dim(`  ${c.url}`);
    if (ch === "voice" && c.voiceName) extra = dim(`  voice: ${c.voiceName}`);
    console.log(`    ${bold(ch.padEnd(12))}${status}${extra}`);
  }
  console.log();
  console.log(`  ${bold("Active:")}  ${activeChannels.length > 0 ? activeChannels.join(", ") : dim("(none)")}`);
  console.log();
  console.log(`  ${bold("Routing:")} ${dim("(auto mode only)")}`);
  for (const [event, channels] of Object.entries(config.routing)) {
    const ch = (channels as string[]).join(", ") || dim("(none)");
    console.log(`    ${event.padEnd(12)}→  ${ch}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

export async function notifyStatusCmd(): Promise<number> {
  const client = makeClient();
  try {
    const { config, activeChannels } = await client.getNotificationConfig();
    printConfig(config, activeChannels);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log();
    console.log(warn("  Cannot reach PAI daemon."));
    console.log(dim(`  ${msg}`));
    console.log(dim("  Start it with: pai daemon serve"));
    console.log();
    return 1;
  }
}

export async function notifySetCmd(opts: {
  mode?: string;
  ntfyUrl?: string;
  ntfyPriority?: string;
  whatsappRecipient?: string;
  enableChannel?: string[];
  disableChannel?: string[];
}): Promise<number> {
  const client = makeClient();

  // Build the patch object
  const patch: {
    mode?: NotificationMode;
    channels?: Record<string, unknown>;
  } = {};

  if (opts.mode) {
    const validModes: NotificationMode[] = [
      "auto", "voice", "whatsapp", "ntfy", "macos", "cli", "off",
    ];
    if (!validModes.includes(opts.mode as NotificationMode)) {
      console.error(err(`Invalid mode: ${opts.mode}. Valid: ${validModes.join(", ")}`));
      return 1;
    }
    patch.mode = opts.mode as NotificationMode;
  }

  // Channel enable/disable
  const channels: Record<string, unknown> = {};

  if (opts.enableChannel) {
    for (const ch of opts.enableChannel) {
      channels[ch] = { enabled: true };
    }
  }

  if (opts.disableChannel) {
    for (const ch of opts.disableChannel) {
      channels[ch] = { enabled: false };
    }
  }

  if (opts.ntfyUrl) {
    channels["ntfy"] = {
      ...(channels["ntfy"] as object ?? {}),
      url: opts.ntfyUrl,
    };
  }

  if (opts.ntfyPriority) {
    channels["ntfy"] = {
      ...(channels["ntfy"] as object ?? {}),
      priority: opts.ntfyPriority,
    };
  }

  if (opts.whatsappRecipient) {
    channels["whatsapp"] = {
      ...(channels["whatsapp"] as object ?? {}),
      recipient: opts.whatsappRecipient,
    };
  }

  if (Object.keys(channels).length > 0) {
    patch.channels = channels;
  }

  if (!patch.mode && !patch.channels) {
    console.error(err("No changes specified. Use --mode, --enable, --disable, etc."));
    console.log(dim("  Example: pai notify set --mode voice"));
    console.log(dim("  Example: pai notify set --mode auto --enable macos --disable ntfy"));
    return 1;
  }

  try {
    const { config } = await client.setNotificationConfig(
      patch as Parameters<typeof client.setNotificationConfig>[0]
    );
    console.log();
    console.log(ok("  Notification config updated."));
    console.log(`  ${bold("Mode:")} ${modeColor(config.mode)}`);
    console.log();
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  Failed: ${msg}`));
    return 1;
  }
}

export async function notifyTestCmd(opts: { event?: string }): Promise<number> {
  const client = makeClient();
  const event = (opts.event ?? "info") as NotificationEvent;

  console.log();
  console.log(dim(`  Sending test ${event} notification...`));

  try {
    const result = await client.sendNotification({
      event,
      message: `PAI test notification (${event})`,
      title: "PAI Test",
    });

    if (result.channelsSucceeded.length === 0 && result.channelsAttempted.length > 0) {
      console.log(warn("  All channels failed."));
    } else if (result.channelsAttempted.length === 0) {
      console.log(warn("  No channels active for this event. Check mode and channel config."));
    } else {
      console.log(ok(`  Sent to: ${result.channelsSucceeded.join(", ")}`));
    }

    if (result.channelsFailed.length > 0) {
      console.log(warn(`  Failed: ${result.channelsFailed.join(", ")}`));
    }

    console.log(dim(`  Mode: ${result.mode}`));
    console.log();
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  Failed: ${msg}`));
    return 1;
  }
}

export async function notifySendCmd(
  event: string,
  message: string,
  opts: { title?: string }
): Promise<number> {
  const client = makeClient();
  const validEvents: NotificationEvent[] = [
    "error", "progress", "completion", "info", "debug",
  ];

  if (!validEvents.includes(event as NotificationEvent)) {
    console.error(
      err(`Invalid event: ${event}. Valid: ${validEvents.join(", ")}`)
    );
    return 1;
  }

  try {
    const result = await client.sendNotification({
      event: event as NotificationEvent,
      message,
      title: opts.title,
    });

    if (result.channelsSucceeded.length > 0) {
      console.log(ok(`  Sent to: ${result.channelsSucceeded.join(", ")}`));
    } else {
      console.log(warn("  No channels received the notification."));
    }

    if (result.channelsFailed.length > 0) {
      console.log(warn(`  Failed: ${result.channelsFailed.join(", ")}`));
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  Failed: ${msg}`));
    return 1;
  }
}
