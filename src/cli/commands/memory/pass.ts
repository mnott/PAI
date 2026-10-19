/**
 * Hidden `pai memory pass <index|embed|noop>`: the child entry the daemon
 * spawns at low priority (see daemon/pass-priority.ts). Reuses the daemon's
 * pass functions and reports one JSON line on stdout.
 */

import { embedChunksWithBackend } from "../../../memory/indexer-backend.js";
import { getStorageBackend, getRegistryBackend } from "../../../storage/factory.js";
import { EMBED_PASS_BATCH_SIZE, DEFAULT_EMBED_MAX_LOAD, DEFAULT_EMBED_MAX_MINUTES, liveYieldCheck } from "../../../memory/embed-pass.js";
import { reexecBackground, type PassName } from "../../../daemon/pass-priority.js";

async function runPass(name: PassName, sleepMs: number, embed: EmbedPassArgs): Promise<unknown> {
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
  let end: { outcome: string; reason?: string } = { outcome: "done" };
  const count = await embedChunksWithBackend(storage, () => false, projectNames, {
    maxMillis: embed.maxMinutes * 60_000,
    batchSize: EMBED_PASS_BATCH_SIZE,
    shouldYield: liveYieldCheck(embed.maxLoad),
    onEnd: (r) => { end = r; },
  });
  return { count, ...end };
}

export interface EmbedPassArgs {
  maxMinutes: number;
  maxLoad: number;
}

export async function memoryPassCmd(name: string, opts: { sleep?: string | number; maxMinutes?: number; maxLoad?: number }): Promise<number> {
  reexecBackground();
  try {
    const sleepValue = opts.sleep ?? 0;
    const sleepMs = typeof sleepValue === 'string' ? parseInt(sleepValue, 10) : sleepValue;
    const result = await runPass(name as PassName, sleepMs, {
      maxMinutes: Number(opts.maxMinutes) || DEFAULT_EMBED_MAX_MINUTES,
      maxLoad: Number(opts.maxLoad) || DEFAULT_EMBED_MAX_LOAD,
    });
    process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
    return 0;
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + "\n",
    );
    return 1;
  }
}
