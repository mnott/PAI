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
import { createBindHandler, installExitLogging, logHostExit, openHostLog } from "../pool-host-run.js";

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

// a death leaves a trace: stderr/stdout land in host.log (the spawner points them there) and a crash writes POOL-HOST-EXIT
installExitLogging({
  logDir,
  pid: process.pid,
  on: (ev, cb) => process.on(ev, cb),
  exit: (code) => process.exit(code),
  write: (line) => process.stderr.write(line),
});
process.on("exit", (code) => logHostExit(logDir, process.pid, `exit code ${code}`));

const host = createPoolHost({
  port,
  // a build replaces this file: once no slot is busy the host starts its successor on the same argv and exits
  bundlePath: process.argv[1],
  // the listener is already closed when reexec runs: start the successor and report whether it answers /healthz
  reexec: async () => {
    const argv = process.argv.slice(1).filter((a) => a !== "--handover");
    const fd = logDir ? openHostLog(logDir) : null;
    const child = spawn(process.execPath, [...argv, "--handover"], { detached: true, stdio: fd === null ? "ignore" : ["ignore", fd, fd], cwd: process.cwd() });
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

// every start (pai worker pool on, pai reload, self-reload) tolerates a port still held by its predecessor;
// when a healthy host owns it the newcomer steps aside, so there is exactly one owner
const listen = (): void => {
  host.server.listen(port, "127.0.0.1", () => {
    host.listening();
    if (logDir) {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(poolPidPath(logDir), `${process.pid}\n`, "utf8");
    }
    process.stderr.write(`pai worker pool host listening on http://127.0.0.1:${host.port} (cwd ${host.logDir})\n`);
  });
};
host.server.on(
  "error",
  createBindHandler({
    listen,
    alive: () => poolHostAlive(port),
    retry: (fn, ms) => setTimeout(fn, ms),
    fail: (code, reason) => {
      process.stderr.write(`pai worker pool host: ${reason}\n`);
      logHostExit(logDir, process.pid, reason);
      process.exit(code);
    },
  })
);
listen();

process.once("SIGTERM", () => {
  void host.shutdown().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
process.once("SIGINT", () => {
  void host.shutdown().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
