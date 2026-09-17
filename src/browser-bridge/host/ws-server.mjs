/**
 * Minimal hand-rolled RFC6455 WebSocket server for the browser bridge.
 *
 * Node's global WebSocket is client-only and `ws` is not a dependency, so the
 * server side is implemented here: HTTP Upgrade handshake with
 * Sec-WebSocket-Accept (sha1 via node:crypto), masked client text frames in,
 * unmasked server text frames out. Text/JSON frames only. Multiple clients
 * are accepted; the stdio bridge in host.mjs fans messages both ways.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:net";

export const PAI_BROWSER_BRIDGE_PORT = Number(process.env.PAI_BROWSER_BRIDGE_PORT || 8756);

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Computes the Sec-WebSocket-Accept value for a handshake key. */
export function acceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** Encodes one unmasked server text frame. */
export function encodeTextFrame(text) {
  const payload = Buffer.from(String(text), "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Parses complete frames out of a chunk stream. Returns
 * {frames: [{opcode, payload}], rest} — `rest` carries unparsed bytes.
 */
export function parseFrames(buffer) {
  const frames = [];
  let buf = buffer;
  while (true) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) break;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) break;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame too large");
      len = Number(big);
      offset += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) break;
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      const unmasked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
      payload = unmasked;
    }
    frames.push({ opcode, payload });
    buf = buf.subarray(offset + maskLen + len);
  }
  return { frames, rest: buf };
}

/**
 * Starts the bridge WebSocket server.
 *
 * @param {object} opts
 * @param {number} [opts.port=PAI_BROWSER_BRIDGE_PORT] 0 picks an ephemeral port
 * @param {(text: string) => void} opts.onClientMessage text frame from any client
 * @param {(connected: boolean, count: number) => void} [opts.onClientState] client connected/closed (optional)
 * @returns {Promise<{server: import("node:net").Server, port: number, broadcast: (text: string) => void, close: () => Promise<void>}>}
 */
export function startBridgeServer({ port = PAI_BROWSER_BRIDGE_PORT, onClientMessage, onClientState }) {
  const sockets = new Set();

  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;

    const fail = () => socket.destroy();

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) {
          if (buffer.length > 16384) fail();
          return;
        }
        const head = buffer.subarray(0, end).toString("utf8");
        const key = /sec-websocket-key:\s*(.+)/i.exec(head)?.[1]?.trim();
        if (!/^GET\s+\S+\s+HTTP\/1\.1$/im.test(head) || !key) {
          socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
            "\r\n"
        );
        buffer = buffer.subarray(end + 4);
        handshakeDone = true;
        sockets.add(socket);
        onClientState?.(true, sockets.size);
        // fall through: the first frame may have arrived in the same packet
      }
      let frames;
      try {
        ({ frames, rest: buffer } = parseFrames(buffer));
      } catch {
        fail();
        return;
      }
      for (const f of frames) {
        if (f.opcode === 0x1) onClientMessage?.(f.payload.toString("utf8"));
        else if (f.opcode === 0x8) {
          socket.write(Buffer.from([0x88, 0x00])); // echo close
          sockets.delete(socket);
          socket.end();
          onClientState?.(false, sockets.size);
        } else if (f.opcode === 0x9) {
          // ping → pong (0x8A) with the same payload
          socket.write(Buffer.concat([Buffer.from([0x8a, f.payload.length]), f.payload]));
        } // pong (0xA) and continuation frames ignored — text/JSON only
      }
    });

    socket.on("error", () => {});
    socket.on("close", () => {
      if (sockets.delete(socket)) onClientState?.(false, sockets.size);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        broadcast(text) {
          const frame = encodeTextFrame(text);
          for (const s of sockets) s.write(frame);
        },
        close() {
          return new Promise((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          });
        },
      });
    });
  });
}
