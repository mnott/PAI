/**
 * Forge push-mirror sync: `pai build mirror-sync` for forge-first repos
 * (origin = a Gitea/Forgejo forge, a push mirror to GitHub). Replaces the
 * hand-written curl `POST /api/v1/repos/<owner>/<repo>/push_mirrors-sync`:
 * trigger the sync, poll until each mirror's last_update changes, and print
 * one line per mirror — a GitHub push-protection refusal (GH013) comes out
 * as the short reason plus the unblock URL, not a raw JSON `last_error`.
 * Token: the env var named by config `release.forgeTokenEnv`; never printed.
 */

import { execFileSync } from "node:child_process";
import { deepMergeConfig, shippedMainDefaults } from "../config/shipped-defaults.js";

export interface MirrorError {
  reason: string;
  detail: string;
  unblockUrl?: string;
}

export interface MirrorResult {
  name: string;
  ok: boolean;
  commitSha?: string;
  error?: MirrorError;
}

export interface MirrorSyncResult {
  repo: string;
  mirrors: MirrorResult[];
}

export interface MirrorJson {
  name?: string;
  last_update?: string;
  commit_sha?: string;
  last_error?: string;
}

/** Injected in tests; throws on transport failure. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: string }>;

export class MirrorSyncFailed extends Error {}

const SYNC_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

/** https://host[/prefix]/OWNER/REPO(.git) or ssh form git@host:[/prefix/]OWNER/REPO(.git) -> forge base + "OWNER/REPO". */
export function deriveForge(originUrl: string): { baseUrl: string; repo: string } {
  const url = originUrl.trim();
  const https = url.match(/^(https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.*?)\/?$/);
  if (https) {
    const parts = https[3].replace(/\.git$/, "").split("/");
    if (parts.length >= 2) {
      const prefix = parts.slice(0, -2).join("/");
      const scheme = https[1] === "ssh" ? "https" : https[1];
      const host = https[1] === "ssh" ? https[2].replace(/:\d+$/, "") : https[2];
      return { baseUrl: `${scheme}://${host}${prefix ? `/${prefix}` : ""}`, repo: parts.slice(-2).join("/") };
    }
  }
  const ssh = url.includes("://") ? null : url.match(/^(?:[^@\s]+@)?([^/\s:]+):(?:\/)?(.*?)\/?$/);
  if (ssh) {
    const parts = ssh[2].replace(/\.git$/, "").split("/");
    if (parts.length >= 2) {
      const prefix = parts.slice(0, -2).join("/");
      return { baseUrl: `https://${ssh[1]}${prefix ? `/${prefix}` : ""}`, repo: parts.slice(-2).join("/") };
    }
  }
  throw new MirrorSyncFailed("cannot derive forge URL from origin (use an https or ssh origin)");
}

/** Reads the main config (shipped defaults under the user's file); injected in tests. */
export type ConfigReader = () => Record<string, unknown>;

/** Shipped defaults merged under the user's main config (unmasked: the value is an env var NAME). */
async function defaultConfigReader(): Promise<ConfigReader> {
  // imported lazily: daemon/config.ts resolves config paths at module load
  const { readMainConfigRaw } = await import("../daemon/config.js");
  return () => deepMergeConfig(shippedMainDefaults(), readMainConfigRaw());
}

/** The env var holding the forge token: config `release.forgeTokenEnv`, else the shipped default name. */
export function forgeTokenEnvName(readConfig: ConfigReader): string {
  try {
    const v = (readConfig().release as { forgeTokenEnv?: unknown } | undefined)?.forgeTokenEnv;
    if (typeof v === "string" && v) return v;
  } catch { /* unreadable config: the default name */ }
  return "AIBROKER_FORGE_TOKEN";
}

/** The shipped default: the defaults file names the env var the token is read from. */
export function shippedForgeTokenEnvName(): string {
  const v = (shippedMainDefaults().release as { forgeTokenEnv?: unknown } | undefined)?.forgeTokenEnv;
  return typeof v === "string" && v ? v : "AIBROKER_FORGE_TOKEN";
}

/** Parse Gitea's push-mirror JSON list; a non-list body yields []. */
export function parseMirrors(text: string): MirrorJson[] {
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? (j as MirrorJson[]) : [];
  } catch {
    return [];
  }
}

/**
 * Read a refusal out of `last_error`: GitHub push protection (GH013) gets the
 * short reason and the unblock-secret URL; a plain "remote rejected" line gets
 * its reason; anything else is the first 200 chars.
 */
export function parseMirrorError(lastError: string): MirrorError {
  const unblock = lastError.match(/https?:\/\/[^\s"']*unblock-secret\/[^\s"'\\)]+/)?.[0]?.replace(/\\+$/, "");
  if (/GH013|Push cannot contain secrets/.test(lastError)) {
    const secret = lastError.match(/found \d+ secrets? on the push[^\n]*?"[^"\n]*"/i)?.[0] ?? "push cannot contain secrets";
    return { reason: "push protection", detail: secret, ...(unblock ? { unblockUrl: unblock } : {}) };
  }
  const rejected = lastError.match(/remote rejected[^\n"']*/i)?.[0];
  if (rejected) return { reason: "remote rejected", detail: rejected.replace(/^.*remote rejected:?\s*/i, "").trim() || rejected, ...(unblock ? { unblockUrl: unblock } : {}) };
  return { reason: lastError.slice(0, 200), detail: lastError.slice(0, 200) };
}

/** "github: ok (main at <sha8>)" — the branch is the mirror's own name. */
export function formatMirror(m: MirrorResult): string {
  if (m.ok) return `${m.name}: ok (${m.name} at ${m.commitSha ? m.commitSha.slice(0, 8) : "?"})`;
  const e = m.error;
  if (e?.reason === "push protection") return `${m.name}: REJECTED — push protection: ${e.detail}${e.unblockUrl ? `; unblock: ${e.unblockUrl}` : ""}`;
  return `${m.name}: REJECTED — ${e ? (e.unblockUrl ? `${e.reason}; unblock: ${e.unblockUrl}` : e.reason) : "no result"}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface MirrorSyncDeps {
  fetch?: FetchLike;
  token?: string;
  originUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readConfig?: ConfigReader;
}

const realFetch: FetchLike = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
  return { status: r.status, text: await r.text() };
};

/** Trigger the forge's push-mirror sync and poll until each mirror's last_update changes (60 s, every 3 s). */
export async function syncMirrors(cwd: string, deps: MirrorSyncDeps = {}): Promise<MirrorSyncResult> {
  const fetchImpl = deps.fetch ?? realFetch;
  const now = deps.now ?? (() => Date.now());
  const wait = deps.sleep ?? sleep;
  const envName = forgeTokenEnvName(deps.readConfig ?? (await defaultConfigReader().catch((): ConfigReader => () => ({}))));
  const token = deps.token ?? process.env[envName];
  if (!token) throw new MirrorSyncFailed(`no forge token: set ${envName} (or config release.forgeTokenEnv)`);
  let origin = deps.originUrl;
  if (!origin) {
    try {
      origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      throw new MirrorSyncFailed("no origin remote");
    }
  }
  const { baseUrl, repo } = deriveForge(origin);
  const headers = { Authorization: `token ${token}`, "Content-Type": "application/json" };
  const listUrl = `${baseUrl}/api/v1/repos/${repo}/push_mirrors`;
  const before = parseMirrors((await fetchImpl(listUrl, { method: "GET", headers })).text);
  const post = await fetchImpl(`${listUrl}-sync`, { method: "POST", headers });
  if (post.status < 200 || post.status >= 300) throw new MirrorSyncFailed(`HTTP ${post.status} on POST push_mirrors-sync`);
  const deadline = now() + POLL_TIMEOUT_MS;
  let mirrors = before;
  for (;;) {
    mirrors = parseMirrors((await fetchImpl(listUrl, { method: "GET", headers })).text);
    const changed = mirrors.length > 0 && mirrors.some((m, i) => m.last_update !== before[i]?.last_update);
    if (changed || now() >= deadline) break;
    await wait(POLL_INTERVAL_MS);
  }
  return {
    repo,
    mirrors: mirrors.map((m) => {
      const name = m.name || "mirror";
      if (m.last_error) return { name, ok: false, error: parseMirrorError(m.last_error) };
      if (!m.last_update || !before.some((b) => b.name === name && b.last_update === m.last_update)) {
        return { name, ok: true, commitSha: m.commit_sha };
      }
      return { name, ok: false, error: { reason: "not synced", detail: "last_update unchanged within 60 s" } };
    }),
  };
}
