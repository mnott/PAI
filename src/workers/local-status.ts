/**
 * local-status.ts — the one authoritative answer to "which local model is
 * running?" (incident 2026-10-19: a session curled ports 8010/8011/8020, found
 * nothing, and went looking for how to start a model server while the running
 * one was never considered). The PAI daemon computes the answer every 30 s and
 * caches it in <logDir>/local-status.json; everything else only reads it:
 * `pai worker local`, the `local_status` MCP tool, resolveLocalProvider, the
 * prompt hint and the Bash guard. Readers fall back to a direct probe only
 * when the cache is missing or stale (daemon unreachable).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOCAL_STATUS_REFRESH_MS = 30_000;
/** A cache older than this means the daemon is not refreshing it. */
export const LOCAL_STATUS_MAX_AGE_MS = 90_000;

export interface LocalStatus {
  /** ISO time the daemon computed this. */
  at: string;
  running: { provider: string; model: string; why: string } | null;
  /** Enabled local providers with nothing listening. */
  down: string[];
  /** Local providers switched off in workers.yaml. */
  disabled: string[];
}

export const localStatusPath = (logDir: string): string => join(logDir, "local-status.json");

export const NO_SERVER_HINT = "do not start model servers";

export function localStatusLine(st: LocalStatus): string {
  if (st.running) {
    return `local: ${st.running.provider} (${st.running.model}) running — use \`pai worker run --local\``;
  }
  return `local: none running — local work is not available; ${NO_SERVER_HINT}`;
}

export function writeLocalStatus(logDir: string, st: LocalStatus): void {
  const path = localStatusPath(logDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(st) + "\n", "utf8");
  renameSync(tmp, path);
}

/** The daemon's cached answer; null when absent, damaged or older than maxAgeMs. */
export function readLocalStatus(logDir: string, now = Date.now(), maxAgeMs = LOCAL_STATUS_MAX_AGE_MS): LocalStatus | null {
  const path = localStatusPath(logDir);
  if (!existsSync(path)) return null;
  try {
    const st = JSON.parse(readFileSync(path, "utf8")) as LocalStatus;
    const at = Date.parse(st.at);
    if (Number.isNaN(at) || now - at > maxAgeMs || !Array.isArray(st.down) || !Array.isArray(st.disabled)) return null;
    return st;
  } catch {
    return null;
  }
}

/** Text + JSON of the answer for the CLI and the MCP tool. */
export function localStatusReport(st: LocalStatus): { text: string; json: LocalStatus } {
  const extra =
    (st.down.length ? ` down: ${st.down.join(", ")}.` : "") + (st.disabled.length ? ` disabled: ${st.disabled.join(", ")}.` : "");
  return { text: localStatusLine(st) + (extra ? `\n${extra.trim()}` : ""), json: st };
}
