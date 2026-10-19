#!/usr/bin/env node

/**
 * The status line's session-name cache: detectSessionName's slow paths
 * (AIBroker registry, transcript scan, project detection) must not run on
 * every prompt, so the status line keeps a small file per session identity
 * (ITERM_SESSION_ID / CLAUDE_CODE_SESSION_ID / cwd) under the workers log
 * dir. A fresh entry answers without any scan; a missing or stale one pays
 * the detection once and writes it back. Reads and writes are best effort:
 * any failure just means "no cache", never an error in the bar.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_NAME_CACHE_TTL_MS = 5 * 60_000;

export function sessionNameCachePath(logDir: string, env: NodeJS.ProcessEnv, cwd: string = process.cwd()): string | null {
  const key = [env.ITERM_SESSION_ID ?? "", env.CLAUDE_CODE_SESSION_ID ?? "", cwd].join("|");
  if (!key.replace(/\|/g, "")) return null; // no session identity at all: nothing to key on
  let h = 0;
  for (const c of key) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return join(logDir, `session-name-${Math.abs(h).toString(36)}.json`);
}

/** The cached name when the entry is present, parseable and younger than the ttl; undefined otherwise. */
export function readSessionNameCache(path: string | null, now: number = Date.now(), ttlMs: number = SESSION_NAME_CACHE_TTL_MS): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; at?: unknown };
    if (typeof j.at !== "number" || now - j.at > ttlMs) return undefined;
    return typeof j.name === "string" && j.name ? j.name : undefined;
  } catch {
    return undefined;
  }
}

/** Store the detected name (undefined included: a session with no name pays the scan once per ttl too). */
export function writeSessionNameCache(path: string | null, name: string | undefined, now: number = Date.now()): void {
  if (!path) return;
  try {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, JSON.stringify({ name: name ?? null, at: now }), "utf8");
  } catch {
    // best effort: a failed write only means the next prompt re-detects
  }
}
