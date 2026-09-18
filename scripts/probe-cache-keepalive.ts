/**
 * probe-cache-keepalive.ts — measurement + proof instrument for the worker
 * prompt-cache keepalive (docs/cache-keepalive.md).
 *
 * Spawns trivial single-turn workers through the real runWorker path and
 * prints one JSON line per spawn with the final result event's usage — on
 * this endpoint that IS first-turn usage, and duration_api_ms is the TTFT
 * proxy (per-turn assistant usage is zeroed).
 *
 *   bun run scripts/probe-cache-keepalive.ts --pairs back-to-back
 *   bun run scripts/probe-cache-keepalive.ts --gap-secs 360
 *   bun run scripts/probe-cache-keepalive.ts --beat   # one manual heartbeat
 *
 * Reads the live workers config; writes nothing anywhere but the usual
 * worker artefacts in workers.logDir.
 */

import { runWorker } from "../src/workers/run.js";
import { readWorkersSection } from "../src/workers/config.js";
import {
  HEARTBEAT_PROMPT,
  beatId,
  parseLastResultEvent,
  extractBeatMetrics,
  runKeepaliveBeat,
} from "../src/workers/keepalive.js";
import { eventsPath, workersLogDir } from "../src/workers/paths.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function probeOnce(n: number): Promise<void> {
  const { workers: config } = readWorkersSection();
  const logDir = workersLogDir(config);
  const id = `probe-${beatId()}-${n}`;
  const rc = await runWorker({
    claudeArgs: ["-p", HEARTBEAT_PROMPT],
    className: "simple",
    label: "cache-probe",
    noPane: true,
    quiet: true,
    worktreeFlag: false,
    id,
  });
  const metrics = extractBeatMetrics(
    { id, ok: rc === 0, rc, provider: null, model: null },
    parseLastResultEvent(eventsPath(logDir, id))
  );
  console.log(JSON.stringify(metrics));
}

async function main(): Promise<void> {
  if (process.argv.includes("--beat")) {
    const m = await runKeepaliveBeat();
    console.log(JSON.stringify(m));
    return;
  }
  const gap = arg("--gap-secs");
  if (gap !== undefined) {
    const secs = Number(gap);
    if (!Number.isInteger(secs) || secs < 0) throw new Error(`--gap-secs must be a non-negative integer`);
    await probeOnce(1);
    if (secs > 0) {
      process.stderr.write(`probe: waiting ${secs}s …\n`);
      await new Promise((r) => setTimeout(r, secs * 1000));
    }
    await probeOnce(2);
    return;
  }
  const pairs = arg("--pairs");
  if (pairs === "back-to-back") {
    await probeOnce(1);
    await probeOnce(2);
    return;
  }
  console.error(
    "usage: probe-cache-keepalive.ts --pairs back-to-back | --gap-secs <secs> | --beat"
  );
  process.exit(2);
}

main().catch((e) => {
  console.error(`probe failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
