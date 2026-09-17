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
 * stdout is the protocol channel — logs go to stderr ONLY. The host also pings
 * the extension every 20s so the MV3 service worker's idle timer resets and
 * neither side of the bridge dies while the other still needs it.
 */

import { startBridgeServer, PAI_BROWSER_BRIDGE_PORT } from "./ws-server.mjs";

// --- native messaging framing (Chrome <-> host) ----------------------------

const MAX_FRAME = 64 * 1024 * 1024;
let stdinBuf = Buffer.alloc(0);

/** Frames one JSON message for Chrome. */
function frame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function writeStdout(message) {
  process.stdout.write(frame(message));
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
      bridge?.broadcast(payload); // extension → all WS clients, verbatim
      if (msg?.type === "hello") writeStdout({ type: "hello", host: "pai-browser-bridge" });
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

function log(msg) {
  process.stderr.write(`[pai-browser-bridge] ${new Date().toISOString()} ${msg}\n`);
}

// --- WebSocket side ----------------------------------------------------------

let bridge = null;

startBridgeServer({
  port: PAI_BROWSER_BRIDGE_PORT,
  onClientMessage: (text) => {
    // WS client (MCP server) → extension, verbatim JSON over the native port.
    try {
      writeStdout(JSON.parse(text)); // parse first — never forward garbage to Chrome
    } catch (e) {
      log(`dropping non-JSON frame from WS client: ${e}`);
    }
  },
  onClientState: () => {
    log("ws client connected or closed");
  },
})
  .then((b) => {
    bridge = b;
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
