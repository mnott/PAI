/**
 * Hidden `pai memory pass <index|embed|noop>`: the child entry the daemon
 * spawns at low priority (see daemon/pass-priority.ts). Reuses the daemon's
 * pass functions and reports one JSON line on stdout.
 */

import { embedChunksWithBackend } from "../../../memory/indexer-backend.js";
import { getStorageBackend, getRegistryBackend } from "../../../storage/factory.js";
import { reexecBackground, type PassName } from "../../../daemon/pass-priority.js";

/** Budget for one embed pass; mirrors the daemon's in-process budget. */
const EMBED_MAX_MILLIS = 240_000;

async function runPass(name: PassName, sleepMs: number): Promise<unknown> {
  if (name === "noop") {
    await new Promise((r) => setTimeout(r, sleepMs));
    return { pid: process.pid };
  }
  const storage = await getStorageBackend();
  const registry = await getRegistryBackend();
  if (name === "index") return await storage.indexAll(registry);
  const projectNames = new Map<number, string>();
  try {
    for (const r of await registry.listProjects({ status: "active" })) projectNames.set(r.id, r.slug);
  } catch { /* registry unavailable — IDs will be used instead */ }
  const count = await embedChunksWithBackend(storage, () => false, projectNames, {
    maxMillis: EMBED_MAX_MILLIS,
  });
  return { count };
}

export async function memoryPassCmd(name: string, opts: { sleep?: string | number }): Promise<number> {
  reexecBackground();
  try {
    const sleepValue = opts.sleep ?? 0;
    const sleepMs = typeof sleepValue === 'string' ? parseInt(sleepValue, 10) : sleepValue;
    const result = await runPass(name as PassName, sleepMs);
    process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
    return 0;
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + "\n",
    );
    return 1;
  }
}
