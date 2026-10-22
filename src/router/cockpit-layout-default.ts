/**
 * cockpit-layout-default.ts — the cockpit's default window layout.
 *
 * The page keeps each device's layout in localStorage (pai.cockpit.win.v2). A device with none of its
 * own starts from the default, which is, in order: the state file the "save as default" button writes
 * (PAI_HOME/cockpit-layout-default.json), the layout shipped with the package
 * (src/config/defaults/cockpit-layout.json), then the layout the page composes itself. The shipped file
 * is only ever written by `pai cockpit layout export`, never automatically.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paiHomePath } from "../config/pai-home.js";
import { shippedDefaultsDir } from "../config/shipped-defaults.js";

/** The page's layout object (win/store.ts): version, tree and, per group, its kids and card states. */
export type StoredLayout = { v: number; tree: object; kids?: object; st?: object; auto?: number; t?: number };

export const SHIPPED_LAYOUT_NAME = "cockpit-layout.json";

export const stateLayoutFile = (): string => paiHomePath("cockpit-layout-default.json");

export function shippedLayoutFile(): string | null {
  try {
    return join(shippedDefaultsDir(), SHIPPED_LAYOUT_NAME);
  } catch {
    return null;
  }
}

/** The package's own source file the export writes (only exists in a checkout). */
export function repoLayoutFile(here: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let root = here;
  while (!existsSync(join(root, "package.json")) && dirname(root) !== root) root = dirname(root);
  const dir = join(root, "src", "config", "defaults");
  return existsSync(dir) ? join(dir, SHIPPED_LAYOUT_NAME) : null;
}

export function parseLayout(raw: string): StoredLayout | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const l = o as StoredLayout;
  return typeof l.v === "number" && l.tree && typeof l.tree === "object" ? l : null;
}

function readLayout(file: string | null): StoredLayout | null {
  if (!file || !existsSync(file)) return null;
  try {
    return parseLayout(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The default a fresh device starts from; null = the page's built-in layout. */
export function readDefaultLayout(stateFile: string = stateLayoutFile(), shippedFile: string | null = shippedLayoutFile()): StoredLayout | null {
  return readLayout(stateFile) ?? readLayout(shippedFile);
}

/** Write the posted layout as this install's default; false when it is not a layout. */
export function saveDefaultLayout(raw: string, stateFile: string = stateLayoutFile()): boolean {
  const l = parseLayout(raw);
  if (!l) return false;
  mkdirSync(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(l, null, 1) + "\n");
  renameSync(tmp, stateFile);
  return true;
}

/** Copy the saved default to the shipped file. Throws with the reason when there is nothing to export or nowhere to put it. */
export function exportDefaultLayout(opts: { stateFile?: string; to?: string | null } = {}): string {
  const from = opts.stateFile ?? stateLayoutFile();
  const l = readLayout(from);
  if (!l) throw new Error(`no saved default layout at ${from} (use "save as default" in the cockpit first)`);
  const to = opts.to ?? repoLayoutFile();
  if (!to) throw new Error("not a source checkout: pass --to FILE");
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, JSON.stringify(l, null, 1) + "\n");
  return to;
}
