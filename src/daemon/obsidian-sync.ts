/**
 * Obsidian vault sync, owned by the daemon. Hooks only touch a marker file
 * (`.obsidian-dirty` under PAI_HOME); every tick the daemon syncs when the
 * marker is newer than the last sync. Single-flight, deferred by quiet mode,
 * run in a low-priority child so the sync never competes with sessions.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { paiHomePath } from "../config/pai-home.js";
import { buildPassCommand, cliEntry } from "./pass-priority.js";
import { deferIfQuiet } from "./quiet.js";
import { obsidianEnabled } from "../obsidian/enabled.js";

export const obsidianMarkerPath = (): string => paiHomePath(".obsidian-dirty");
const lastSyncPath = (): string => paiHomePath(".obsidian-last-sync");

let inFlight = false;

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** True when a hook signalled a change after the last completed sync. */
export function obsidianSyncDue(): boolean {
  if (!existsSync(obsidianMarkerPath())) return false;
  return mtimeMs(obsidianMarkerPath()) > mtimeMs(lastSyncPath());
}

/** Run `pai obsidian sync --quiet` as a low-priority child. */
export function spawnObsidianSync(): Promise<void> {
  const { cmd, args } = buildPassCommand(process.platform, process.execPath, cliEntry(), ["obsidian", "sync", "--quiet"]);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", env: { ...process.env, PAI_PASS_BACKGROUND: "1" } });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`obsidian sync exited ${code}`))));
  });
}

/**
 * One scheduler tick. Returns true when a sync ran. `run` is injectable for tests.
 * The stamp is written before the run (like the hooks' housekeeping stamp) from
 * a time taken first, so a marker touched mid-sync stays newer and triggers the next one.
 */
export async function runObsidianSyncIfDue(run: () => Promise<void> = spawnObsidianSync): Promise<boolean> {
  if (inFlight || !obsidianEnabled() || !obsidianSyncDue()) return false;
  if (deferIfQuiet("obsidian-sync")) return false;
  inFlight = true;
  try {
    const started = new Date();
    writeFileSync(lastSyncPath(), `${started.toISOString()}\n`);
    utimesSync(lastSyncPath(), started, started);
    await run();
    return true;
  } catch (e) {
    process.stderr.write(`[pai-daemon] obsidian sync failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return true;
  } finally {
    inFlight = false;
  }
}

/** Daemon side: check the marker every `intervalSecs` (default 30 min). */
export function startObsidianSyncScheduler(intervalSecs: number): void {
  process.stderr.write(`[pai-daemon] Obsidian sync: every ${intervalSecs}s when changed\n`);
  const timer = setInterval(() => void runObsidianSyncIfDue(), intervalSecs * 1_000);
  if (timer.unref) timer.unref();
}
