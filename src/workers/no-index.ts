import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

/**
 * Keep Spotlight (mds_stores) out of the worktree root: dozens of checkouts
 * churn constantly and indexing them burns CPU. macOS only, idempotent,
 * errors ignored.
 */
export function ensureNoSpotlightIndex(root: string, os: string = process.platform): boolean {
  if (os !== "darwin") return false;
  try {
    const marker = join(root, ".metadata_never_index");
    if (existsSync(marker)) return false;
    mkdirSync(root, { recursive: true });
    closeSync(openSync(marker, "a"));
    return true;
  } catch {
    return false;
  }
}
