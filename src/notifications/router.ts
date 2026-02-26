/**
 * router.ts — Notification router
 *
 * Routes notification events to the appropriate channels based on the
 * current mode and per-event routing config.
 *
 * Channel providers are instantiated lazily and cached.
 */

import type {
  NotificationPayload,
  NotificationConfig,
  NotificationProvider,
  ChannelId,
  SendResult,
  NotificationMode,
} from "./types.js";
import { NtfyProvider } from "./providers/ntfy.js";
import { WhatsAppProvider } from "./providers/whatsapp.js";
import { MacOsProvider } from "./providers/macos.js";
import { CliProvider } from "./providers/cli.js";

// ---------------------------------------------------------------------------
// Provider registry (singletons — stateless, safe to reuse)
// ---------------------------------------------------------------------------

const PROVIDERS: Record<ChannelId, NotificationProvider> = {
  ntfy:      new NtfyProvider(),
  whatsapp:  new WhatsAppProvider(),
  macos:     new MacOsProvider(),
  voice:     new WhatsAppProvider(), // Voice uses WhatsApp TTS; handled in WhatsAppProvider
  cli:       new CliProvider(),
};

// ---------------------------------------------------------------------------
// Channel resolution
// ---------------------------------------------------------------------------

/**
 * Given the current config, resolve which channels should receive a
 * notification for the given event type.
 *
 * Mode overrides:
 *   "off"       → no channels
 *   "auto"      → use routing table, filtered by enabled channels
 *   "voice"     → whatsapp (TTS enabled in provider)
 *   "whatsapp"  → whatsapp
 *   "ntfy"      → ntfy
 *   "macos"     → macos
 *   "cli"       → cli
 */
function resolveChannels(
  config: NotificationConfig,
  event: NotificationPayload["event"]
): ChannelId[] {
  const { mode, channels, routing } = config;

  if (mode === "off") return [];

  // Non-auto modes: force a single channel
  const modeToChannel: Partial<Record<NotificationMode, ChannelId>> = {
    voice:     "whatsapp",  // WhatsAppProvider checks mode === "voice" for TTS
    whatsapp:  "whatsapp",
    ntfy:      "ntfy",
    macos:     "macos",
    cli:       "cli",
  };

  if (mode !== "auto") {
    const ch = modeToChannel[mode];
    if (!ch) return [];
    // Check the channel is enabled
    const cfg = channels[ch];
    if (cfg && !cfg.enabled) return [ch]; // Still send — mode override bypasses enabled check
    return [ch];
  }

  // Auto mode: use routing table, filter to enabled channels
  const candidates = routing[event] ?? [];
  return candidates.filter((ch) => {
    const cfg = channels[ch];
    // "voice" channel is virtual — it overlaps with whatsapp.
    // Skip "voice" as an independent channel; voice is handled by checking config.mode.
    if (ch === "voice") return false;
    return cfg?.enabled === true;
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Route a notification to the appropriate channels.
 *
 * Sends to all resolved channels in parallel.
 * Individual channel failures are non-fatal and logged to stderr.
 *
 * @param payload  The notification to send
 * @param config   The current notification config (from daemon state)
 */
export async function routeNotification(
  payload: NotificationPayload,
  config: NotificationConfig
): Promise<SendResult> {
  const channels = resolveChannels(config, payload.event);

  if (channels.length === 0) {
    return {
      channelsAttempted: [],
      channelsSucceeded: [],
      channelsFailed: [],
      mode: config.mode,
    };
  }

  const results = await Promise.allSettled(
    channels.map(async (ch) => {
      const provider = PROVIDERS[ch];
      const ok = await provider.send(payload, config);
      if (!ok) {
        process.stderr.write(
          `[pai-notify] Channel ${ch} failed for event ${payload.event}\n`
        );
      }
      return { ch, ok };
    })
  );

  const succeeded: ChannelId[] = [];
  const failed: ChannelId[] = [];

  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value.ok) {
        succeeded.push(r.value.ch);
      } else {
        failed.push(r.value.ch);
      }
    } else {
      // Provider threw — treat as failure
      failed.push(channels[results.indexOf(r)]);
    }
  }

  return {
    channelsAttempted: channels,
    channelsSucceeded: succeeded,
    channelsFailed: failed,
    mode: config.mode,
  };
}
