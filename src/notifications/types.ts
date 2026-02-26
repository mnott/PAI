/**
 * types.ts — Unified Notification Framework type definitions
 *
 * Defines the channel registry, event routing, and configuration schema
 * for PAI's notification subsystem.
 */

// ---------------------------------------------------------------------------
// Channel identifiers
// ---------------------------------------------------------------------------

export type ChannelId = "ntfy" | "whatsapp" | "macos" | "voice" | "cli";

// ---------------------------------------------------------------------------
// Notification event types
// ---------------------------------------------------------------------------

/**
 * The semantic type of a notification event.
 * Used to route events to the appropriate channels.
 */
export type NotificationEvent =
  | "error"
  | "progress"
  | "completion"
  | "info"
  | "debug";

// ---------------------------------------------------------------------------
// Notification mode
// ---------------------------------------------------------------------------

/**
 * The current notification mode.
 *
 * - "auto"      — Use the per-event routing table (default)
 * - "voice"     — All events go to voice (WhatsApp TTS)
 * - "whatsapp"  — All events go to WhatsApp text
 * - "ntfy"      — All events go to ntfy.sh
 * - "macos"     — All events go to macOS notifications
 * - "cli"       — All events go to CLI stdout only
 * - "off"       — Suppress all notifications
 */
export type NotificationMode =
  | "auto"
  | "voice"
  | "whatsapp"
  | "ntfy"
  | "macos"
  | "cli"
  | "off";

// ---------------------------------------------------------------------------
// Per-channel configuration
// ---------------------------------------------------------------------------

export interface NtfyChannelConfig {
  enabled: boolean;
  /** ntfy.sh topic URL, e.g. "https://ntfy.sh/my-topic" */
  url?: string;
  /** ntfy priority: min | low | default | high | urgent */
  priority?: "min" | "low" | "default" | "high" | "urgent";
}

export interface WhatsAppChannelConfig {
  enabled: boolean;
  /** Optional recipient (phone, JID, or contact name). Omit for self-chat. */
  recipient?: string;
}

export interface MacOsChannelConfig {
  enabled: boolean;
}

export interface VoiceChannelConfig {
  enabled: boolean;
  /** Kokoro voice name, e.g. "bm_george", "af_bella". Default: "bm_george" */
  voiceName?: string;
}

export interface CliChannelConfig {
  enabled: boolean;
}

export interface ChannelConfigs {
  ntfy: NtfyChannelConfig;
  whatsapp: WhatsAppChannelConfig;
  macos: MacOsChannelConfig;
  voice: VoiceChannelConfig;
  cli: CliChannelConfig;
}

// ---------------------------------------------------------------------------
// Routing table
// ---------------------------------------------------------------------------

/**
 * Maps each event type to the ordered list of channels that should receive it.
 * Only channels that are enabled in `channels` and present in this list are used.
 */
export type RoutingTable = {
  [K in NotificationEvent]: ChannelId[];
};

export const DEFAULT_ROUTING: RoutingTable = {
  error:      ["whatsapp", "macos", "ntfy", "cli"],
  completion: ["whatsapp", "macos", "ntfy", "cli"],
  info:       ["cli"],
  progress:   ["cli"],
  debug:      [],
};

// ---------------------------------------------------------------------------
// Top-level notification config (embedded in PaiDaemonConfig)
// ---------------------------------------------------------------------------

export interface NotificationConfig {
  /** Current routing mode. Default: "auto" */
  mode: NotificationMode;
  /** Per-channel configuration */
  channels: ChannelConfigs;
  /** Event → channel routing (used in "auto" mode) */
  routing: RoutingTable;
}

export const DEFAULT_CHANNELS: ChannelConfigs = {
  ntfy: {
    enabled: false,
    url: undefined,
    priority: "default",
  },
  whatsapp: {
    enabled: true,
    recipient: undefined,
  },
  macos: {
    enabled: true,
  },
  voice: {
    enabled: false,
    voiceName: "bm_george",
  },
  cli: {
    enabled: true,
  },
};

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  mode: "auto",
  channels: DEFAULT_CHANNELS,
  routing: DEFAULT_ROUTING,
};

// ---------------------------------------------------------------------------
// Notification payload
// ---------------------------------------------------------------------------

export interface NotificationPayload {
  /** Semantic event type — used for routing */
  event: NotificationEvent;
  /** The notification message body */
  message: string;
  /** Optional title (used by macOS, ntfy) */
  title?: string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface NotificationProvider {
  readonly channelId: ChannelId;
  /**
   * Send a notification.
   * Returns true on success, false on failure (failure is non-fatal).
   */
  send(payload: NotificationPayload, config: NotificationConfig): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Send result
// ---------------------------------------------------------------------------

export interface SendResult {
  channelsAttempted: ChannelId[];
  channelsSucceeded: ChannelId[];
  channelsFailed: ChannelId[];
  mode: NotificationMode;
}
