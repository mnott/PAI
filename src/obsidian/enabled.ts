/** The one switch for everything Obsidian: `obsidian: { enabled: true }` in config.yaml (default off). */

import { readMainConfigRaw } from "../daemon/config.js";

export const OBSIDIAN_DISABLED_MESSAGE =
  "Obsidian integration is disabled. Enable it with: pai config set obsidian.enabled true";

/** Read fresh from config; an unreadable config reads as disabled. */
export function obsidianEnabled(): boolean {
  try {
    const o = readMainConfigRaw()["obsidian"];
    return !!o && typeof o === "object" && (o as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}
