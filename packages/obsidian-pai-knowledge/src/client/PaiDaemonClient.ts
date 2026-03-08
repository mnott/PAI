/**
 * PaiDaemonClient — persistent NDJSON client over a Unix domain socket.
 *
 * Protocol:
 *   - Each request is one JSON line:  { id, method, params }
 *   - Each response is one JSON line: { id, result } | { id, error }
 *   - The connection stays open between requests (multiplexed by id).
 *
 * Usage:
 *   const client = new PaiDaemonClient("/tmp/pai.sock");
 *   await client.connect();
 *   const data = await client.call<GraphClustersResult>("graph_clusters", { max_clusters: 20 });
 *   await client.disconnect();
 */

import { createConnection, Socket } from "net";
import type { RpcResponse } from "./types";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class PaiDaemonClient {
  private socketPath: string;
  private socket: Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = "";
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
   * Open the Unix socket connection to the PAI daemon.
   * Resolves when connected, rejects if the daemon is not reachable.
   */
  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return; // already connected
    }

    return new Promise((resolve, reject) => {
      const sock = createConnection({ path: this.socketPath });

      sock.setEncoding("utf8");
      sock.setKeepAlive(true, 15_000);

      sock.once("connect", () => {
        this.socket = sock;
        resolve();
      });

      sock.once("error", (err) => {
        reject(err);
      });

      sock.on("data", (chunk: string) => {
        this.handleData(chunk);
      });

      sock.on("close", () => {
        this.socket = null;
        // Reject all pending requests — the connection dropped unexpectedly
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("PAI daemon connection closed unexpectedly"));
          this.pending.delete(id);
        }
      });

      sock.on("error", (err) => {
        // Errors after initial connect — reject any in-flight calls
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timeout);
          pending.reject(err);
          this.pending.delete(id);
        }
      });
    });
  }

  /**
   * Close the socket connection gracefully.
   */
  async disconnect(): Promise<void> {
    if (!this.socket) return;

    return new Promise((resolve) => {
      if (!this.socket) {
        resolve();
        return;
      }
      this.socket.once("close", () => resolve());
      this.socket.end();
    });
  }

  /**
   * Check whether the daemon is reachable by attempting a lightweight connection.
   * Does not affect the persistent connection managed by connect()/disconnect().
   */
  async isConnected(): Promise<boolean> {
    if (this.socket && !this.socket.destroyed) {
      return true;
    }
    // Probe: try to open a fresh connection just to check reachability
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
   * Send a JSON-RPC request and wait for the matching response.
   *
   * @param method  Daemon method name, e.g. "graph_clusters"
   * @param params  Parameters object (may be empty)
   * @returns       Resolved result typed as T
   * @throws        On timeout, transport error, or daemon-side error
   */
  async call<T>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Not connected to PAI daemon — call connect() first");
    }

    const id = this.nextId();
    const line = JSON.stringify({ id, method, params }) + "\n";

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `PAI daemon call "${method}" timed out after ${this.callTimeout}ms`
          )
        );
      }, this.callTimeout);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.socket!.write(line, "utf8", (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: response handling
  // ---------------------------------------------------------------------------

  /**
   * Accumulates incoming data, splits on newlines, and resolves pending calls.
   */
  private handleData(chunk: string): void {
    this.buffer += chunk;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) continue;

      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch {
        // Malformed line — skip and continue
        console.error("[PAI] Failed to parse daemon response:", line);
        continue;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        // No pending request for this id — unsolicited message or duplicate
        console.warn("[PAI] Received response for unknown id:", message.id);
        continue;
      }

      clearTimeout(pending.timeout);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(
          new Error(
            `PAI daemon error [${message.error.code}]: ${message.error.message}`
          )
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private nextId(): string {
    this.requestId += 1;
    return `pai-${this.requestId}`;
  }
}
