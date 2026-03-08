/**
 * PaiDaemonClient — NDJSON client over a Unix domain socket.
 *
 * Protocol:
 *   - Each request is one JSON line:  { id, method, params }
 *   - Each response is one JSON line: { id, ok, result } | { id, ok, error }
 *   - The daemon closes the connection after each response (request-response model).
 *
 * Usage:
 *   const client = new PaiDaemonClient("/tmp/pai.sock");
 *   const data = await client.call<GraphClustersResult>("graph_clusters", { max_clusters: 20 });
 */

import { createConnection } from "net";
import type { RpcResponse } from "./types";

export class PaiDaemonClient {
  private socketPath: string;
  private requestId = 0;
  /** Timeout in milliseconds for a single RPC call (default: 10 s) */
  private callTimeout: number;

  constructor(socketPath = "/tmp/pai.sock", callTimeout = 10_000) {
    this.socketPath = socketPath;
    this.callTimeout = callTimeout;
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  /**
   * Verify the daemon is reachable by probing the socket.
   * Each call() opens its own connection, so this is just a health check.
   */
  async connect(): Promise<void> {
    const reachable = await this.isConnected();
    if (!reachable) {
      throw new Error(
        `Cannot reach PAI daemon at ${this.socketPath}. Is it running?`
      );
    }
  }

  /**
   * No-op — each call() manages its own connection.
   */
  async disconnect(): Promise<void> {
    // Nothing to clean up; connections are per-call
  }

  /**
   * Check whether the daemon is reachable by probing the socket.
   */
  async isConnected(): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = createConnection({ path: this.socketPath });
      const timer = setTimeout(() => {
        probe.destroy();
        resolve(false);
      }, 2_000);

      probe.once("connect", () => {
        clearTimeout(timer);
        probe.end();
        resolve(true);
      });

      probe.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // RPC call
  // ---------------------------------------------------------------------------

  /**
   * Send a request and wait for the response.
   *
   * The PAI daemon uses a request-response model where each connection
   * handles one request and then closes. This method opens a fresh
   * connection per call to match that protocol.
   */
  async call<T>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    const id = this.nextId();
    const line = JSON.stringify({ id, method, params }) + "\n";

    return new Promise<T>((resolve, reject) => {
      let buffer = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(
            new Error(
              `PAI daemon call "${method}" timed out after ${this.callTimeout}ms`
            )
          );
        }
      }, this.callTimeout);

      const sock = createConnection({ path: this.socketPath });
      sock.setEncoding("utf8");

      sock.once("connect", () => {
        sock.write(line, "utf8", (err) => {
          if (err && !settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
      });

      sock.on("data", (chunk: string) => {
        buffer += chunk;
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;

        const jsonLine = buffer.slice(0, nl).trim();
        if (!jsonLine) return;

        clearTimeout(timer);
        if (settled) return;
        settled = true;

        try {
          const message = JSON.parse(jsonLine) as RpcResponse;
          if (message.error) {
            const errMsg =
              typeof message.error === "string"
                ? message.error
                : `[${message.error.code}] ${message.error.message}`;
            reject(new Error(`PAI daemon: ${errMsg}`));
          } else {
            resolve(message.result as T);
          }
        } catch {
          reject(new Error(`PAI daemon: malformed response`));
        }
      });

      sock.once("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      sock.on("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("PAI daemon closed connection before responding"));
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private nextId(): string {
    this.requestId += 1;
    return `pai-${this.requestId}`;
  }
}
