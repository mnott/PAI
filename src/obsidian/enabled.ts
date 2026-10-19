/** Switch for the Obsidian integration that WRITES into the PAI-generated vault (sync, master notes, symlinks): `obsidian: { enabled: true }` in config.yaml (default off). Reading/indexing `vaultPath` is separate: `vaultIndex.enabled`. */

import { readMainConfigRaw } from "../daemon/config.js";

export const OBSIDIAN_DISABLED_MESSAGE =
  "Obsidian sync is disabled. Enable it with: pai config set obsidian.enabled true";

/** Read fresh from config; an unreadable config reads as disabled. */
export function obsidianEnabled(): boolean {
  try {
    const o = readMainConfigRaw()["obsidian"];
    return !!o && typeof o === "object" && (o as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

/** Vault indexing (read-only, `vaultPath`) is on unless `vaultIndex: { enabled: false }`; independent of `obsidian.enabled`. */
export function vaultIndexEnabled(): boolean {
  try {
    const v = readMainConfigRaw()["vaultIndex"];
    return !(v && typeof v === "object" && (v as { enabled?: unknown }).enabled === false);
  } catch {
    return true;
  }
}
