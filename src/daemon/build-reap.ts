/** Every 60 s: reap orphaned Xcode compilers that no running gate job owns (see builds/reap.ts). */
import { buildsDir, listBuilds } from "../builds/queue.js";
import { sweepOrphans } from "../builds/reap.js";

export const BUILD_REAP_TICK_MS = 60_000;

export async function runBuildReapSweep(): Promise<number[]> {
  try {
    const running = (await listBuilds(buildsDir())).flatMap((t) => t.paths ?? []);
    return await sweepOrphans(running);
  } catch (e) {
    process.stderr.write(`[pai-daemon] build reap sweep failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return [];
  }
}

export function startBuildReapSweep(): ReturnType<typeof setInterval> {
  const timer = setInterval(() => void runBuildReapSweep(), BUILD_REAP_TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}
