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

import { expandHome, readMainConfigRaw, writeMainConfigRaw } from "../daemon/config.js";
import type {
  NotificationConfig,
  ChannelConfigs,
  RoutingTable,
  NotificationMode,
} from "./types.js";
import {
  DEFAULT_NOTIFICATION_CONFIG,
  DEFAULT_CHANNELS,
  DEFAULT_ROUTING,
} from "./types.js";

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
    return { ...DEFAULT_NOTIFICATION_CONFIG };
  }

  const stored = parsed["notifications"];
  if (!stored || typeof stored !== "object") {
    return { ...DEFAULT_NOTIFICATION_CONFIG };
  }

  return deepMerge(
    DEFAULT_NOTIFICATION_CONFIG,
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
  let full: Record<string, unknown> = {};
  try {
    full = readMainConfigRaw();
  } catch {
    // Start fresh if the file is unreadable
  }

  // Replace the notifications section
  full["notifications"] = config;

  writeMainConfigRaw(full);
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

// Re-export defaults for convenience
export { DEFAULT_NOTIFICATION_CONFIG, DEFAULT_CHANNELS, DEFAULT_ROUTING };
export { expandHome };
