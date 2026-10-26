/**
 * run-token.ts — the worker side of keyless runs (see src/router/run-tokens.ts).
 *
 * One helper for every engine: mint a per-run placeholder, register it with the
 * router, and hand the engine only the token and the router base URL. The
 * provider's real key stays in its key file, read by the router.
 */

import http from "node:http";
import { LOOPBACK_HOST } from "../utils/loopback.js";
import { mintRunToken, RUN_TOKEN_PATH, RUN_TOKEN_SLACK_MS } from "../router/run-tokens.js";
import { routerPort } from "../router/router.js";

const CONTROL_TIMEOUT_MS = 2000;
/** Runs without a deadline: token lifetime before the slack. */
const DEFAULT_RUN_MS = 6 * 3_600_000;
/** Run ids this process registered a token for (revoked at the run's end). */
const registered = new Set<string>();

function control(method: "POST" | "DELETE", body: object): Promise<boolean> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: LOOPBACK_HOST, port: routerPort(), path: RUN_TOKEN_PATH, method, timeout: CONTROL_TIMEOUT_MS, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end(data);
  });
}

/**
 * A registered placeholder for `provider`, valid until the run's deadline plus slack; null when the router
 * did not take it (not running) — the caller then has no keyless route and says so.
 */
export async function acquireRunToken(provider: string, runId: string, deadlineAt?: number): Promise<string | null> {
  const token = mintRunToken();
  const ttlMs = (deadlineAt ? Math.max(0, deadlineAt - Date.now()) : DEFAULT_RUN_MS) + RUN_TOKEN_SLACK_MS;
  const ok = await control("POST", { token, provider, runId, ttlMs, pid: process.pid });
  if (!ok) return null;
  registered.add(runId);
  return token;
}

/** Revoke a run's token (idempotent; a no-op when this process registered none). */
export async function revokeRunToken(runId: string): Promise<void> {
  if (!registered.delete(runId)) return;
  await control("DELETE", { runId });
}
