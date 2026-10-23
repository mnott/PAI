/**
 * profile-implicit-pin.ts — one-off repair of the workers pins launches wrote
 * implicitly. Until a setup choice marked its profile pin implicit
 * (setups.ts setupProfile), every `pai`/`pai new` launch wrote the setup's
 * workers provider as a standing session pin, and "Last time" propagated it on
 * every relaunch — so sessions ended up pinned to the chat's provider (usually
 * anthropic) instead of following global routing. The fix stops new writes;
 * this clears the old ones through the profile API (updateProfile), keeping
 * every other part of the profile.
 *
 * A profile written by that path is recognised by shape: a workers pin whose
 * provider is the chat's provider, no model on the workers, no fallback — the
 * "anthropic only" row's setupProfile. Anything else (a worker model, a
 * fallback, a differing provider) is an explicit choice and stays.
 */

import { detectProject } from "../cli/impl/detect.js";
import { readProfiles, updateProfile, type Profiles } from "./session-profile-store.js";

export interface ImplicitPinRepair {
  name: string;
  provider: string;
}

/** True when the profile's workers pin reads as a launch-written one (see the module doc). */
export function looksImplicitLaunchPin(p: { chat?: { provider: string; model?: string }; workers?: { provider: string; model?: string }; workers_implicit?: boolean; fallback?: unknown[] }): boolean {
  const w = p.workers;
  if (!w) return false;
  if (p.workers_implicit === true) return true; // marked by the launch itself
  if (w.model) return false;
  if (p.fallback?.length) return false;
  const c = p.chat;
  if (!c || c.provider !== w.provider) return false;
  return true;
}

/** Profiles whose workers pin reads as launch-written; explicit pins and other shapes are not listed. */
export function implicitPinProfiles(profiles: Profiles): ImplicitPinRepair[] {
  return Object.entries(profiles)
    .filter(([, p]) => looksImplicitLaunchPin(p))
    .map(([name, p]) => ({ name, provider: p.workers!.provider }));
}

/**
 * Clears the workers pin of every profile that reads as launch-written, through
 * updateProfile (keeps chat, fallback, caps, routes). Returns the cleared names.
 */
export function clearImplicitLaunchPins(path?: string): string[] {
  const found = implicitPinProfiles(readProfiles(path));
  for (const { name } of found) updateProfile(name, { workers: null }, path);
  return found.map((r) => r.name);
}

/**
 * The one-off for this repo's named session: only when the cwd's registered
 * project is named `sessionName` (default "PAI") and carries a launch-written
 * workers pin. Reports what it cleared; other sessions are left alone.
 */
export async function repairSessionProfile(cwd: string = process.cwd(), sessionName = "PAI", path?: string): Promise<string[]> {
  const detected = await detectProject(cwd);
  if (!detected || detected.display_name !== sessionName) return [];
  const profiles = readProfiles(path);
  const p = profiles[sessionName];
  if (!p || !looksImplicitLaunchPin(p)) return [];
  updateProfile(sessionName, { workers: null }, path);
  return [sessionName];
}

/** Human lines for `pai session profile repair`: what was cleared, what was left. */
export function repairReport(cleared: string[], profiles: Profiles): string {
  const left = implicitPinProfiles(profiles).filter((r) => !cleared.includes(r.name));
  const lines = [cleared.length ? `cleared the launch-written workers pin: ${cleared.join(", ")}` : "nothing to clear: no launch-written workers pin here"];
  if (left.length) {
    lines.push(`left alone (not this session's): ${left.map((r) => `${r.name} (workers ${r.provider})`).join(", ")}`);
    lines.push(`clear one deliberately: pai session profile clear --workers --name "<name>"`);
  }
  return lines.join("\n");
}
