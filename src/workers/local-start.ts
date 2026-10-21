/**
 * local-start.ts — a tier start in flight. startTier records the request here
 * (<logDir>/local-start.json) when it launches the server and clears it once
 * /v1/models answers; a start that fails or outlives its ready window stays as
 * "failed". The cockpit reads it so a model that is loading shows "loading",
 * not "not loaded" (a vllm-mlx 45 GB model takes 1-2 min to answer).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LocalStart {
  tier: string;
  provider: string;
  port: number;
  /** epoch ms the start was requested */
  startedAt: number;
  /** how long the start may take before it counts as failed */
  readyMs: number;
  log: string;
  /** set when the launch failed (server exited, not ready in time) */
  failed?: string;
}

export interface LocalStartView {
  tier: string;
  provider: string;
  port: number;
  state: "loading" | "failed";
  sinceSec: number;
  /** "failed to start, see <log>" when state is failed */
  message?: string;
  log: string;
}

export const localStartPath = (logDir: string): string => join(logDir, "local-start.json");

export function writeLocalStart(logDir: string, s: LocalStart): void {
  const path = localStartPath(logDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s) + "\n", "utf8");
  renameSync(tmp, path);
}

export function clearLocalStart(logDir: string): void {
  rmSync(localStartPath(logDir), { force: true });
}

/** Mark the recorded start failed (kept so the cockpit can say so). */
export function failLocalStart(logDir: string, reason: string): void {
  const s = readLocalStart(logDir);
  if (s) writeLocalStart(logDir, { ...s, failed: reason });
}

export function readLocalStart(logDir: string): LocalStart | null {
  const path = localStartPath(logDir);
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as LocalStart;
    return typeof s.tier === "string" && typeof s.startedAt === "number" && typeof s.port === "number" ? s : null;
  } catch {
    return null;
  }
}

/** The start as the cockpit shows it: loading until readyMs, then (or when marked) failed. */
export function localStartView(s: LocalStart | null, now = Date.now()): LocalStartView | null {
  if (!s) return null;
  const sinceSec = Math.max(0, Math.round((now - s.startedAt) / 1000));
  const failed = s.failed !== undefined || now - s.startedAt > s.readyMs;
  return {
    tier: s.tier,
    provider: s.provider,
    port: s.port,
    state: failed ? "failed" : "loading",
    sinceSec,
    ...(failed ? { message: `failed to start, see ${s.log}` } : {}),
    log: s.log,
  };
}
