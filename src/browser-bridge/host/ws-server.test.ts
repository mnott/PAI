/**
 * Tests for the hand-rolled bridge WebSocket server and the stdio bridge:
 * a real handshake against the global WebSocket client, a JSON frame echoed
 * back through the bridge, and host.mjs translating native-messaging framed
 * stdin/stdout to and from WebSocket in both directions.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridgeServer, acceptKey, encodeTextFrame, parseFrames } from "./ws-server.mjs";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`connect failed: ${url}`));
  });
}

function nextWsMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no ws message within timeout")), timeoutMs);
    ws.onmessage = (ev: MessageEvent) => {
      clearTimeout(timer);
      resolve(String(ev.data));
    };
  });
}

describe("ws-server frame helpers", () => {
  it("computes the RFC6451 accept key (sha1 + GUID)", () => {
    // The example from RFC 6455 section 1.3.
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("parses masked text frames and carries incomplete tails", () => {
    const payload = Buffer.from('{"command":"list_tabs"}');
    const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    const len = payload.length < 126 ? payload.length : 126;
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | len]), mask, masked]);
    const half = frame.subarray(0, 8);
    const { frames, rest } = parseFrames(Buffer.concat([half, frame.subarray(8), Buffer.from([0x00])]));
    expect(frames).toHaveLength(1);
    expect(frames[0].opcode).toBe(0x1);
    expect(frames[0].payload.toString("utf8")).toBe('{"command":"list_tabs"}');
    expect(rest.equals(Buffer.from([0x00]))).toBe(true);
  });

  it("encodes unmasked server text frames", () => {
    const frame = encodeTextFrame("hi");
    expect(frame.equals(Buffer.from([0x81, 0x02, 0x68, 0x69]))).toBe(true);
  });
});

describe("ws-server live handshake", () => {
  it("handshakes a real WebSocket client and echoes JSON frames through the bridge", async () => {
    const b = await startBridgeServer({
      port: 0,
      onClientMessage: (t) => b.broadcast(t), // echo
    });
    cleanups.push(() => b.close());

    const ws = await connectWs(`ws://127.0.0.1:${b.port}`);
    cleanups.push(() => ws.close());

    ws.send(JSON.stringify({ id: 1, command: "list_tabs" }));
    expect(await nextWsMessage(ws)).toBe(JSON.stringify({ id: 1, command: "list_tabs" }));

    ws.send(JSON.stringify({ id: 2, command: "snapshot", tabId: 3 }));
    expect(await nextWsMessage(ws)).toBe(JSON.stringify({ id: 2, command: "snapshot", tabId: 3 }));
  });

  it("supports two clients; broadcasts reach both", async () => {
    const b = await startBridgeServer({ port: 0, onClientMessage: () => {} });
    cleanups.push(() => b.close());
    const ws1 = await connectWs(`ws://127.0.0.1:${b.port}`);
    const ws2 = await connectWs(`ws://127.0.0.1:${b.port}`);
    cleanups.push(() => ws1.close(), () => ws2.close());

    const m2 = nextWsMessage(ws2);
    b.broadcast("hello-both");
    expect(await m2).toBe("hello-both");
  });
});

describe("host.mjs stdio bridge", () => {
  it("forwards WS frames to framed stdout and framed stdin back to WS clients", async () => {
    const hostUrl = new URL("./host.mjs", import.meta.url);
    const child = spawn(process.execPath, [fileURLToPath(hostUrl)], {
      env: { ...process.env, PAI_BROWSER_BRIDGE_PORT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => {
      child.kill();
    });

    // The host logs its bound port to stderr.
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("host never logged its port")), 5000);
      child.stderr.on("data", (d: Buffer) => {
        const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(d.toString("utf8"));
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
    });

    const ws = await connectWs(`ws://127.0.0.1:${port}`);
    cleanups.push(() => ws.close());

    // Read framed JSON from the host's stdout (native messaging: 4-byte LE length).
    const readFrame = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no framed stdout within timeout")), 5000);
        let buf = Buffer.alloc(0);
        const onData = (d: Buffer) => {
          buf = Buffer.concat([buf, d]);
          if (buf.length < 4) return;
          const len = buf.readUInt32LE(0);
          if (buf.length < 4 + len) return;
          child.stdout.off("data", onData);
          clearTimeout(timer);
          resolve(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")));
        };
        child.stdout.on("data", onData);
      });

    // WS client → host → framed stdout
    const stdoutFrame = readFrame();
    ws.send(JSON.stringify({ id: 42, command: "list_tabs" }));
    expect(await stdoutFrame).toEqual({ id: 42, command: "list_tabs" });

    // Framed stdin → host → WS client (this is how Chrome's replies travel).
    const reply = nextWsMessage(ws);
    const payload = Buffer.from(JSON.stringify({ id: 42, ok: true, result: [] }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    child.stdin.write(Buffer.concat([header, payload]));
    expect(JSON.parse(await reply)).toEqual({ id: 42, ok: true, result: [] });
  }, 15000);
});
