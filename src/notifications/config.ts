/**
 * config.ts — Notification config persistence helpers
 *
 * Reads and writes the `notifications` section of CONFIG_FILE (see
 * src/daemon/config.ts's paiConfigFilePath).
 * Deep-merges with defaults so partial configs work fine.
 *
 * This module is intentionally separate from the daemon's config loader
 * so it can be used standalone (e.g. from CLI commands).
 */

import { expandHome, paiConfigFilePath, readMainConfigRaw, writeMainConfigRaw } from "../daemon/config.js";
import { shippedMainDefaults } from "../config/shipped-defaults.js";
import type {
  NotificationConfig,
  ChannelConfigs,
  RoutingTable,
  NotificationMode,
} from "./types.js";

/** The notification defaults live in the shipped defaults file
 * (src/config/defaults/config.yaml, `notifications:`). */
function defaultNotificationConfig(): NotificationConfig {
  return (shippedMainDefaults().notifications ?? {
    mode: "auto",
    channels: {},
    routing: {},
  }) as NotificationConfig;
}

// ---------------------------------------------------------------------------
// Deep merge helper (same approach as daemon/config.ts)
// ---------------------------------------------------------------------------

function deepMerge<T extends object>(
  target: T,
  source: Record<string, unknown>
): T {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined || srcVal === null) continue;
    const tgtVal = (target as Record<string, unknown>)[key];
    if (
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        tgtVal as object,
        srcVal as Record<string, unknown>
      );
    } else {
      (result as Record<string, unknown>)[key] = srcVal;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Load the notification config from the PAI config file.
 * Returns defaults merged with any stored values.
 */
export function loadNotificationConfig(): NotificationConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = readMainConfigRaw();
  } catch {
    return { ...defaultNotificationConfig() };
  }

  const stored = parsed["notifications"];
  if (!stored || typeof stored !== "object") {
    return { ...defaultNotificationConfig() };
  }

  return deepMerge(
    defaultNotificationConfig(),
    stored as Record<string, unknown>
  );
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Persist the notification config by merging it into the existing
 * CONFIG_FILE. Creates the file if it does not exist.
 */
export function saveNotificationConfig(config: NotificationConfig): void {
  const configPath = paiConfigFilePath();
  // Throws, naming the file and the parse error, when the config exists but is unreadable:
  // writing {notifications} alone would replace the user's whole config.
  const full = readMainConfigRaw(configPath);

  // Replace the notifications section
  full["notifications"] = config;

  writeMainConfigRaw(full, configPath);
}

// ---------------------------------------------------------------------------
// Patch helpers (used by the set command)
// ---------------------------------------------------------------------------

/**
 * Apply a partial update to the current notification config and persist it.
 * Returns the new merged config.
 */
export function patchNotificationConfig(patch: {
  mode?: NotificationMode;
  channels?: Partial<Partial<ChannelConfigs>>;
  routing?: Partial<RoutingTable>;
}): NotificationConfig {
  const current = loadNotificationConfig();

  if (patch.mode !== undefined) {
    current.mode = patch.mode;
  }

  if (patch.channels) {
    current.channels = deepMerge(
      current.channels,
      patch.channels as Record<string, unknown>
    );
  }

  if (patch.routing) {
    current.routing = deepMerge(
      current.routing,
      patch.routing as Record<string, unknown>
    );
  }

  saveNotificationConfig(current);
  return current;
}

// Re-export the defaults accessor for convenience
export { defaultNotificationConfig };
export { expandHome };
