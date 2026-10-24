/**
 * Fire-and-forget request to the PAI daemon socket. Resolves on the first reply,
 * any error, or after 5 s; a hook must never fail or hang on the daemon.
 * Inline-free: avoids importing src/daemon/ipc-client.ts at build time.
 */

import { connect } from "node:net";
import { paiSocketPath } from "../../../runtime-paths.js";

export function sendToDaemon(method: string, params: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { resolve(); }, 5000);
    try {
      const socket = connect(paiSocketPath(), () => {
        const req = JSON.stringify({ id: Date.now().toString(), method, params }) + "\n";
        socket.write(req);
        socket.on("data", () => { clearTimeout(timeout); socket.destroy(); resolve(); });
        socket.on("error", () => { clearTimeout(timeout); resolve(); });
      });
      socket.on("error", () => { clearTimeout(timeout); resolve(); });
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}
