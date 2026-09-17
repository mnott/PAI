/**
 * standalone/proxy.ts — the detached PAI worker proxy entry point.
 *
 * Built to dist/hooks/worker-proxy.mjs by scripts/build-hooks.mjs (bundled,
 * self-contained) and spawned detached by ensureProxyRunning() when a run
 * through an openai-protocol provider finds no proxy listening. Loopback
 * only; providers and their upstreams are read from the workers config per
 * request, so this process never needs restarting on config changes.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { readWorkersSection } from "../config.js";
import { workersLogDir } from "../paths.js";
import {
  DEFAULT_PROXY_PORT,
  createProxyServer,
  listenProxy,
  proxyPidPath,
} from "../proxy/server.js";

const portFlag = process.argv.indexOf("--port");
const port = portFlag > 0 ? parseInt(process.argv[portFlag + 1], 10) || DEFAULT_PROXY_PORT : DEFAULT_PROXY_PORT;

// config problems must not crash a detached process into silence
let logDir = "";
try {
  logDir = workersLogDir(readWorkersSection().workers);
} catch {
  logDir = "";
}

const server = createProxyServer();
listenProxy(server, port)
  .then((bound) => {
    if (logDir) {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(proxyPidPath(logDir), `${process.pid}\n`, "utf8");
    }
    process.stderr.write(`pai worker proxy listening on http://127.0.0.1:${bound}\n`);
  })
  .catch((e) => {
    process.stderr.write(`pai worker proxy: cannot listen on ${port}: ${String(e)}\n`);
    process.exit(1);
  });

process.once("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
