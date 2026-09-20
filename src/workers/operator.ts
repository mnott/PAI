/**
 * operator.ts — talking to a running worker.
 *
 * Headless workers run with `--input-format stream-json` and their stdin held
 * open, so a run is a conversation: every line sent to the per-worker Unix
 * socket `<logDir>/<id>.sock` is forwarded to the child as a user message and
 * mirrored into the transcript as an `operator` event (rendered with a »
 * marker). Once the worker has finished its turn, stdin closes 2 s later
 * unless a new message arrives — after that, `say` refuses and `resume`
 * continues the same Claude session with the worker's context intact.
 */

import { createServer, connect, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadStatus, isLive } from "./status.js";

export function operatorSocketPath(logDir: string, id: string): string {
  return join(logDir, `${id}.sock`);
}

/**
 * The runner's side: listen on the worker socket, hand every received line to
 * `onLine`. Returns the server (close it when the run ends; the socket file is
 * unlinked on close, best effort).
 */
export function createOperatorServer(
  logDir: string,
  id: string,
  onLine: (text: string) => void
): import("node:net").Server {
  const path = operatorSocketPath(logDir, id);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // a stale socket from a crashed run must not block the new one
  }
  const server = createServer((socket: Socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
        socket.write("ok\n");
      }
    });
  });
  server.listen(path);
  server.on("close", () => {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // already gone
    }
  });
  return server;
}

/**
 * `pai worker say <id> "<text>"`: forward one line to a running worker.
 * Resolves "ok", rejects with a clear message when the worker is not running.
 */
export function sayToWorker(logDir: string, id: string, text: string, timeoutMs = 4000): Promise<string> {
  const status = loadStatus(logDir, id);
  if (!status) {
    return Promise.reject(new Error(`no worker named "${id}"`));
  }
  if (!isLive(status)) {
    return Promise.reject(
      new Error(
        `worker ${id} is not running (state: ${status.state}) — ` +
          `continue it instead with: pai worker resume ${id} "<text>"`
      )
    );
  }
  const path = operatorSocketPath(logDir, id);
  if (!existsSync(path)) {
    return Promise.reject(
      new Error(`worker ${id} has no operator socket (${path}) — it may predate this PAI version`)
    );
  }
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const fail = (e: Error) => {
      sock.destroy();
      reject(new Error(`cannot talk to worker ${id}: ${e.message}`));
    };
    sock.setTimeout(timeoutMs, () => fail(new Error("timeout")));
    sock.once("error", (e: Error) => fail(e));
    sock.once("connect", () => {
      sock.write(text.replace(/\n/g, " ") + "\n");
    });
    sock.once("data", () => {
      sock.end();
      resolve("ok");
    });
  });
}
