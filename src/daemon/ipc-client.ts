/**
 * ipc-client.ts — IPC client for the PAI Daemon MCP shim
 *
 * PaiClient connects to the Unix Domain Socket served by daemon.ts
 * and forwards tool calls to the daemon. Uses a fresh socket connection per
 * call (connect → write JSON + newline → read response line → parse → destroy).
 * This keeps the client stateless and avoids connection management complexity.
 *
 * Adapted from the Coogle ipc-client pattern (which was adapted from Whazaa).
 */

import { connect, Socket } from "node:net";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

/** Default socket path */
export const IPC_SOCKET_PATH = "/tmp/pai.sock";

/** Timeout for IPC calls (60 seconds) */
const IPC_TIMEOUT_MS = 60_000;

interface IpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface IpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Thin IPC proxy that forwards tool calls to pai-daemon over a Unix
 * Domain Socket. Each call opens a fresh connection, sends one NDJSON request,
 * reads the response, and closes. Stateless and simple.
 */
export class PaiClient {
  private readonly socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? IPC_SOCKET_PATH;
  }

  /**
   * Call a PAI tool by name with the given params.
   * Returns the tool result or throws on error.
   */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.send(method, params);
  }

  /**
   * Check daemon status.
   */
  async status(): Promise<Record<string, unknown>> {
    const result = await this.send("status", {});
    return result as Record<string, unknown>;
  }

  /**
   * Trigger an immediate index run.
   */
  async triggerIndex(): Promise<void> {
    await this.send("index_now", {});
  }

  // -------------------------------------------------------------------------
  // Internal transport
  // -------------------------------------------------------------------------

  /**
   * Send a single IPC request and wait for the response.
   * Opens a new socket connection per call — simple and reliable.
   */
  private send(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const socketPath = this.socketPath;

    return new Promise((resolve, reject) => {
      let socket: Socket | null = null;
      let done = false;
      let buffer = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

      function finish(error: Error | null, value?: unknown): void {
        if (done) return;
        done = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        try {
          socket?.destroy();
        } catch {
          // ignore
        }
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      }

      socket = connect(socketPath, () => {
        const request: IpcRequest = {
          id: randomUUID(),
          method,
          params,
        };
        socket!.write(JSON.stringify(request) + "\n");
      });

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;

        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        let response: IpcResponse;
        try {
          response = JSON.parse(line) as IpcResponse;
        } catch {
          finish(new Error(`IPC parse error: ${line}`));
          return;
        }

        if (!response.ok) {
          finish(new Error(response.error ?? "IPC call failed"));
        } else {
          finish(null, response.result);
        }
      });

      socket.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
          finish(
            new Error(
              "PAI daemon not running. Start it with: pai daemon serve"
            )
          );
        } else {
          finish(e);
        }
      });

      socket.on("end", () => {
        if (!done) {
          finish(new Error("IPC connection closed before response"));
        }
      });

      timer = setTimeout(() => {
        finish(new Error("IPC call timed out after 60s"));
      }, IPC_TIMEOUT_MS);
    });
  }
}
