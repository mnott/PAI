/**
 * local-only-state.ts — the window file and its refusal line, with no config
 * imports: hooks (delegation-gate) read it, and pulling the workers config
 * into a hook makes an import cycle. local-only.ts re-exports all of it.
 */

import { existsSync, readFileSync } from "node:fs";
import { paiHomePath } from "../config/pai-home.js";

/** The window state file. PAI_LOCAL_ONLY_FILE moves it (isolated proofs and tests never touch the real one). */
export const localOnlyPath = (): string => process.env.PAI_LOCAL_ONLY_FILE ?? paiHomePath("state", "local-only.json");

/** The refusal every entry point shows, with the window's own clock. */
export const localOnlyMessage = (label: string): string =>
  `local-only window until ${label} (budget): ask the PAI session to approve a cloud run`;

export interface LocalOnlyState {
  untilMs: number;
  /** The window's clock label: "YYYY-MM-DD HH:MM". */
  label: string;
  by?: string;
}

/** "YYYY-MM-DD HH:MM" in machine-local time. */
export function stampLabel(untilMs: number): string {
  const d = new Date(untilMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The active window, or null when none is set or it has expired. */
export function readLocalOnly(now: number = Date.now()): LocalOnlyState | null {
  const path = localOnlyPath();
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { untilMs?: unknown; by?: unknown };
    const untilMs = typeof j.untilMs === "number" ? j.untilMs : NaN;
    if (!Number.isFinite(untilMs) || untilMs <= now) return null;
    return { untilMs, label: stampLabel(untilMs), ...(typeof j.by === "string" ? { by: j.by } : {}) };
  } catch {
    return null;
  }
}
