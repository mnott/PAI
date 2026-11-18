/**
 * session-profile-store.ts — the per-session profile file (session-profiles.yaml
 * under the PAI home) and nothing else: types, atomic read/write, the legacy
 * session-workers.json migration and the current session's name. The resolver
 * that uses it is session-profile.ts.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { paiHomePath } from "../config/pai-home.js";
import { migrateSessionRoutes } from "./route-lists.js";

/**
 * Who wrote the profile. Every write names its caller and lands in the routing
 * ledger as a PROFILE-WRITE line (time, caller, session, fields), so a pin that
 * appears unasked is traceable to the code path that wrote it.
 */
export type ProfileCaller = "session-profile-set" | "launch-setup" | "route-set" | "route-clear" | "repair" | "rename" | "legacy-migration";

/** The routing ledger a profile write logs to; tests override. */
let profileLedgerPath: (() => string) | undefined;
export function setProfileLedger(fn: (() => string) | undefined): void {
  profileLedgerPath = fn;
}

/** Debug aid: why the last PROFILE-WRITE could not be logged (never thrown). */
let lastProfileLogError: string | undefined;
export const lastProfileWriteLogError = (): string | undefined => lastProfileLogError;

/**
 * One PROFILE-WRITE line appended at once (the caller's next read sees it). The
 * same shape ledger.ts appends — stamp, tag, k=v — written inline: the store is
 * a leaf module and must not reach back into config or paths. The path resolves
 * through PAI_HOME (same rule as the profile file itself), so a test home never
 * writes the real machine's ledger.
 */
function logProfileWrite(caller: ProfileCaller, name: string, fields: string): void {
  let path: string | undefined;
  try {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    // the caller's own seam wins; else PAI_HOME/logs/workers/ledger.log (the
    // same rule as the profile file itself, so a test home never writes the
    // real machine's ledger)
    path = profileLedgerPath?.() ?? join(paiHomePath("logs", "workers"), "ledger.log");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${stamp} PROFILE-WRITE caller=${caller} session=${name.replace(/\s+/g, " ")} fields=${fields}\n`, "utf8");
    lastProfileLogError = undefined;
  } catch (e) {
    // the ledger is evidence, not a gate: an unwritable log dir must not block the write it documents
    lastProfileLogError = `${path ?? "path?"}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

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
  /** True when the workers pin was written by a launch (a setup choice), not by the operator. resolveWorkers ignores it: a pin must come from an explicit choice. */
  workers_implicit?: boolean;
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
  if (workers) {
    out.workers = workers;
    if (r.workers_implicit === true) out.workers_implicit = true;
  }
  if (Array.isArray(r.fallback)) {
    const list = r.fallback.map(cleanTarget).filter((t): t is ProfileTarget => !!t);
    if (list.length) out.fallback = list;
  }
  if (typeof r.parallel_min === "number" && Number.isInteger(r.parallel_min) && r.parallel_min > 0) out.parallel_min = r.parallel_min;
  if (typeof r.max_parallel === "number" && Number.isInteger(r.max_parallel) && r.max_parallel > 0) out.max_parallel = r.max_parallel;
  if (r.routes && typeof r.routes === "object") {
    const routes: Record<string, string[]> = {};
    // overrides stored per class (the nine-row table) become per-role ones
    for (const [cls, v] of Object.entries(migrateSessionRoutes(r.routes as Record<string, unknown>))) {
      const list = Array.isArray(v) ? [...new Set(v.filter((m): m is string => typeof m === "string" && !!m.trim()).map((m) => m.trim()))] : [];
      if (list.length) routes[cls] = list;
    }
    if (Object.keys(routes).length) out.routes = routes;
    if (out.routes && r.route_notes && typeof r.route_notes === "object") {
      const notes: Record<string, string> = {};
      for (const [cls, n] of Object.entries(migrateSessionRoutes(r.route_notes as Record<string, unknown>))) if (out.routes[cls] && typeof n === "string" && n.trim()) notes[cls] = n.trim();
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
  logProfileWrite("legacy-migration", "*", "workers from session-workers.json");
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
  /** Written with a launch's workers pin; an explicit workers set clears it (updateProfile). */
  workers_implicit?: boolean | null;
  fallback?: ProfileTarget[] | null;
  parallel_min?: number | null;
  max_parallel?: number | null;
  routes?: Record<string, string[]> | null;
  route_notes?: Record<string, string> | null;
}

/**
 * Partial update through the caller named. A `workers` value is the operator's
 * explicit pin (it clears any launch-written mark); a launch must never pass
 * one — its own env pin (root.ts) applies to that session only. The write and
 * its caller land in the ledger as PROFILE-WRITE.
 */
export function updateProfile(name: string, patch: ProfilePatch, path: string = profilesPath(), caller: ProfileCaller = "session-profile-set"): SessionProfile {
  const profiles = readProfiles(path);
  const next: SessionProfile = { ...(profiles[name] ?? {}) };
  for (const k of ["chat", "workers", "workers_implicit", "fallback", "parallel_min", "max_parallel", "routes", "route_notes"] as const) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === undefined) delete next[k];
    // an explicit workers pin is the operator's choice: it replaces any launch-written one
    else if (k === "workers") { delete next.workers_implicit; (next as Record<string, unknown>)[k] = v; }
    else (next as Record<string, unknown>)[k] = v;
  }
  const before = JSON.stringify(profiles[name] ?? {});
  profiles[name] = cleanProfile(next);
  // a patch that changes nothing writes nothing: the store keeps its shape and
  // the ledger only ever shows real changes
  if (JSON.stringify(profiles[name]) === before) return profiles[name];
  writeAtomic(path, profiles);
  logProfileWrite(caller, name, Object.keys(patch).join(","));
  return profiles[name];
}

/** The session's persistent name: exported by `pai` at launch; undefined when the session is unnamed. */
export function currentSessionName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[SESSION_NAME_ENV]?.trim() || undefined;
}

/** Re-key one profile (exact key match). False when `from` has no profile or `to` already has one. */
export function renameProfile(from: string, to: string, path: string = profilesPath()): boolean {
  const profiles = readProfiles(path);
  if (!(from in profiles) || to in profiles) return false;
  profiles[to] = profiles[from];
  delete profiles[from];
  writeAtomic(path, profiles);
  void logProfileWrite("rename", to, `from=${from}`);
  return true;
}
