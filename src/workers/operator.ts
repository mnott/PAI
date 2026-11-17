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
import { existsSync, unlinkSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadStatus, isLive, setWorkerNote } from "./status.js";

export function operatorSocketPath(logDir: string, id: string): string {
  const p = join(logDir, `${id}.sock`);
  // sockaddr_un.sun_path is 104 bytes on macOS: a long logDir (worker TMPDIR) is hashed into a short tmp path
  return p.length < 100 ? p : join("/tmp", `pai-op-${createHash("sha1").update(p).digest("hex").slice(0, 12)}.sock`);
}

/**
 * The runner's side: listen on the worker socket, hand every received line to
 * `onLine`. It acknowledges with "ok" only when `onLine` returns without a
 * string; a returned string (or a throw) is the failure reason, sent back as
 * `err <reason>` so `say` never reports ok for a message nobody received. Returns the server (close it when the run ends; the socket file is
 * unlinked on close, best effort).
 */
export function createOperatorServer(
  logDir: string,
  id: string,
  onLine: (text: string) => unknown
): import("node:net").Server {
  const path = operatorSocketPath(logDir, id);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // a stale socket from a crashed run must not block the new one
  }
  const server = createServer((socket: Socket) => {
    let buf = "";
    socket.on("error", () => {});
    socket.on("data", async (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        let failure: unknown;
        if (line.trim()) {
          try {
            failure = await onLine(line);
          } catch (e) {
            failure = (e as Error).message;
          }
        }
        if (!socket.destroyed) socket.write(typeof failure === "string" && failure ? `err ${failure.replace(/\n/g, " ")}\n` : "ok\n");
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
 * A run parked at the capacity gate has no live session yet: the message goes
 * into the task copy the start reads (`<id>.prompt`, or the run's own --spec
 * file), so the worker begins with it. The queue ticket is untouched — the run
 * keeps its position. Throws when the run kept no copy of its task.
 */
export function appendToQueuedSpec(logDir: string, id: string, text: string): string {
  const status = loadStatus(logDir, id);
  if (!status) throw new Error(`no worker named "${id}"`);
  const file = [status.promptFile, status.spec].find((f): f is string => !!f && f !== "-" && existsSync(f));
  if (!file) throw new Error(`worker ${id} kept no copy of its task (started from stdin, or before prompt copies) — nothing to append to`);
  const hhmm = new Date().toTimeString().slice(0, 5);
  appendFileSync(file, `\n\n--- added before start (${hhmm}) ---\n${text}\n`, "utf8");
  return `queued: appended to spec (starts with it)`;
}

/**
 * `pai worker say <id> "<text>"`: forward one line to a running worker.
 * Resolves "ok" only once the worker acknowledged delivery; rejects with the reason otherwise.
 * A queued worker (waiting for a slot) gets the text appended to its stored spec instead.
 */
export function sayToWorker(logDir: string, id: string, text: string, timeoutMs = 4000): Promise<string> {
  const status = loadStatus(logDir, id);
  if (!status) {
    return Promise.reject(new Error(`no worker named "${id}"`));
  }
  if (status.state === "queued") {
    try {
      return Promise.resolve(appendToQueuedSpec(logDir, id, text));
    } catch (e) {
      return Promise.reject(e as Error);
    }
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
    if (status.pool) {
      // a pooled task runs in the pool host's slot process: same note path as `pai worker goal`
      setWorkerNote(logDir, id, text);
      return Promise.resolve("queued: delivered at the worker's next turn (pooled task)");
    }
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
    sock.once("data", (d: Buffer) => {
      sock.end();
      const reply = d.toString("utf8").trim();
      if (reply === "ok") resolve("ok");
      else reject(new Error(`worker ${id} did not take the message: ${reply.replace(/^err /, "") || "no acknowledgement"}`));
    });
    sock.once("close", () => fail(new Error("connection closed before the worker acknowledged")));
  });
}
