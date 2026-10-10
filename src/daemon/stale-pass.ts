/**
 * Daily maintenance step: for every registered project whose
 * `.pai/project.yaml` has status.sink forge, write the stale-issue list into
 * the handover issue's <!-- pai:stale --> section. Best-effort: logs, never
 * throws, never closes or comments.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_CONFIG_REL, formatStale, listStale, loadStatusConfig, writeSectionToForge, type StaleDeps } from "../session/forge-sink.js";

const DAY_MS = 24 * 3600_000;
let lastRun = 0;

export function runStalePass(roots: string[], deps: StaleDeps = {}, log: (m: string) => void = (m) => process.stderr.write(`${m}\n`)): number {
  let written = 0;
  for (const root of roots) {
    try {
      if (!existsSync(join(root, PROJECT_CONFIG_REL))) continue;
      const cfg = loadStatusConfig(root);
      if (cfg.sink !== "forge") continue;
      const md = formatStale(listStale(root, cfg, 7, deps));
      const w = writeSectionToForge(root, cfg, md, "stale", deps);
      written++;
      log(`[pai-daemon] stale pass: ${root} -> handover #${w.issue}${deps.dryRun ? " (dry run)" : ""}`);
    } catch (e) {
      log(`[pai-daemon] stale pass: ${root} skipped (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return written;
}

/** Scheduler entry: at most once per day, resolves the active project roots itself. */
export async function runStalePassDaily(listRoots: () => Promise<string[]>): Promise<void> {
  if (Date.now() - lastRun < DAY_MS - 3600_000) return;
  lastRun = Date.now();
  try { runStalePass(await listRoots()); }
  catch (e) { process.stderr.write(`[pai-daemon] stale pass failed: ${e instanceof Error ? e.message : String(e)}\n`); }
}
