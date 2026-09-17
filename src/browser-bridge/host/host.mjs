#!/usr/bin/env node
/**
 * PAI browser bridge — native messaging host.
 *
 * Chrome spawns this via the NativeMessagingHosts manifest (see install.mjs).
 * It bridges the extension's native messaging port (4-byte little-endian
 * length-prefixed JSON on stdin/stdout) to a localhost WebSocket server that
 * the pai-browser MCP server connects to.
 *
 *   extension <-> [stdio, framed JSON] <-> host.mjs <-> [ws://127.0.0.1:8756] <-> MCP
 *
 * stdout is the protocol channel. Logs append to /tmp/pai-browser-bridge.log
 * (override with PAI_BROWSER_BRIDGE_LOG) — stderr stays clean, because without
 * DevTools on the service worker the log file is the only way to see what the
 * bridge did. The host also pings the extension every 20s so the MV3 service
 * worker's idle timer resets and neither side of the bridge dies while the
 * other still needs it.
 */

import { appendFileSync } from "node:fs";
import { startBridgeServer, PAI_BROWSER_BRIDGE_PORT } from "./ws-server.mjs";

const LOG_PATH = process.env.PAI_BROWSER_BRIDGE_LOG || "/tmp/pai-browser-bridge.log";

/**
 * Timestamped file log. appendFileSync keeps lines ordered without a stream to
 * manage; the volume here is a few lines per lifecycle event, not per frame.
 * stderr is the fallback of last resort (only if the log file is unwritable).
 */
function log(msg) {
  const line = `[pai-browser-bridge] ${new Date().toISOString()} ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    process.stderr.write(line);
  }
}

// --- native messaging framing (Chrome <-> host) ----------------------------

const MAX_FRAME = 64 * 1024 * 1024;
// Chrome drops the port on oversized native-messaging messages. The exact
// limits are version-dependent and direction-dependent; this threshold only
// flags frames that plausibly exceed them, so a mystery disconnect leaves a
// trace in the log instead of nothing.
const SIZE_WARN_BYTES = 512 * 1024;
let stdinBuf = Buffer.alloc(0);

/** Frames one JSON message for Chrome. */
function frame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function writeStdout(message) {
  const framed = frame(message);
  if (framed.length > SIZE_WARN_BYTES) {
    log(`outbound frame is ${framed.length} bytes — Chrome may drop the port if it exceeds the native-messaging limit`);
  }
  process.stdout.write(framed);
}

process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0);
    if (len > MAX_FRAME) {
      log(`frame too large (${len} bytes) — dropping connection`);
      process.exit(1);
    }
    if (stdinBuf.length < 4 + len) break;
    const payload = stdinBuf.subarray(4, 4 + len).toString("utf8");
    stdinBuf = stdinBuf.subarray(4 + len);
    try {
      const msg = JSON.parse(payload);
      if (payload.length > SIZE_WARN_BYTES) {
        log(`inbound extension frame is ${payload.length} bytes — Chrome may refuse frames this large`);
      }
      bridge?.broadcast(payload); // extension → all WS clients, verbatim
      if (msg?.type === "hello") writeStdout({ type: "hello", host: "pai-browser-bridge" });
      else if (msg?.type !== "ping") log(`ext→ws id=${msg?.id} ok=${msg?.ok} (${payload.length} bytes)`);
    } catch (e) {
      log(`unparseable frame: ${e}`);
    }
  }
});

process.stdin.on("end", () => {
  log("extension closed the port — exiting");
  process.exit(0);
});

process.stdin.on("error", (e) => log(`stdin error: ${e}`));
process.stdout.on("error", (e) => log(`stdout error: ${e}`));

// --- WebSocket side ----------------------------------------------------------

let bridge = null;

startBridgeServer({
  port: PAI_BROWSER_BRIDGE_PORT,
  onClientMessage: (text) => {
    // WS client (MCP server) → extension, verbatim JSON over the native port.
    try {
      const msg = JSON.parse(text); // parse first — never forward garbage to Chrome
      writeStdout(msg);
      if (msg?.type !== "ping") log(`ws→ext ${msg?.cmd ?? msg?.command ?? "?"} id=${msg?.id ?? "?"}`);
    } catch (e) {
      log(`dropping non-JSON frame from WS client: ${e}`);
    }
  },
  onClientState: (connected, count) => {
    log(`ws client ${connected ? "connected" : "closed"} (${count} open)`);
  },
})
  .then((b) => {
    bridge = b;
    log(`host up pid=${process.pid} log=${LOG_PATH}`);
    log(`listening on ws://127.0.0.1:${b.port}`);
  })
  .catch((e) => {
    log(`failed to start ws server: ${e}`);
    process.exit(1);
  });

// --- keepalive ----------------------------------------------------------------

// Messages arriving over the port reset the MV3 idle timer; a silent bridge
// dies after ~30s of nobody touching Chrome.
setInterval(() => {
  try {
    writeStdout({ type: "ping" });
  } catch (e) {
    log(`ping failed: ${e}`);
  }
}, 20_000);
