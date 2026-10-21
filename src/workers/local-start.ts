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
  /** instance id `<model>#<n>`; records written before instances existed have none (read as `<tier>#1`) */
  id?: string;
  tier: string;
  provider: string;
  port: number;
  /** epoch ms the start was requested */
  startedAt: number;
  /** how long the start may take before it counts as failed */
  readyMs: number;
  log: string;
  /** memory the start promised, GB: counted as used by other starts until this one is ready */
  needGb?: number;
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

const keyOf = (s: Pick<LocalStart, "id" | "tier">): string => s.id ?? `${s.tier}#1`;

const valid = (s: unknown): s is LocalStart =>
  !!s && typeof (s as LocalStart).tier === "string" && typeof (s as LocalStart).startedAt === "number" && typeof (s as LocalStart).port === "number";

/** All starts in flight or failed, by instance id. A file holding one bare record (older format) reads as `{<tier>#1: it}`. */
export function readLocalStarts(logDir: string): Record<string, LocalStart> {
  const path = localStartPath(logDir);
  if (!existsSync(path)) return {};
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (valid(j)) return { [keyOf(j)]: j };
    const out: Record<string, LocalStart> = {};
    if (j && typeof j === "object") for (const [id, r] of Object.entries(j)) if (valid(r)) out[id] = r;
    return out;
  } catch {
    return {};
  }
}

function writeAll(logDir: string, all: Record<string, LocalStart>): void {
  const path = localStartPath(logDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all) + "\n", "utf8");
  renameSync(tmp, path);
}

export function writeLocalStart(logDir: string, s: LocalStart): void {
  writeAll(logDir, { ...readLocalStarts(logDir), [keyOf(s)]: s });
}

/** Drop the record of instance `id`; without an id, every record. */
export function clearLocalStart(logDir: string, id?: string): void {
  if (id === undefined) return void rmSync(localStartPath(logDir), { force: true });
  const { [id]: _gone, ...rest } = readLocalStarts(logDir);
  if (Object.keys(rest).length === 0) rmSync(localStartPath(logDir), { force: true });
  else writeAll(logDir, rest);
}

/** Mark the recorded start failed (kept so the cockpit can say so); without an id, the most recent one. */
export function failLocalStart(logDir: string, reason: string, id?: string): void {
  const all = readLocalStarts(logDir);
  const key = id ?? Object.keys(all).sort((a, b) => all[b].startedAt - all[a].startedAt)[0];
  if (key && all[key]) writeAll(logDir, { ...all, [key]: { ...all[key], failed: reason } });
}

/** The most recent start (single-slot view for callers that show one). */
export function readLocalStart(logDir: string): LocalStart | null {
  const all = Object.values(readLocalStarts(logDir));
  return all.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
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
