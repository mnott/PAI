/**
 * Hidden `pai memory pass <index|embed|noop>`: the child entry the daemon
 * spawns at low priority (see daemon/pass-priority.ts). Reuses the daemon's
 * pass functions and reports one JSON line on stdout.
 */

import { embedChunksWithBackend } from "../../../memory/indexer-backend.js";
import { getStorageBackend, getRegistryBackend } from "../../../storage/factory.js";
import { EMBED_PASS_BATCH_SIZE, DEFAULT_EMBED_MAX_LOAD, DEFAULT_EMBED_MAX_MINUTES, liveYieldCheck } from "../../../memory/embed-pass.js";
import { indexTick, jobProgressFromEnv } from "../../../memory/job-progress.js";
import { rmSync } from "node:fs";
import { acquireRun, inFlightPass, readRun, runStateFile, type RunHandle, type RunKind, type RunOutcome } from "../../../memory/run-state.js";
import { reexecBackground, type PassName } from "../../../daemon/pass-priority.js";

async function runPass(name: PassName, sleepMs: number, embed: EmbedPassArgs): Promise<unknown> {
  if (name === "noop") {
    await new Promise((r) => setTimeout(r, sleepMs));
    return { pid: process.pid };
  }
  const kind = name as RunKind;
  // a marker bearing OUR pid is never another pass: the daemon's in-process pass
  // holds it under the daemon's pid, and `reexecBackground` re-execs this very
  // command — forking keeps the pid. Only the daemon's own in-flight word says a
  // pass of this kind runs here (2026-11-20: the nightly chain spawned its child
  // while the daemon's index pass held the marker under that same pid, and the
  // child refused the daemon's own marker).
  const held = readRun();
  if (held && !(held.pid === process.pid && !inFlightPass(held.kind))) {
    throw new Error(`${held.kind} already running (started by ${held.by}, pid ${held.pid})`);
  }
  if (held) {
    // a same-pid marker with no pass in flight here is stale (an earlier pass of
    // this pid died without releasing): drop it, and take our own below.
    rmSync(runStateFile(), { force: true });
  }
  const run = acquireRun(kind, { by: "daemon" });
  if (!run) throw new Error("another memory run just started");
  let result: { outcome: RunOutcome; reason?: string } = { outcome: "failed", reason: "pass threw" };
  try {
    const r = await runMemoryPass(name, embed, run);
    const o = (r as { outcome?: string } | null)?.outcome;
    result = o === "budget" || o === "yielded" || o === "failed" ? { outcome: o, reason: (r as { reason?: string }).reason } : { outcome: "done" };
    return r;
  } finally {
    run.release(result);
  }
}

async function runMemoryPass(name: PassName, embed: EmbedPassArgs, run: RunHandle): Promise<unknown> {
  const storage = await getStorageBackend();
  const registry = await getRegistryBackend();
  if (name === "index") {
    const pw = jobProgressFromEnv("index");
    try { return await storage.indexAll(registry, pw ? indexTick(pw) : undefined); } finally { pw?.finish(); }
  }
  const backlog = await storage.countUnembeddedChunks().catch(() => 0);
  run.setBacklog(backlog);
  const pw = jobProgressFromEnv("embed");
  pw?.update({ phase: "embed", unit: "chunks", done: 0, total: backlog });
  const projectNames = new Map<number, string>();
  try {
    for (const r of await registry.listProjects({ status: "active" })) projectNames.set(r.id, r.slug);
  } catch { /* registry unavailable — IDs will be used instead */ }
  let end: { outcome: string; reason?: string } = { outcome: "done" };
  const count = await embedChunksWithBackend(storage, () => false, projectNames, {
    maxMillis: embed.maxMinutes * 60_000,
    batchSize: EMBED_PASS_BATCH_SIZE,
    shouldYield: liveYieldCheck(embed.maxLoad),
    onProgress: (n) => { run.progress(n); pw?.update({ done: n }); },
    onEnd: (r) => { end = r; },
  });
  pw?.finish();
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
