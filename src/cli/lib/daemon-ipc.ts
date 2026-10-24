/**
 * daemon-ipc.ts
 *
 * One-shot JSON request to the PAI daemon over its Unix socket.
 * Used by: pai observation, pai skill
 */

import { createConnection } from "net";
import { paiSocketPath } from "../../runtime-paths.js";

export function ipcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const client = createConnection(paiSocketPath(), () => {
      client.write(JSON.stringify({ id: 1, method, params }) + "\n");
    });
    let data = "";
    client.on("data", (chunk) => {
      data += chunk.toString();
      // Daemon sends a single JSON line then closes — try parsing eagerly
      try {
        const resp = JSON.parse(data) as { ok: boolean; result: unknown; error?: string };
        client.end();
        settle(() => resp.ok ? resolve(resp.result) : reject(new Error(resp.error ?? "IPC call failed")));
      } catch {
        // Incomplete — wait for more data or end
      }
    });
    client.on("end", () => {
      settle(() => {
        try {
          const resp = JSON.parse(data) as { ok: boolean; result: unknown; error?: string };
          resp.ok ? resolve(resp.result) : reject(new Error(resp.error ?? "IPC call failed"));
        } catch (e) { reject(e); }
      });
    });
    client.on("error", (e) => settle(() => reject(e)));
    setTimeout(() => { client.destroy(); settle(() => reject(new Error("IPC timeout"))); }, 10000);
  });
}
