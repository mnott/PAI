/**
 * IPC server and daemon entry point.
 * Owns: isSocketLive, startIpcServer, serve (exported).
 */

import { existsSync, unlinkSync } from "node:fs";
import { createServer, connect, Socket, Server } from "node:net";
import { setPriority } from "node:os";
import { openRegistry } from "../../registry/db.js";
import { createStorageBackend } from "../../storage/factory.js";
import { configureEmbeddingModel } from "../../memory/embeddings.js";
import { loadNotificationConfig } from "../../notifications/config.js";
import type { PaiDaemonConfig } from "../config.js";
import type { IpcRequest } from "./types.js";
import {
  setRegistryDb,
  setStorageBackend,
  setDaemonConfig,
  setStartTime,
  setNotificationConfig,
  setShutdownRequested,
  indexInProgress,
  embedInProgress,
  indexSchedulerTimer,
  embedSchedulerTimer,
  storageBackend,
} from "./state.js";
import { startIndexScheduler, startEmbedScheduler } from "./scheduler.js";
import { handleRequest, sendResponse } from "./handler.js";

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an existing socket file is actually being served by a live process.
 */
function isSocketLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = connect(path);
    const timer = setTimeout(() => { client.destroy(); resolve(false); }, 500);
    client.on("connect", () => { clearTimeout(timer); client.end(); resolve(true); });
    client.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

/**
 * Start the Unix Domain Socket IPC server.
 */
async function startIpcServer(socketPath: string): Promise<Server> {
  if (existsSync(socketPath)) {
    const live = await isSocketLive(socketPath);
    if (live) {
      throw new Error("Another daemon is already running — socket is live. Aborting startup.");
    }
    try {
      unlinkSync(socketPath);
      process.stderr.write("[pai-daemon] Removed stale socket file.\n");
    } catch {
      // If we can't remove it, bind will fail with a clear error
    }
  }

  const server = createServer((socket: Socket) => {
    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        if (line.trim() === "") continue;

        let request: IpcRequest;
        try {
          request = JSON.parse(line) as IpcRequest;
        } catch {
          sendResponse(socket, { id: "?", ok: false, error: "Invalid JSON" });
          socket.destroy();
          return;
        }

        handleRequest(request, socket).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          sendResponse(socket, { id: request.id, ok: false, error: msg });
          socket.destroy();
        });
      }
    });

    socket.on("error", () => {
      // Client disconnected — nothing to do
    });
  });

  server.on("error", (e) => {
    process.stderr.write(`[pai-daemon] IPC server error: ${e}\n`);
  });

  server.listen(socketPath, () => {
    process.stderr.write(
      `[pai-daemon] IPC server listening on ${socketPath}\n`
    );
  });

  return server;
}

// ---------------------------------------------------------------------------
// Main daemon entry point
// ---------------------------------------------------------------------------

export async function serve(config: PaiDaemonConfig): Promise<void> {
  setDaemonConfig(config);
  setStartTime(Date.now());

  setNotificationConfig(loadNotificationConfig());

  process.stderr.write("[pai-daemon] Starting daemon...\n");
  process.stderr.write(`[pai-daemon] Socket: ${config.socketPath}\n`);
  process.stderr.write(`[pai-daemon] Storage backend: ${config.storageBackend}\n`);
  const { notificationConfig } = await import("./state.js");
  process.stderr.write(
    `[pai-daemon] Notification mode: ${notificationConfig.mode}\n`
  );

  // Lower scheduling priority so the daemon yields CPU to interactive sessions
  try { setPriority(process.pid, 10); } catch { /* non-fatal */ }

  configureEmbeddingModel(config.embeddingModel);

  try {
    setRegistryDb(openRegistry());
    process.stderr.write("[pai-daemon] Registry database opened.\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pai-daemon] Fatal: Could not open registry: ${msg}\n`);
    process.exit(1);
  }

  try {
    const backend = await createStorageBackend(config);
    setStorageBackend(backend);
    process.stderr.write(
      `[pai-daemon] Federation backend: ${backend.backendType}\n`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pai-daemon] Fatal: Could not open federation storage: ${msg}\n`);
    process.exit(1);
  }

  startIndexScheduler();

  if (storageBackend.backendType === "postgres") {
    startEmbedScheduler();
  } else {
    process.stderr.write(
      "[pai-daemon] Embed scheduler: disabled (SQLite backend)\n"
    );
  }

  const server = await startIpcServer(config.socketPath);

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\n[pai-daemon] ${signal} received. Stopping.\n`);

    setShutdownRequested(true);

    if (indexSchedulerTimer) clearInterval(indexSchedulerTimer);
    if (embedSchedulerTimer) clearInterval(embedSchedulerTimer);

    server.close();

    const SHUTDOWN_TIMEOUT_MS = 10_000;
    const POLL_INTERVAL_MS = 100;
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;

    if (indexInProgress || embedInProgress) {
      process.stderr.write(
        `[pai-daemon] Waiting for in-progress operations to finish ` +
          `(index=${indexInProgress}, embed=${embedInProgress})...\n`
      );

      while ((indexInProgress || embedInProgress) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      if (indexInProgress || embedInProgress) {
        process.stderr.write("[pai-daemon] Shutdown timeout reached — forcing exit.\n");
      } else {
        process.stderr.write("[pai-daemon] In-progress operations finished.\n");
      }
    }

    try {
      await storageBackend.close();
    } catch {
      // ignore
    }

    try {
      unlinkSync(config.socketPath);
    } catch {
      // ignore
    }

    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(0)); });
  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(0)); });

  // Keep process alive
  await new Promise(() => {});
}
