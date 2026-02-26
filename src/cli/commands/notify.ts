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

import type { Command } from "commander";
import { ok, warn, err, dim, bold, header } from "../utils.js";
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

async function cmdStatus(): Promise<void> {
  const client = makeClient();
  try {
    const { config, activeChannels } = await client.getNotificationConfig();
    printConfig(config, activeChannels);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log();
    console.log(warn("  Cannot reach PAI daemon."));
    console.log(dim(`  ${msg}`));
    console.log(dim("  Start it with: pai daemon serve"));
    console.log();
    process.exit(1);
  }
}

async function cmdSet(opts: {
  mode?: string;
  ntfyUrl?: string;
  ntfyPriority?: string;
  whatsappRecipient?: string;
  enableChannel?: string[];
  disableChannel?: string[];
}): Promise<void> {
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
      process.exit(1);
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
    process.exit(1);
  }

  try {
    const { config } = await client.setNotificationConfig(
      patch as Parameters<typeof client.setNotificationConfig>[0]
    );
    console.log();
    console.log(ok("  Notification config updated."));
    console.log(`  ${bold("Mode:")} ${modeColor(config.mode)}`);
    console.log();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  Failed: ${msg}`));
    process.exit(1);
  }
}

async function cmdTest(opts: { event?: string }): Promise<void> {
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  Failed: ${msg}`));
    process.exit(1);
  }
}

async function cmdSend(
  event: string,
  message: string,
  opts: { title?: string }
): Promise<void> {
  const client = makeClient();
  const validEvents: NotificationEvent[] = [
    "error", "progress", "completion", "info", "debug",
  ];

  if (!validEvents.includes(event as NotificationEvent)) {
    console.error(
      err(`Invalid event: ${event}. Valid: ${validEvents.join(", ")}`)
    );
    process.exit(1);
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  Failed: ${msg}`));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerNotifyCommands(notifyCmd: Command): void {
  // pai notify status (default / alias for get)
  notifyCmd
    .command("status")
    .description("Show current notification mode and active channels")
    .action(async () => {
      await cmdStatus();
    });

  // pai notify get (alias for status)
  notifyCmd
    .command("get")
    .description("Show current notification config (alias for status)")
    .action(async () => {
      await cmdStatus();
    });

  // pai notify set
  notifyCmd
    .command("set")
    .description("Update notification mode or channel configuration")
    .option(
      "--mode <mode>",
      "Notification mode: auto | voice | whatsapp | ntfy | macos | cli | off"
    )
    .option("--enable <channel...>", "Enable one or more channels")
    .option("--disable <channel...>", "Disable one or more channels")
    .option("--ntfy-url <url>", "Set the ntfy.sh topic URL")
    .option(
      "--ntfy-priority <level>",
      "Set ntfy priority: min | low | default | high | urgent"
    )
    .option("--whatsapp-recipient <contact>", "Set WhatsApp recipient")
    .action(
      async (opts: {
        mode?: string;
        enable?: string[];
        disable?: string[];
        ntfyUrl?: string;
        ntfyPriority?: string;
        whatsappRecipient?: string;
      }) => {
        await cmdSet({
          mode: opts.mode,
          enableChannel: opts.enable,
          disableChannel: opts.disable,
          ntfyUrl: opts.ntfyUrl,
          ntfyPriority: opts.ntfyPriority,
          whatsappRecipient: opts.whatsappRecipient,
        });
      }
    );

  // pai notify test
  notifyCmd
    .command("test")
    .description("Send a test notification through configured channels")
    .option(
      "--event <event>",
      "Event type to test: error | progress | completion | info | debug",
      "info"
    )
    .action(async (opts: { event?: string }) => {
      await cmdTest(opts);
    });

  // pai notify send <event> <message>
  notifyCmd
    .command("send <event> <message>")
    .description("Send a notification with an explicit event type and message")
    .option("--title <title>", "Optional notification title")
    .action(async (event: string, message: string, opts: { title?: string }) => {
      await cmdSend(event, message, opts);
    });
}
