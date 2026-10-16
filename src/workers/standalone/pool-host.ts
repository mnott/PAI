/**
 * standalone/pool-host.ts — the detached worker session pool host.
 *
 * Built to dist/hooks/worker-pool-host.mjs by scripts/build-hooks.mjs
 * (bundled, self-contained) and spawned detached by `pai worker pool on`,
 * same pattern as the openai proxy (standalone/proxy.ts). It owns the pool's
 * long-lived claude slot processes and answers task posts from runWorker on
 * a loopback port; see src/workers/pool-host.ts and pool.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { readWorkersSection } from "../config.js";
import { workersLogDir } from "../paths.js";
import { poolPidPath, poolSettings } from "../pool.js";
import { createPoolHost } from "../pool-host.js";

const portFlag = process.argv.indexOf("--port");
const fallbackPort = 8798;
const port = portFlag > 0 ? parseInt(process.argv[portFlag + 1], 10) || fallbackPort : fallbackPort;

// config problems must not crash a detached process into silence
let logDir = "";
let idleSecs = 900;
try {
  const { workers } = readWorkersSection();
  logDir = workersLogDir(workers);
  idleSecs = poolSettings(workers).idleSecs;
} catch {
  logDir = "";
}

const host = createPoolHost({
  port,
  ...(logDir ? { logDir } : {}),
  // the reaper inside createPoolHost is armed from the config; idleSecs here
  // only guards the case where config reading failed (0 would disable it)
  ...(logDir ? {} : { noReaper: idleSecs <= 0 }),
});

host.server
  .listen(port, "127.0.0.1", () => {
    if (logDir) {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(poolPidPath(logDir), `${process.pid}\n`, "utf8");
    }
    process.stderr.write(`pai worker pool host listening on http://127.0.0.1:${host.port} (cwd ${host.logDir})\n`);
  })
  .on("error", (e: Error) => {
    process.stderr.write(`pai worker pool host: cannot listen on ${port}: ${e.message}\n`);
    process.exit(1);
  });

process.once("SIGTERM", () => {
  void host.shutdown().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
process.once("SIGINT", () => {
  void host.shutdown().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
