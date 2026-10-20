/**
 * session-profile-store.ts — the per-session profile file (session-profiles.yaml
 * under the PAI home) and nothing else: types, atomic read/write, the legacy
 * session-workers.json migration and the current session's name. The resolver
 * that uses it is session-profile.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { paiHomePath } from "../config/pai-home.js";

export const SESSION_NAME_ENV = "PAI_SESSION_NAME";
/** Set by queue/plan runners (and --batch) on spawns that are part of a fan-out. */
export const BATCH_ENV = "PAI_WORKER_BATCH";

export interface ProfileTarget {
  provider: string;
  model?: string;
}

export interface SessionProfile {
  chat?: ProfileTarget;
  workers?: ProfileTarget;
  fallback?: ProfileTarget[];
  parallel_min?: number;
  /** Most workers of this session running at once, on any provider (1 = one after the other). */
  max_parallel?: number;
  /** Routing rows this session overrides: class -> ordered models (route-lists.ts). */
  routes?: Record<string, string[]>;
  /** Optional reason per overridden row. */
  route_notes?: Record<string, string>;
}

export type Profiles = Record<string, SessionProfile>;

export const profilesPath = (): string => paiHomePath("session-profiles.yaml");
const legacyWorkersPath = (): string => paiHomePath("session-workers.json");

function cleanTarget(v: unknown): ProfileTarget | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { provider, model } = v as Record<string, unknown>;
  if (typeof provider !== "string" || !provider.trim()) return undefined;
  return { provider: provider.trim(), ...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}) };
}

function cleanProfile(v: unknown): SessionProfile {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out: SessionProfile = {};
  const chat = cleanTarget(r.chat);
  const workers = cleanTarget(r.workers);
  if (chat) out.chat = chat;
  if (workers) out.workers = workers;
  if (Array.isArray(r.fallback)) {
    const list = r.fallback.map(cleanTarget).filter((t): t is ProfileTarget => !!t);
    if (list.length) out.fallback = list;
  }
  if (typeof r.parallel_min === "number" && Number.isInteger(r.parallel_min) && r.parallel_min > 0) out.parallel_min = r.parallel_min;
  if (typeof r.max_parallel === "number" && Number.isInteger(r.max_parallel) && r.max_parallel > 0) out.max_parallel = r.max_parallel;
  if (r.routes && typeof r.routes === "object") {
    const routes: Record<string, string[]> = {};
    for (const [cls, v] of Object.entries(r.routes as Record<string, unknown>)) {
      const list = Array.isArray(v) ? [...new Set(v.filter((m): m is string => typeof m === "string" && !!m.trim()).map((m) => m.trim()))] : [];
      if (list.length) routes[cls] = list;
    }
    if (Object.keys(routes).length) out.routes = routes;
    if (out.routes && r.route_notes && typeof r.route_notes === "object") {
      const notes: Record<string, string> = {};
      for (const [cls, n] of Object.entries(r.route_notes as Record<string, unknown>)) if (out.routes[cls] && typeof n === "string" && n.trim()) notes[cls] = n.trim();
      if (Object.keys(notes).length) out.route_notes = notes;
    }
  }
  return out;
}

function writeAtomic(path: string, profiles: Profiles): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, stringify(profiles));
  renameSync(tmp, path);
}

/** Fold the old session-workers.json (name -> provider) into the store, then drop it. */
function migrateLegacy(path: string, profiles: Profiles): boolean {
  const legacy = legacyWorkersPath();
  if (!existsSync(legacy)) return false;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(legacy, "utf8")) as Record<string, unknown>;
  } catch {
    return false; // unreadable: leave the only copy alone
  }
  for (const [name, v] of Object.entries(data)) {
    if (typeof v !== "string" || !v) continue;
    profiles[name] ??= {};
    profiles[name].workers ??= { provider: v };
  }
  writeAtomic(path, profiles);
  unlinkSync(legacy);
  return true;
}

/** All profiles; the legacy session-workers.json is migrated on the way. A broken file reads as empty and is never overwritten by a read. */
export function readProfiles(path: string = profilesPath()): Profiles {
  const profiles: Profiles = {};
  if (existsSync(path)) {
    try {
      const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
      for (const [name, v] of Object.entries(raw ?? {})) profiles[name] = cleanProfile(v);
    } catch {
      return {};
    }
  }
  try {
    if (path === profilesPath()) migrateLegacy(path, profiles);
  } catch {
    // migration is best effort; the legacy file stays
  }
  return profiles;
}

export function getProfile(name: string | null | undefined, path: string = profilesPath()): SessionProfile | null {
  if (!name) return null;
  return readProfiles(path)[name] ?? null;
}

/** Partial update: a key present replaces that part, `null` clears it. */
export interface ProfilePatch {
  chat?: ProfileTarget | null;
  workers?: ProfileTarget | null;
  fallback?: ProfileTarget[] | null;
  parallel_min?: number | null;
  max_parallel?: number | null;
  routes?: Record<string, string[]> | null;
  route_notes?: Record<string, string> | null;
}

export function updateProfile(name: string, patch: ProfilePatch, path: string = profilesPath()): SessionProfile {
  const profiles = readProfiles(path);
  const next: SessionProfile = { ...(profiles[name] ?? {}) };
  for (const k of ["chat", "workers", "fallback", "parallel_min", "max_parallel", "routes", "route_notes"] as const) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === undefined) delete next[k];
    else (next as Record<string, unknown>)[k] = v;
  }
  profiles[name] = cleanProfile(next);
  writeAtomic(path, profiles);
  return profiles[name];
}

/** The session's persistent name: exported by `pai` at launch; undefined when the session is unnamed. */
export function currentSessionName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[SESSION_NAME_ENV]?.trim() || undefined;
}
