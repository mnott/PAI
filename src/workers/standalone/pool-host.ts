/**
 * standalone/pool-host.ts — the detached worker session pool host.
 *
 * Built to dist/hooks/worker-pool-host.mjs by scripts/build-hooks.mjs
 * (bundled, self-contained) and spawned detached by `pai worker pool on`,
 * same pattern as the openai proxy (standalone/proxy.ts). It owns the pool's
 * long-lived claude slot processes and answers task posts from runWorker on
 * a loopback port; see src/workers/pool-host.ts and pool.ts.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readWorkersSection } from "../config.js";
import { workersLogDir } from "../paths.js";
import { poolHostAlive, poolPidPath, poolSettings } from "../pool.js";
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
  // a build replaces this file: once no slot is busy the host starts its successor on the same argv and exits
  bundlePath: process.argv[1],
  // the listener is already closed when reexec runs: start the successor and report whether it answers /healthz
  reexec: async () => {
    const argv = process.argv.slice(1).filter((a) => a !== "--handover");
    const child = spawn(process.execPath, [...argv, "--handover"], { detached: true, stdio: "ignore", cwd: process.cwd() });
    let exited = false;
    child.once("exit", () => (exited = true));
    child.unref();
    for (let i = 0; i < 60 && !exited; i++) {
      if (await poolHostAlive(port)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!exited) child.kill("SIGTERM");
    return false;
  },
  onReloaded: () => process.exit(0),
  ...(logDir ? { logDir } : {}),
  // the reaper inside createPoolHost is armed from the config; idleSecs here
  // only guards the case where config reading failed (0 would disable it)
  ...(logDir ? {} : { noReaper: idleSecs <= 0 }),
});

// a successor started by a reloading host waits for the old listener to release the port
const handover = process.argv.includes("--handover");
let bindTries = 0;
const listen = (): void => {
  host.server.listen(port, "127.0.0.1", () => {
    if (logDir) {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(poolPidPath(logDir), `${process.pid}\n`, "utf8");
    }
    process.stderr.write(`pai worker pool host listening on http://127.0.0.1:${host.port} (cwd ${host.logDir})\n`);
  });
};
host.server.on("error", (e: NodeJS.ErrnoException) => {
  if (handover && e.code === "EADDRINUSE" && ++bindTries < 40) {
    setTimeout(listen, 250);
    return;
  }
  process.stderr.write(`pai worker pool host: cannot listen on ${port}: ${e.message}\n`);
  process.exit(1);
});
listen();

process.once("SIGTERM", () => {
  void host.shutdown().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
process.once("SIGINT", () => {
  void host.shutdown().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
