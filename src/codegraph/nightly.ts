/** Nightly code verify: every active project that already has a graph gets a background incremental index (one at a time via the lock; the rest catch up on later nights or queries). */

import { existsSync } from "node:fs";
import { getStorageBackend } from "../storage/factory.js";
import { incrementalIndexIfIndexed } from "./session.js";

const DAY_MS = 24 * 3600_000;
let lastRun = 0;

export async function runCodeGraphNightly(listRoots: () => Promise<string[]>): Promise<void> {
  if (Date.now() - lastRun < DAY_MS - 3600_000) return;
  lastRun = Date.now();
  try {
    const backend = await getStorageBackend();
    for (const root of await listRoots()) {
      if (!existsSync(root)) continue;
      const r = await incrementalIndexIfIndexed(backend, root);
      if (r === "started") break; // one index at a time per machine
    }
  } catch (e) {
    process.stderr.write(`[pai-daemon] code graph nightly failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
